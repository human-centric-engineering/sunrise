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

// ---------------------------------------------------------------------------
// Runs — cost estimate
// ---------------------------------------------------------------------------

/**
 * Body of `POST /evaluations/runs/estimate`. Heuristic mode runs without
 * a judge list; empirical mode requires the same `(agentId, judgeAgentSlugs,
 * datasetId)` fingerprint that the eventual run will carry, so the
 * caller (the form) sends them all even if the user hasn't selected
 * any judges yet.
 */
export const estimateRunCostSchema = z.object({
  agentId: z.string().min(1),
  datasetId: z.string().min(1),
  judgeAgentSlugs: z.array(z.string().min(1)).default([]),
  caseCount: z.coerce.number().int().nonnegative().optional(),
});

export type EstimateRunCostInput = z.infer<typeof estimateRunCostSchema>;

// ---------------------------------------------------------------------------
// Datasets — trace-to-dataset capture
// ---------------------------------------------------------------------------

const captureEditsSchema = z
  .object({
    input: z.union([z.string().min(1).max(50_000), z.record(z.string(), z.unknown())]).optional(),
    expectedOutput: z.string().max(50_000).optional(),
    referenceCitations: z.array(z.unknown()).optional(),
    metadataPatch: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const captureDatasetCaseSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('conversation_turn'),
      messageId: z.string().min(1),
      edits: captureEditsSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('workflow_execution'),
      executionId: z.string().min(1),
      selector: z
        .object({
          kind: z.enum(['final_report', 'last_step', 'step_id']),
          stepId: z.string().optional(),
        })
        .refine((s) => s.kind !== 'step_id' || (s.stepId && s.stepId.length > 0), {
          message: 'selector.stepId is required when selector.kind="step_id"',
        }),
      edits: captureEditsSchema.optional(),
    })
    .strict(),
]);

export type CaptureDatasetCaseInput = z.infer<typeof captureDatasetCaseSchema>;

// ---------------------------------------------------------------------------
// Datasets — synthetic case generation
// ---------------------------------------------------------------------------

/**
 * Body of `POST /evaluations/datasets/:id/generate-cases`.
 *
 * `mode` picks the seed source:
 *   - `'kb'` — pull representative chunks from the subject agent's
 *     accessible knowledge. Optional `topic` anchors the prompt.
 *   - `'failure_mining'` — pull low-scoring prior cases for the subject
 *     agent and generate "similar but harder" variants.
 *
 * `commit: false` (default) returns proposed cases for preview only —
 * the form shows them to the admin to edit/accept. `commit: true` is
 * the second call: the form sends the *accepted* cases back so the
 * route writes them via `appendCasesToDataset`. Two-step keeps the
 * generator's spend on the preview path and the write transactional
 * on the accept path.
 */
export const generateCasesPreviewSchema = z
  .object({
    agentId: z.string().min(1),
    mode: z.enum(['kb', 'failure_mining']),
    count: z.coerce.number().int().min(1).max(25).default(5),
    topic: z.string().min(1).max(500).optional(),
  })
  .strict();

export const generateCasesCommitSchema = z
  .object({
    cases: z
      .array(
        z
          .object({
            input: z.union([z.string().min(1).max(50_000), z.record(z.string(), z.unknown())]),
            expectedOutput: z.string().max(50_000).optional(),
            metadata: z.record(z.string(), z.unknown()).optional(),
            referenceCitations: z.array(z.unknown()).optional(),
          })
          .strict()
      )
      .min(1)
      .max(25),
  })
  .strict();

export type GenerateCasesPreviewInput = z.infer<typeof generateCasesPreviewSchema>;
export type GenerateCasesCommitInput = z.infer<typeof generateCasesCommitSchema>;
