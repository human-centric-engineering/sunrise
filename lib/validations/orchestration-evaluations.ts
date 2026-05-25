/**
 * Zod schemas for the Phase 1 dataset-driven evaluation endpoints.
 *
 * Kept separate from `orchestration.ts` (already > 3700 lines) for
 * discoverability and to keep dataset/run/grader concerns colocated.
 *
 * Conventions follow the rest of the codebase: list query params share
 * `page` (default 1) and `limit` (default 20, max 100); slugs are
 * `kebab_case` to match grader registry slugs; status filters echo
 * `AiEvaluationRun.status` values.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Datasets — list
// ---------------------------------------------------------------------------

export const listDatasetsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  q: z.string().min(1).max(120).optional(),
  tag: z.string().min(1).max(60).optional(),
});

// ---------------------------------------------------------------------------
// Datasets — create / upload
// ---------------------------------------------------------------------------

/** JSON body (manual / programmatic create, no file). */
export const createDatasetJsonSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  tags: z.array(z.string().min(1).max(60)).max(20).optional(),
  cases: z
    .array(
      z
        .object({
          input: z.union([z.string().min(1), z.record(z.string(), z.unknown())]),
          expectedOutput: z.string().optional(),
          metadata: z.record(z.string(), z.unknown()).optional(),
          referenceCitations: z.array(z.unknown()).optional(),
        })
        .strict()
    )
    .min(1)
    .max(10_000),
});

// ---------------------------------------------------------------------------
// Datasets — patch
// ---------------------------------------------------------------------------

export const patchDatasetSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(2000).nullable().optional(),
    tags: z.array(z.string().min(1).max(60)).max(20).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });

// ---------------------------------------------------------------------------
// Datasets — cases pagination
// ---------------------------------------------------------------------------

export const listDatasetCasesQuerySchema = z.object({
  cursor: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

// ---------------------------------------------------------------------------
// Runs — list
// ---------------------------------------------------------------------------

export const listRunsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']).optional(),
  subjectKind: z.enum(['agent', 'workflow']).optional(),
  datasetId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
});

// ---------------------------------------------------------------------------
// Runs — create / queue
// ---------------------------------------------------------------------------

export const createRunSchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
    subjectKind: z.enum(['agent', 'workflow']),
    agentId: z.string().min(1).optional(),
    workflowId: z.string().min(1).optional(),
    datasetId: z.string().min(1),
    metricConfigs: z
      .array(
        z.object({
          slug: z.string().min(1),
          config: z.unknown().optional(),
        })
      )
      .min(1, 'At least one metric is required'),
    judgeProvider: z.string().min(1).optional(),
    judgeModel: z.string().min(1).optional(),
    subjectOutputSelector: z
      .object({
        kind: z.enum(['final_report', 'last_step', 'step_id']),
        stepId: z.string().optional(),
      })
      .optional(),
  })
  .refine(
    (v) =>
      (v.subjectKind === 'agent' && !!v.agentId && !v.workflowId) ||
      (v.subjectKind === 'workflow' && !!v.workflowId && !v.agentId),
    { message: 'Provide exactly one of agentId / workflowId, matching subjectKind' }
  )
  .refine((v) => (v.judgeProvider ? !!v.judgeModel : !v.judgeModel), {
    message: 'judgeProvider and judgeModel must be provided together or omitted together',
  });

// ---------------------------------------------------------------------------
// Runs — case results pagination
// ---------------------------------------------------------------------------

export const listRunCasesQuerySchema = z.object({
  cursor: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

export type ListDatasetsQuery = z.infer<typeof listDatasetsQuerySchema>;
export type CreateDatasetJsonInput = z.infer<typeof createDatasetJsonSchema>;
export type PatchDatasetInput = z.infer<typeof patchDatasetSchema>;
export type ListDatasetCasesQuery = z.infer<typeof listDatasetCasesQuerySchema>;
export type ListRunsQuery = z.infer<typeof listRunsQuerySchema>;
export type CreateRunInput = z.infer<typeof createRunSchema>;
export type ListRunCasesQuery = z.infer<typeof listRunCasesQuerySchema>;
