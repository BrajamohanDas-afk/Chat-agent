import { z } from 'zod';

/** JSON Schema object sent to OpenRouter for structured outputs. */
export type JsonSchema = Record<string, unknown>;

/**
 * Convert a zod schema to the JSON Schema subset OpenRouter/OpenAI structured
 * outputs accept. zod 4 ships the converter, so no extra package is needed.
 * `$schema` is stripped because some OpenRouter providers reject it.
 */
export function zodToJsonSchema(schema: z.ZodType): JsonSchema {
  const { $schema: _schema, ...json } = z.toJSONSchema(schema, {
    target: 'draft-7',
    io: 'output',
  }) as JsonSchema & { $schema?: string };
  return json;
}
