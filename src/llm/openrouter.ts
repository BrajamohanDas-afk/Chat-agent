import OpenAI from 'openai';
import { z } from 'zod';
import { zodToJsonSchema } from './schemas.js';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 20_000;

export type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type ChatOptions<T> = {
  model: string;
  messages: ChatMessage[];
  schema: z.ZodType<T>;
  schemaName: string;
  maxTokens?: number;
  /** OpenRouter extension: analysis calls do not need reasoning tokens. */
  reasoning?: { enabled?: boolean; effort?: 'low' | 'medium' | 'high' };
  temperature?: number;
  signal?: AbortSignal;
};

export type ChatJsonResult<T> = { data: T; usage: TokenUsage };

export type StreamOptions = {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  signal?: AbortSignal;
  onUsage?: (usage: TokenUsage) => void;
};

export type ToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type ChatToolsResult = {
  content: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
};

export type ChatToolsOptions = {
  model: string;
  messages: ChatMessage[];
  tools: OpenAI.Chat.ChatCompletionTool[];
  toolChoice?: 'auto' | 'none';
  maxTokens?: number;
  signal?: AbortSignal;
};

export type ProviderErrorDetails = {
  status?: number | null;
  body?: string | null;
  model: string;
  cause?: unknown;
};

class ResponseContractError extends Error {
  readonly kind: 'json' | 'schema';
  readonly body: string;

  constructor(kind: 'json' | 'schema', message: string, body: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ResponseContractError';
    this.kind = kind;
    this.body = body;
  }
}

export class ProviderError extends Error {
  readonly status: number | null;
  readonly body: string | null;
  readonly model: string;

  constructor(message: string, details: ProviderErrorDetails) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'ProviderError';
    this.status = details.status ?? null;
    this.body = details.body ?? null;
    this.model = details.model;
  }
}

export type OpenRouterDeps = {
  /** Injected for tests; defaults to the real SDK client. */
  client?: OpenAI;
  /** Injected for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
};

type UsageLike = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
} | null | undefined;

function toUsage(usage: UsageLike): TokenUsage {
  return {
    promptTokens: usage?.prompt_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
    totalTokens: usage?.total_tokens ?? 0,
  };
}

function withTimeout(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

function bodyOf(error: unknown): string | null {
  if (error instanceof OpenAI.APIError) {
    const detail =
      typeof error.error === 'object' && error.error !== null
        ? JSON.stringify(error.error)
        : error.message;
    return detail.slice(0, 500);
  }
  return error instanceof Error ? error.message.slice(0, 500) : null;
}

function isRetryable(error: unknown, callerSignal: AbortSignal | undefined): boolean {
  if (callerSignal?.aborted) return false;
  if (error instanceof OpenAI.APIUserAbortError) return false;
  // APIConnectionError covers network failures and APIConnectionTimeoutError.
  if (error instanceof OpenAI.APIConnectionError) return true;
  if (error instanceof OpenAI.APIError) {
    const status = error.status;
    return status === 429 || (typeof status === 'number' && status >= 500);
  }
  return error instanceof Error && error.name === 'TimeoutError';
}

function toProviderError(error: unknown, model: string): ProviderError {
  if (error instanceof ProviderError) return error;
  const status = error instanceof OpenAI.APIError ? error.status ?? null : null;
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError(`OpenRouter transport failure for model ${model}: ${message}`, {
    status,
    body: bodyOf(error),
    model,
    cause: error,
  });
}

function contractError(error: ResponseContractError, model: string): ProviderError {
  const kind = error.kind === 'json' ? 'invalid JSON' : 'schema validation failure';
  return new ProviderError(`OpenRouter ${kind} for model ${model}: ${error.message}`, {
    status: 200,
    body: error.body.slice(0, 500),
    model,
    cause: error.cause,
  });
}

let sdkClient: OpenAI | undefined;

function defaultClient(): OpenAI {
  sdkClient ??= new OpenAI({
    baseURL: OPENROUTER_BASE_URL,
    apiKey: process.env.OPENROUTER_API_KEY,
  });
  return sdkClient;
}

export function createOpenRouter(deps: OpenRouterDeps = {}) {
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function chatJson<T>(options: ChatOptions<T>): Promise<ChatJsonResult<T>> {
    const client = deps.client ?? defaultClient();

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (options.signal?.aborted) {
        throw new ProviderError('OpenRouter request aborted by caller', {
          model: options.model,
          cause: options.signal.reason,
        });
      }

      try {
        const body: Record<string, unknown> = {
          model: options.model,
          messages: options.messages,
          max_tokens: options.maxTokens ?? 1200,
          temperature: options.temperature ?? 0,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: options.schemaName,
              strict: true,
              schema: zodToJsonSchema(options.schema),
            },
          },
        };
        if (options.reasoning) body.reasoning = options.reasoning;

        const completion = await client.chat.completions.create(body as never, {
          signal: withTimeout(options.signal),
        });

        const raw = completion.choices[0]?.message?.content;
        if (!raw) {
          throw new ResponseContractError('json', 'OpenRouter returned an empty response', '');
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (error) {
          throw new ResponseContractError(
            'json',
            'OpenRouter returned invalid JSON',
            raw,
            error,
          );
        }

        let data: T;
        try {
          data = options.schema.parse(parsed);
        } catch (error) {
          throw new ResponseContractError(
            'schema',
            'OpenRouter response failed schema validation',
            raw,
            error,
          );
        }

        return { data, usage: toUsage(completion.usage) };
      } catch (error) {
        const contract = error instanceof ResponseContractError ? error : null;
        const retryable = contract !== null || isRetryable(error, options.signal);
        if (attempt === MAX_ATTEMPTS - 1 || !retryable) {
          throw contract !== null
            ? contractError(contract, options.model)
            : toProviderError(error, options.model);
        }
        await sleep(200 * 2 ** attempt + Math.random() * 100);
      }
    }

    throw new ProviderError('OpenRouter request failed after retries', { model: options.model });
  }

  async function chatTools(options: ChatToolsOptions): Promise<ChatToolsResult> {
    const client = deps.client ?? defaultClient();

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (options.signal?.aborted) {
        throw new ProviderError('OpenRouter request aborted by caller', {
          model: options.model,
          cause: options.signal.reason,
        });
      }

      try {
        const completion = await client.chat.completions.create(
          {
            model: options.model,
            messages: options.messages,
            max_tokens: options.maxTokens ?? 1200,
            tools: options.tools,
            tool_choice: options.toolChoice ?? 'auto',
          },
          { signal: withTimeout(options.signal) },
        );

        const message = completion.choices[0]?.message;
        const toolCalls: ToolCall[] = [];
        for (const call of message?.tool_calls ?? []) {
          if (call.type !== 'function') continue;
          if (!call.id || !call.function?.name) continue;
          toolCalls.push({
            id: call.id,
            name: call.function.name,
            arguments: call.function.arguments ?? '',
          });
        }

        return {
          content: message?.content ?? '',
          toolCalls,
          usage: toUsage(completion.usage),
        };
      } catch (error) {
        if (attempt === MAX_ATTEMPTS - 1 || !isRetryable(error, options.signal)) {
          throw toProviderError(error, options.model);
        }
        await sleep(200 * 2 ** attempt + Math.random() * 100);
      }
    }

    throw new ProviderError('OpenRouter request failed after retries', { model: options.model });
  }

  async function* chatStream(options: StreamOptions): AsyncGenerator<string, void, void> {
    const client = deps.client ?? defaultClient();
    try {
      const stream = await client.chat.completions.create(
        {
          model: options.model,
          messages: options.messages,
          max_tokens: options.maxTokens ?? 1200,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: withTimeout(options.signal) },
      );

      let usage: TokenUsage | null = null;
      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content;
        if (text) yield text;
        if (chunk.usage) usage = toUsage(chunk.usage);
      }
      if (usage !== null) options.onUsage?.(usage);
    } catch (error) {
      throw toProviderError(error, options.model);
    }
  }

  return { chatJson, chatTools, chatStream };
}

const defaultOpenRouter = createOpenRouter();

export const chatJson = defaultOpenRouter.chatJson;
export const chatTools = defaultOpenRouter.chatTools;
export const chatStream = defaultOpenRouter.chatStream;
