import { z } from 'zod';

export const AnalysisSchema = z.strictObject({
  intent: z.enum(['fresh', 'recall', 'recheck', 'chat']),
  entities: z.array(
    z.strictObject({
      name: z.string().min(1),
      domain: z.string().nullable(),
      aliases: z.array(z.string()),
    }),
  ),
  date_expressions: z.array(z.string()),
  decisions: z.array(
    z.strictObject({
      topic: z.string(),
      type: z.enum(['shortlist', 'selection', 'rejection', 'preference']),
      entities: z.array(z.string()),
    }),
  ),
  attributes: z.array(
    z.strictObject({
      entity: z.string(),
      attribute: z.string(),
      volatility: z.enum(['price', 'feature', 'stable']),
    }),
  ),
  search_plan: z.array(
    z.strictObject({
      query: z.string().min(1),
      entity: z.string().nullable(),
      recency_days: z.number().nullable(),
      domains: z.array(z.string()),
    }),
  ),
  needs_search: z.boolean(),
  comparison_targets: z.array(z.string()),
});

export const ExtractionSchema = z.strictObject({
  observations: z.array(
    z.strictObject({
      entity: z.string().min(1),
      attribute: z.string().min(1),
      kind: z.enum(['price', 'feature', 'limit', 'status']),
      value: z.union([z.number(), z.string(), z.boolean()]),
      plan: z.string().nullable(),
      currency: z.string().nullable(),
      period: z.enum(['month', 'year', 'one_time']).nullable(),
      mode: z.enum(['flat', 'per_user', 'per_workspace']).nullable(),
      unit: z.string().nullable(),
      region: z.string().nullable(),
      conditions: z.array(z.string()),
      observed_at: z.string(),
      published_at: z.string().nullable(),
      effective_from: z.string().nullable(),
      evidence_id: z.string(),
      confidence: z.enum(['high', 'medium', 'low']),
    }),
  ),
});

export const ValidationSchema = z.strictObject({
  verdicts: z.array(
    z.strictObject({
      index: z.number().int().nonnegative(),
      status: z.enum(['supported', 'partial', 'unsupported']),
      reason: z.string(),
    }),
  ),
});

export const JudgeSchema = z.strictObject({
  answers_question: z.number().min(1).max(5),
  concise: z.number().min(1).max(5),
  honest: z.number().min(1).max(5),
  note: z.string(),
});

export type AnalysisJson = z.infer<typeof AnalysisSchema>;
export type ExtractionJson = z.infer<typeof ExtractionSchema>;
export type ValidationJson = z.infer<typeof ValidationSchema>;
export type JudgeJson = z.infer<typeof JudgeSchema>;
