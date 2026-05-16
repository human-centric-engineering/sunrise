/**
 * Workflow-step provenance contract.
 *
 * Workflow LLM/agent steps that produce claims (a model misclassification
 * proposal, a regulatory advisory, an extracted quote) can carry a
 * `sources` array on their JSON output describing where each claim came
 * from. The engine lifts that array onto `ExecutionTraceEntry.provenance`
 * (see {@link types/orchestration.ts}) so the trace viewer and structured
 * approval UI can render it as a typed surface — pills with hover-out
 * detail — instead of leaving the audit trail buried in free-text
 * `reason` strings the admin has to read line by line.
 *
 * The contract is opt-in. Workflows that don't emit `output.sources` get
 * `trace.provenance === undefined`; nothing fails. Workflows that want
 * enforcement paste {@link provenanceRequiredRule} into a `guard` step's
 * rules prompt — the guard step's existing LLM-mode validation rejects
 * un-attributed claims and uses the standard retry budget.
 *
 * Deliberately distinct from chat citations (`types/orchestration.ts`
 * `Citation`, `lib/orchestration/chat/citations.ts`). Chat citations are
 * a per-turn envelope with monotonic `[N]` markers that the LLM uses
 * inline; provenance is a per-claim record attached to structured step
 * output. Both can coexist on the same workflow execution.
 */

import { z } from 'zod';

/**
 * Where the source originated. Closed set, deliberately small — adding a
 * new kind is a breaking change for downstream consumers (UI pill
 * styling, guard rules) and should be a considered API decision.
 *
 * - `training_knowledge`: the LLM produced the claim from its own
 *   parametric knowledge. Forces a `confidence` downgrade in the guard
 *   rule because there is no external evidence to verify against.
 * - `web_search`: claim is supported by a web search result that was
 *   surfaced to the LLM in the prompt. `reference` is the URL.
 * - `knowledge_base`: claim is grounded in a chunk surfaced from the
 *   admin's knowledge base. `reference` is the chunk id; `snippet` is the
 *   chunk content excerpt.
 * - `prior_step`: claim is derived from another workflow step's output.
 *   `stepId` is the upstream step id; `reference` is a dotted path into
 *   that step's output (e.g. `output.models[0].providerSlug`).
 * - `external_call`: claim is supported by an HTTP response from an
 *   `external_call` step. `stepId` points at the call; `reference` is
 *   the URL it hit.
 * - `user_input`: claim originated in the workflow's `inputData`
 *   (e.g. an admin selected a model when triggering the run).
 */
export const provenanceSourceSchema = z.enum([
  'training_knowledge',
  'web_search',
  'knowledge_base',
  'prior_step',
  'external_call',
  'user_input',
]);

export type ProvenanceSource = z.infer<typeof provenanceSourceSchema>;

/** Caps. Kept tight so a trace entry with a long claim list doesn't blow the JSON column. */
const REFERENCE_MAX = 1024;
const SNIPPET_MAX = 400;
const NOTE_MAX = 400;
const STEP_ID_MAX = 64;

/**
 * One source attached to a claim. `confidence` here is the source's
 * weight — the producing LLM step is free to downgrade an overall
 * `change.confidence` based on the minimum across its sources.
 */
export const provenanceItemSchema = z.object({
  source: provenanceSourceSchema,
  confidence: z.enum(['high', 'medium', 'low']),
  reference: z.string().min(1).max(REFERENCE_MAX).optional(),
  snippet: z.string().min(1).max(SNIPPET_MAX).optional(),
  stepId: z.string().min(1).max(STEP_ID_MAX).optional(),
  note: z.string().min(1).max(NOTE_MAX).optional(),
});

export type ProvenanceItem = z.infer<typeof provenanceItemSchema>;

/** Per-step provenance is always an array; permit empty arrays at the schema level so producer
 *  steps can emit `sources: []` deliberately (no claim made) without the engine rejecting the
 *  shape. Guard rules enforce non-empty when a workflow chooses to require attribution. */
export const provenanceItemArraySchema = z.array(provenanceItemSchema).max(64);

export type ProvenanceItemArray = z.infer<typeof provenanceItemArraySchema>;

/**
 * Defensive extractor used by the engine. Looks for `output.sources` on
 * an arbitrary step output; if present and shape-valid, returns the
 * normalised array. Otherwise returns `undefined` so the engine omits the
 * `provenance` field entirely (rather than persisting an empty array,
 * which would be ambiguous between "no provenance emitted" and "an empty
 * provenance array was emitted on purpose").
 *
 * Failure modes — all return `undefined`:
 *
 *   1. Output isn't an object (or is null).
 *   2. `output.sources` is missing.
 *   3. `output.sources` is present but doesn't validate against
 *      {@link provenanceItemArraySchema}.
 *
 * Case 3 is the interesting one: a buggy LLM step could emit a
 * malformed `sources` field. Silently dropping it keeps the workflow
 * running (provenance is not a load-bearing primitive for the engine);
 * downstream UI sees `undefined` and falls back gracefully.
 */
export function extractProvenance(output: unknown): ProvenanceItem[] | undefined {
  if (output === null || typeof output !== 'object') return undefined;
  const candidate = (output as Record<string, unknown>).sources;
  if (candidate === undefined || candidate === null) return undefined;
  const parsed = provenanceItemArraySchema.safeParse(candidate);
  if (!parsed.success) return undefined;
  if (parsed.data.length === 0) return undefined;
  return parsed.data;
}
