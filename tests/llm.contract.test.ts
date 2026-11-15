import { describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import { z } from 'zod';
import type { EmbedContentParameters, GoogleGenAI } from '@google/genai';
import {
  createOpenRouter,
  ProviderError,
  type TokenUsage,
} from '../src/llm/openrouter.js';
import { zodToJsonSchema } from '../src/llm/schemas.js';
import { embed, EmbeddingError } from '../src/llm/embeddings.js';
import { config } from '../src/config.js';

const ContactSchema = z.strictObject({
  ok: z.boolean(),
  note: z.string(),
});

function completion(
  content: string,
  usage = { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
): OpenAI.Chat.ChatCompletion {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 0,
    model: 'test/model',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        logprobs: null,
        message: { role: 'assistant', content, refusal: null },
      },
    ],
    usage,
  };
}

function clientWith(create: unknown): OpenAI {
  return { chat: { completions: { create } } } as unknown as OpenAI;
}

function sequenceClient(responses: Array<OpenAI.Chat.ChatCompletion | Error>): {
  client: OpenAI;
  calls: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming[];
} {
  const calls: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming[] = [];
  const create = async (body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming) => {
    calls.push(body);
    const next = responses.shift();
    if (next === undefined) throw new Error('no fake response left');
    if (next instanceof Error) throw next;
    return next;
  };
  return { client: clientWith(create), calls };
}

const options = {
  model: 'test/model',
  messages: [{ role: 'user' as const, content: 'hi' }],
  schema: ContactSchema,
  schemaName: 'contact',
};

const searchTool: OpenAI.Chat.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the web',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
};

function toolCompletion(
  toolCalls: OpenAI.Chat.ChatCompletionMessageFunctionToolCall[],
  content: string | null = null,
): OpenAI.Chat.ChatCompletion {
  return {
    id: 'chatcmpl-tools',
    object: 'chat.completion',
    created: 0,
    model: 'test/model',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        logprobs: null,
        message: { role: 'assistant', content, refusal: null, tool_calls: toolCalls },
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
  };
}

describe('zodToJsonSchema', () => {
  it('emits a strict draft-7 object without $schema', () => {
    const json = zodToJsonSchema(ContactSchema);
    const properties = json.properties as Record<string, unknown>;

    expect(json.$schema).toBeUndefined();
    expect(json.type).toBe('object');
    expect(json.additionalProperties).toBe(false);
    expect(json.required).toEqual(['ok', 'note']);
    expect(properties.ok).toEqual({ type: 'boolean' });
  });

  it('rejects data that violates the zod contract', () => {
    expect(() => ContactSchema.parse({ ok: 'yes', note: 'x' })).toThrow();
  });
});

describe('chatJson', () => {
  it('sends a strict json_schema and parses the response', async () => {
    const { client, calls } = sequenceClient([completion('{"ok":true,"note":"fine"}')]);
    const openrouter = createOpenRouter({ client, sleep: async () => {} });

    const result = await openrouter.chatJson({ ...options, maxTokens: 64 });

    expect(result.data).toEqual({ ok: true, note: 'fine' });
    expect(result.usage).toEqual({ promptTokens: 3, completionTokens: 4, totalTokens: 7 });
    expect(calls[0]?.max_tokens).toBe(64);
    expect(calls[0]?.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'contact', strict: true },
    });
  });

  it('retries a 429 and succeeds', async () => {
    const rateLimited = new OpenAI.APIError(
      429,
      { error: { message: 'slow down' } },
      'rate limited',
      new Headers(),
    );
    const { client, calls } = sequenceClient([
      rateLimited,
      completion('{"ok":true,"note":"second try"}'),
    ]);
    const openrouter = createOpenRouter({ client, sleep: async () => {} });

    const result = await openrouter.chatJson(options);

    expect(result.data).toEqual({ ok: true, note: 'second try' });
    expect(calls).toHaveLength(2);
  });

  it('retries timeouts', async () => {
    const timeout = new OpenAI.APIConnectionTimeoutError({ message: 'timed out' });
    const { client, calls } = sequenceClient([
      timeout,
      completion('{"ok":false,"note":"after timeout"}'),
    ]);
    const openrouter = createOpenRouter({ client, sleep: async () => {} });

    const result = await openrouter.chatJson(options);

    expect(result.data.ok).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('throws ProviderError with status, body and model after 5xx retries', async () => {
    const unavailable = new OpenAI.APIError(
      503,
      { error: { message: 'upstream down' } },
      'unavailable',
      new Headers(),
    );
    const { client, calls } = sequenceClient([unavailable, unavailable, unavailable]);
    const openrouter = createOpenRouter({ client, sleep: async () => {} });

    const error: unknown = await openrouter.chatJson(options).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      status: 503,
      model: 'test/model',
    });
    expect((error as ProviderError).body).toContain('upstream down');
    expect((error as ProviderError).message).toContain('transport failure');
    expect((error as ProviderError).message).toContain('test/model');
    expect(calls).toHaveLength(3);
  });

  it('does not retry a 400', async () => {
    const badRequest = new OpenAI.APIError(
      400,
      { error: { message: 'bad request' } },
      'bad request',
      new Headers(),
    );
    const { client, calls } = sequenceClient([badRequest]);
    const openrouter = createOpenRouter({ client, sleep: async () => {} });

    await expect(openrouter.chatJson(options)).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toHaveLength(1);
  });

  it('retries invalid JSON and succeeds on the second call', async () => {
    const { client, calls } = sequenceClient([
      completion('this is not json'),
      completion('{"ok":true,"note":"recovered"}'),
    ]);
    const openrouter = createOpenRouter({ client, sleep: async () => {} });

    const result = await openrouter.chatJson(options);

    expect(result.data).toEqual({ ok: true, note: 'recovered' });
    expect(calls).toHaveLength(2);
  });

  it('retries a schema violation and succeeds on the second call', async () => {
    const { client, calls } = sequenceClient([
      completion('{"ok":"not-a-boolean","note":"wrong"}'),
      completion('{"ok":true,"note":"fixed"}'),
    ]);
    const openrouter = createOpenRouter({ client, sleep: async () => {} });

    const result = await openrouter.chatJson(options);

    expect(result.data).toEqual({ ok: true, note: 'fixed' });
    expect(calls).toHaveLength(2);
  });

  it('wraps a schema violation in ProviderError after retries', async () => {
    const invalid = () => completion('{"ok":"not-a-boolean"}');
    const { client, calls } = sequenceClient([invalid(), invalid(), invalid()]);
    const openrouter = createOpenRouter({ client, sleep: async () => {} });

    const error: unknown = await openrouter.chatJson(options).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toContain('schema');
    expect((error as ProviderError).message).toContain('test/model');
    expect(calls).toHaveLength(3);
  });

  it('wraps invalid JSON in ProviderError after retries', async () => {
    const invalid = () => completion('not json');
    const { client, calls } = sequenceClient([invalid(), invalid(), invalid()]);
    const openrouter = createOpenRouter({ client, sleep: async () => {} });

    const error: unknown = await openrouter.chatJson(options).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toContain('invalid JSON');
    expect((error as ProviderError).message).toContain('test/model');
    expect(calls).toHaveLength(3);
  });
});

describe('chatStream', () => {
  it('yields text deltas and records usage', async () => {
    const chunks: OpenAI.Chat.ChatCompletionChunk[] = [
      {
        id: 'chunk-1',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'test/model',
        choices: [{ index: 0, delta: { content: 'Hel' }, finish_reason: null, logprobs: null }],
      },
      {
        id: 'chunk-2',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'test/model',
        choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: null, logprobs: null }],
      },
      {
        id: 'chunk-3',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'test/model',
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      },
    ];

    async function* generate(): AsyncGenerator<OpenAI.Chat.ChatCompletionChunk> {
      for (const chunk of chunks) yield chunk;
    }

    const client = clientWith(async () => generate());
    const openrouter = createOpenRouter({ client, sleep: async () => {} });
    let usage: TokenUsage | undefined;
    const text: string[] = [];

    for await (const delta of openrouter.chatStream({
      model: 'test/model',
      messages: options.messages,
      onUsage: (value) => {
        usage = value;
      },
    })) {
      text.push(delta);
    }

    expect(text.join('')).toBe('Hello');
    expect(usage).toEqual({ promptTokens: 1, completionTokens: 2, totalTokens: 3 });
  });
});

describe('chatTools', () => {
  const toolCall: OpenAI.Chat.ChatCompletionMessageFunctionToolCall = {
    id: 'call_1',
    type: 'function',
    function: { name: 'web_search', arguments: '{"query":"hubspot pricing"}' },
  };

  it('parses a tool call, returns empty content and records usage', async () => {
    const { client, calls } = sequenceClient([toolCompletion([toolCall])]);
    const openrouter = createOpenRouter({ client, sleep: async () => {} });

    const result = await openrouter.chatTools({
      model: 'test/model',
      messages: options.messages,
      tools: [searchTool],
    });

    expect(result).toEqual({
      content: '',
      toolCalls: [
        { id: 'call_1', name: 'web_search', arguments: '{"query":"hubspot pricing"}' },
      ],
      usage: { promptTokens: 5, completionTokens: 6, totalTokens: 11 },
    });
    expect(calls[0]?.tools).toEqual([searchTool]);
    expect(calls[0]?.response_format).toBeUndefined();
    expect(calls[0]?.stream).toBeUndefined();
  });

  it('returns plain content with no tool calls', async () => {
    const { client } = sequenceClient([completion('Plain answer.')]);
    const openrouter = createOpenRouter({ client, sleep: async () => {} });

    const result = await openrouter.chatTools({
      model: 'test/model',
      messages: options.messages,
      tools: [searchTool],
    });

    expect(result.content).toBe('Plain answer.');
    expect(result.toolCalls).toEqual([]);
  });

  it('ignores tool calls without an id or function name', async () => {
    const emptyId = { ...toolCall, id: '' };
    const emptyName = { ...toolCall, id: 'call_2', function: { name: '', arguments: '{}' } };
    const { client } = sequenceClient([toolCompletion([emptyId, emptyName, toolCall])]);
    const openrouter = createOpenRouter({ client, sleep: async () => {} });

    const result = await openrouter.chatTools({
      model: 'test/model',
      messages: options.messages,
      tools: [searchTool],
    });

    expect(result.toolCalls).toEqual([
      { id: 'call_1', name: 'web_search', arguments: '{"query":"hubspot pricing"}' },
    ]);
  });

  it('retries a transient 500 then succeeds', async () => {
    const unavailable = new OpenAI.APIError(
      500,
      { error: { message: 'transient' } },
      'server error',
      new Headers(),
    );
    const { client, calls } = sequenceClient([unavailable, toolCompletion([toolCall])]);
    const openrouter = createOpenRouter({ client, sleep: async () => {} });

    const result = await openrouter.chatTools({
      model: 'test/model',
      messages: options.messages,
      tools: [searchTool],
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });
});

describe('embeddings', () => {
  it('requests 1536 dimensions and returns Float32Arrays', async () => {
    const requests: EmbedContentParameters[] = [];
    const ai = {
      models: {
        embedContent: async (input: EmbedContentParameters) => {
          requests.push(input);
          return { embeddings: [{ values: [0.5, 0.25] }] };
        },
      },
    } as unknown as GoogleGenAI;

    const vectors = await embed(['hello'], { ai, sleep: async () => {} });

    expect(vectors[0]).toBeInstanceOf(Float32Array);
    expect(Array.from(vectors[0]!)).toEqual([0.5, 0.25]);
    expect(requests[0]?.config?.outputDimensionality).toBe(1536);
  });

  it('requests one embedding per text', async () => {
    const requests: EmbedContentParameters[] = [];
    const ai = {
      models: {
        embedContent: async (input: EmbedContentParameters) => {
          requests.push(input);
          return { embeddings: [{ values: [requests.length] }] };
        },
      },
    } as unknown as GoogleGenAI;

    const vectors = await embed(['a', 'b'], { ai, sleep: async () => {} });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.contents).toEqual(['a']);
    expect(requests[1]?.contents).toEqual(['b']);
    expect(vectors).toHaveLength(2);
  });

  it('does not retry a permanent 400 and reports status and model', async () => {
    let calls = 0;
    const ai = {
      models: {
        embedContent: async () => {
          calls += 1;
          throw Object.assign(new Error('API key not valid'), { status: 400 });
        },
      },
    } as unknown as GoogleGenAI;

    const error: unknown = await embed(['hello'], { ai, sleep: async () => {} }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(EmbeddingError);
    expect(error).toMatchObject({ status: 400, model: config.embedding.model });
    expect(calls).toBe(1);
  });

  it('retries a 503 before giving up', async () => {
    let calls = 0;
    const ai = {
      models: {
        embedContent: async () => {
          calls += 1;
          throw Object.assign(new Error('backend unavailable'), {
            status: 503,
            response: { status: 503 },
          });
        },
      },
    } as unknown as GoogleGenAI;

    const error: unknown = await embed(['hello'], { ai, sleep: async () => {} }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(EmbeddingError);
    expect((error as EmbeddingError).status).toBe(503);
    expect(calls).toBe(3);
  });
});
