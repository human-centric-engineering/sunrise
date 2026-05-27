/**
 * Workflow cost estimator (generic)
 *
 * Predicts the USD cost of running a workflow *before* it's triggered,
 * so trigger UIs can show a number near the action button. Any
 * workflow can use this service — the heuristic auto-derives from the
 * published workflow definition by counting LLM-producing steps, and
 * the empirical path uses past completed runs of the same workflow.
 *
 * Two modes, chosen by data availability:
 *
 *   - **empirical** — when ≥3 past completed runs match the supervisor
 *     toggle, we calibrate a token-shape ratio between the past actuals
 *     and the heuristic baseline, then reprice under the *current*
 *     chat-default + judge-model rates. Past runs on Sonnet still
 *     inform a future run on Haiku — token usage shape is reused,
 *     dollar amounts are not.
 *
 *   - **heuristic** — when fewer matching past runs exist, fall back to
 *     a workflow-aware shape: count the LLM-producing steps in the
 *     published definition, multiply by per-step token assumptions,
 *     and add a supervisor add-on when applicable. Range is widened
 *     (±50%) to signal the uncertainty.
 *
 * Supervisor cost is isolated by step *type* (any step with
 * `type === 'supervisor'`) so the estimator works for workflows whose
 * supervisor step id differs from the audit's `supervisor_review`.
 *
 * **Optional `itemCount`** — workflows whose cost scales with an input
 * dimension (e.g. the audit's selected-model count, a "process N
 * documents" pipeline) can pass `itemCount` to bump the heuristic and
 * surface that scaling in the estimate. Workflows without a scaling
 * input simply omit it.
 *
 * Past runs are capped at 100 most recent — workflows aren't hot enough
 * to need more; older runs would drag the estimate toward stale prompt
 * shapes anyway.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { getModel, refreshFromOpenRouter } from '@/lib/orchestration/llm/model-registry';
import { hydrateFromDb as hydrateModelRegistryFromDb } from '@/lib/orchestration/llm/model-registry-db-hydrate';
import { getDefaultModelForTaskOrNull } from '@/lib/orchestration/llm/settings-resolver';
import { JUDGE_MODEL } from '@/lib/orchestration/evaluations/judge-model';
import { workflowDefinitionSchema } from '@/lib/validations/orchestration';
import type { WorkflowDefinition } from '@/types/orchestration';

/**
 * Step types that incur per-step LLM token cost. Supervisor is tracked
 * separately because it runs against the (potentially different) judge
 * model. Non-LLM step types (tool_call, external_call, parallel,
 * send_notification, human_approval, rag_retrieve, report, chain) are
 * excluded — they have no LLM bill.
 */
const LLM_STEP_TYPES: ReadonlySet<string> = new Set([
  'llm_call',
  'agent_call',
  'evaluate',
  'guard',
  'reflect',
  'route',
  'plan',
  'orchestrator',
]);

const SUPERVISOR_STEP_TYPE = 'supervisor';

/**
 * Some step types internally loop or chain multiple LLM calls; the
 * heuristic counts them as N equivalents. Values are calibrated against
 * the audit workflow's actual trace and refined as new workflows hit
 * the empirical floor.
 */
const STEP_LLM_MULTIPLIERS: Record<string, number> = {
  agent_call: 3, // ~3 tool iterations average; capped at maxToolIterations
  reflect: 2, // draft + critique; iterates up to maxIterations
};

/**
 * Per-LLM-step heuristic token assumptions. The base values are calibrated
 * to mid-sized chat-completion prompts; the per-item bumps cover the
 * common case where a workflow's input list grows the prompts linearly.
 *
 * Verified against the provider-model-audit trace (13 LLM-producing
 * steps × ~3k input, ~1k output per step, + 800 per-model overhead in
 * the analyse / validate / refine / compile steps) — the workflow-shape
 * prediction matches the audit-specific constants the prior implementation
 * used.
 */
const HEURISTIC = {
  INPUT_TOKENS_PER_LLM_STEP: 3_000,
  OUTPUT_TOKENS_PER_LLM_STEP: 1_000,
  PER_ITEM_INPUT_TOKENS: 800,
  PER_ITEM_OUTPUT_TOKENS: 300,
  SUPERVISOR_INPUT_TOKENS: 18_000,
  SUPERVISOR_OUTPUT_TOKENS: 2_500,
} as const;

/**
 * Last-resort model id when neither `defaultModels.chat` nor the
 * registry has a usable entry. Used only to keep the dollar number from
 * collapsing to $0 in cold-start deployments.
 */
const FALLBACK_MODEL_ID = 'claude-sonnet-4-6';

/** Minimum matching past runs needed before we trust the empirical path. */
const EMPIRICAL_MIN_SAMPLES = 3;

/** Range bounds for the empirical estimate, expressed as fraction of mid. */
const EMPIRICAL_RANGE_MIN = 0.2;
const EMPIRICAL_RANGE_MAX = 0.6;

/** Pure-heuristic mode is rough; show a wide range. */
const HEURISTIC_LOW_MULT = 0.5;
const HEURISTIC_HIGH_MULT = 2.0;

export interface WorkflowCostEstimateModel {
  modelId: string;
  /** 'work' = non-supervisor LLM steps; 'supervisor' = supervisor step. */
  role: 'work' | 'supervisor';
  /** Tokens attributed to this model (after empirical calibration if applicable). */
  inputTokens: number;
  outputTokens: number;
  /** USD cost contribution at the current model rates. */
  costUsd: number;
  /**
   * Whether the registry has pricing data for `modelId`. False when
   * `getModel(modelId)` returns undefined — typically a model id that
   * isn't in the static fallback, isn't in the OpenRouter catalogue,
   * and has no matrix row supplying `costPerMillionTokens`. The cost
   * contribution is $0 in that case; the UI should surface it as
   * "pricing unknown" so the operator knows the overall estimate is
   * missing a slice rather than reading $0 as "free".
   */
  pricingKnown: boolean;
}

/**
 * Per-step dollar contribution. Lets the workflow builder tint
 * individual nodes when one step alone is projected to consume a
 * meaningful slice of the per-execution cap. Empty when the workflow
 * has no LLM-producing steps at all.
 */
export interface WorkflowCostEstimateStep {
  stepId: string;
  modelId: string;
  role: 'work' | 'supervisor';
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  pricingKnown: boolean;
}

export interface WorkflowCostEstimate {
  midUsd: number;
  lowUsd: number;
  highUsd: number;
  basedOn: 'empirical' | 'heuristic';
  sampleSize: number;
  /**
   * Chat-default model used to price non-supervisor LLM steps that
   * don't carry a `modelOverride` and aren't `agent_call`s into agents
   * with their own bound model. Kept on the response for backward
   * compatibility — `modelMix` is the authoritative per-step breakdown.
   */
  modelUsed: string;
  /**
   * Judge model used to price the supervisor step.
   * Null when `supervisor: false`, when the workflow has no
   * supervisor step, or when the estimator was invoked without a
   * supervisor toggle.
   */
  judgeModelUsed: string | null;
  /**
   * Per-model token + cost breakdown. Captures step-level
   * `modelOverride` and the agent-bound model used by `agent_call`
   * steps — so an audit workflow that pins one step to gpt-5 prices
   * that step at gpt-5 even when the chat default is gpt-4o-mini.
   * Empty array when the workflow has no LLM steps at all.
   */
  modelMix: WorkflowCostEstimateModel[];
  /** Whether the workflow has a supervisor step at all. */
  workflowHasSupervisor: boolean;
  /** Count of LLM-producing steps in the workflow (excluding supervisor). */
  llmStepCount: number;
  /**
   * Per-step dollar contributions. Consumed by the workflow builder to
   * tint individual nodes that are projected to use a large share of
   * the per-execution cap. Mirrors the same calibration as `midUsd`:
   * heuristic in heuristic mode, work/sup ratio applied uniformly in
   * empirical mode.
   */
  perStep: WorkflowCostEstimateStep[];
  /** Short explanation rendered in trigger-UI FieldHelp popovers. */
  notes: string;
}

interface PastRunSummary {
  executionId: string;
  /** itemCount derived from inputData.modelIds or a similar input array. */
  itemCount: number;
  supervisor: boolean;
  workInputTokens: number;
  workOutputTokens: number;
  supInputTokens: number;
  supOutputTokens: number;
  /**
   * Dominant model per LLM step in this past run, as recorded on
   * `AiCostLog.model`. Used to detect "model setup has changed since
   * this run" — empirical calibration is only trusted when the past
   * run's per-step model assignment matches the current shape's
   * resolved-model fingerprint. Steps with multiple cost-log rows pick
   * the model with the most tokens; rows missing `model` are ignored.
   */
  modelByStepId: Map<string, string>;
}

/** Per-step model + LLM-call multiplier — drives per-model token allocation. */
interface StepModelEntry {
  stepId: string;
  type: string;
  modelId: string;
  /** STEP_LLM_MULTIPLIERS lookup; 1 for plain LLM steps. */
  multiplier: number;
}

export interface WorkflowShape {
  llmStepCount: number;
  hasSupervisor: boolean;
  /** Step ids that have type 'supervisor' — used to split past run costs. */
  supervisorStepIds: ReadonlySet<string>;
  /**
   * One entry per non-supervisor LLM-producing step, in definition order,
   * with the model that step will use at runtime (modelOverride →
   * agent_call agent.model → chat default).
   */
  workSteps: StepModelEntry[];
  /**
   * Step id of the (single) supervisor step, if any. Used to attribute
   * the supervisor cost contribution to the right node for per-step
   * tinting in the builder. The validator allows at most one supervisor
   * step per workflow; if there are several only the first is attributed.
   */
  supervisorStepId: string | null;
  /** Resolved model for the (single) supervisor step, if any. */
  supervisorModelId: string | null;
}

interface PerModelTokens {
  inputTokens: number;
  outputTokens: number;
}

interface PerStepTokens {
  stepId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
}

interface HeuristicTokens {
  /** Per-model token allocation for non-supervisor LLM steps. */
  workByModel: Map<string, PerModelTokens>;
  /**
   * Per-step token allocation for non-supervisor LLM steps. Aggregating
   * `perStep` by `modelId` reproduces `workByModel`; we keep both so the
   * pricer can attribute costs both ways without re-walking the shape.
   */
  perStep: PerStepTokens[];
  /** Aggregate tokens (sum across models) — used by the empirical ratio. */
  workInputTokens: number;
  workOutputTokens: number;
  /** Supervisor lives on a single model (judge), so a plain pair is enough. */
  supInputTokens: number;
  supOutputTokens: number;
}

function predictHeuristic(
  shape: WorkflowShape,
  itemCount: number,
  supervisor: boolean,
  chatModelId: string
): HeuristicTokens {
  const workByModel = new Map<string, PerModelTokens>();
  const perStep: PerStepTokens[] = [];

  // Effective step list for per-item scaling + the "at least one step"
  // floor. Workflows whose definition has no LLM-producing steps still
  // produce a tiny heuristic so the UI doesn't render "$0.00" as if the
  // run is free; the floor is attributed to a synthetic step id so the
  // builder simply ignores it (no node to tint).
  const effectiveSteps = shape.workSteps.length > 0 ? shape.workSteps : null;
  const totalMultiplier = effectiveSteps
    ? effectiveSteps.reduce((sum, s) => sum + s.multiplier, 0)
    : 1;

  if (effectiveSteps) {
    for (const step of effectiveSteps) {
      const share = totalMultiplier > 0 ? step.multiplier / totalMultiplier : 0;
      const itemInput = itemCount > 0 ? HEURISTIC.PER_ITEM_INPUT_TOKENS * itemCount * share : 0;
      const itemOutput = itemCount > 0 ? HEURISTIC.PER_ITEM_OUTPUT_TOKENS * itemCount * share : 0;
      const inputTokens = HEURISTIC.INPUT_TOKENS_PER_LLM_STEP * step.multiplier + itemInput;
      const outputTokens = HEURISTIC.OUTPUT_TOKENS_PER_LLM_STEP * step.multiplier + itemOutput;
      perStep.push({ stepId: step.stepId, modelId: step.modelId, inputTokens, outputTokens });
      bumpModel(workByModel, step.modelId, inputTokens, outputTokens);
    }
  } else {
    bumpModel(
      workByModel,
      chatModelId,
      HEURISTIC.INPUT_TOKENS_PER_LLM_STEP,
      HEURISTIC.OUTPUT_TOKENS_PER_LLM_STEP
    );
  }

  let workInputTokens = 0;
  let workOutputTokens = 0;
  for (const { inputTokens, outputTokens } of workByModel.values()) {
    workInputTokens += inputTokens;
    workOutputTokens += outputTokens;
  }

  return {
    workByModel,
    perStep,
    workInputTokens,
    workOutputTokens,
    supInputTokens: supervisor && shape.hasSupervisor ? HEURISTIC.SUPERVISOR_INPUT_TOKENS : 0,
    supOutputTokens: supervisor && shape.hasSupervisor ? HEURISTIC.SUPERVISOR_OUTPUT_TOKENS : 0,
  };
}

function bumpModel(
  bucket: Map<string, PerModelTokens>,
  modelId: string,
  input: number,
  output: number
): void {
  const cur = bucket.get(modelId);
  if (cur) {
    cur.inputTokens += input;
    cur.outputTokens += output;
  } else {
    bucket.set(modelId, { inputTokens: input, outputTokens: output });
  }
}

/**
 * Scale a per-model token allocation in place. Returns the same map
 * (mutated) for caller convenience. `ratio === 1` is a no-op aside
 * from the allocation.
 */
function scalePerModel(
  bucket: Map<string, PerModelTokens>,
  ratio: number
): Map<string, PerModelTokens> {
  if (ratio === 1) return bucket;
  for (const tokens of bucket.values()) {
    tokens.inputTokens *= ratio;
    tokens.outputTokens *= ratio;
  }
  return bucket;
}

function priceTokens(modelId: string, inputTokens: number, outputTokens: number): number {
  const model = getModel(modelId);
  if (!model) return 0;
  return (
    (inputTokens / 1_000_000) * model.inputCostPerMillion +
    (outputTokens / 1_000_000) * model.outputCostPerMillion
  );
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Median absolute deviation as a fraction of the median. More robust
 * to outliers than std-dev/mean when N is small.
 */
function relativeMad(values: number[], centre: number): number {
  if (values.length === 0 || centre === 0) return 0;
  const devs = values.map((v) => Math.abs(v - centre));
  return median(devs) / centre;
}

export interface EstimateWorkflowCostInput {
  workflowId: string;
  /**
   * Optional caller-supplied multiplier for workflows whose cost scales
   * with an input dimension (e.g. number of models being audited, number
   * of documents being processed). Defaults to 0 — workflows without a
   * scaling input simply omit it.
   */
  itemCount?: number;
  /**
   * Whether the supervisor step should run for this estimate. Ignored
   * when the workflow has no supervisor step. Past runs are filtered
   * by their actual supervisor toggle (extracted from
   * `inputData.__runSupervisor`) so the calibration set matches.
   */
  supervisor?: boolean;
  /**
   * Optional in-memory workflow definition. When supplied, the shape
   * (LLM-step count, per-step model resolution, supervisor presence) is
   * computed from this definition rather than read from the workflow's
   * published version. Lets the builder estimate against an unsaved
   * draft. Past-run calibration is still keyed by `workflowId`, so the
   * empirical floor reuses historical token shapes — that's safe
   * because the per-model attribution comes from the supplied
   * definition, not the historical runs.
   */
  definition?: WorkflowDefinition;
}

export async function estimateWorkflowCost(
  input: EstimateWorkflowCostInput
): Promise<WorkflowCostEstimate> {
  const { workflowId, itemCount = 0, supervisor = false, definition } = input;

  // Warm the in-memory model registry before pricing. Without this,
  // a cost-estimate served before any other code path triggered the
  // lazy OpenRouter refresh sees an empty registry beyond the small
  // static fallback, and any operator-curated id (e.g. `gpt-5`) prices
  // to $0. Both helpers are heavily cached (24h / 60s TTLs), so the
  // cold path pays the network/DB cost once and every subsequent call
  // is a no-op. `allSettled` so a transient OR outage doesn't block
  // the DB hydration (and vice versa).
  await Promise.allSettled([refreshFromOpenRouter(), hydrateModelRegistryFromDb()]);

  const chatModelId = (await getDefaultModelForTaskOrNull('chat')) ?? FALLBACK_MODEL_ID;

  // Workflow shape — drives the heuristic + supervisor detection.
  // Resolves each LLM-producing step's model via the lookup chain
  // step.config.modelOverride → agent_call agent.model → chat default.
  // When the caller passes an in-memory definition (workflow builder),
  // shape comes from that draft; otherwise we read the published
  // version from the DB.
  const shape = definition
    ? await summariseShape(definition, chatModelId)
    : await loadWorkflowShape(workflowId, chatModelId);
  const supervisorActive = supervisor && shape.hasSupervisor;
  const judgeModelId = supervisorActive
    ? (shape.supervisorModelId ?? JUDGE_MODEL ?? chatModelId)
    : null;

  const heuristic = predictHeuristic(shape, itemCount, supervisor, chatModelId);

  let pastRuns: PastRunSummary[] = [];
  try {
    pastRuns = await loadPastRuns(workflowId, shape.supervisorStepIds);
  } catch (err) {
    logger.warn('estimateWorkflowCost: past-runs query failed, falling back to heuristic', {
      workflowId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Filter past runs to those whose per-step model assignment still
  // matches the current shape. Reusing token shape from a run on a
  // different model would silently misprice — Sonnet-era runs on a step
  // now bound to Opus produce different verbosity *and* different
  // per-token rates, and there is no way to retro-fit one to the other.
  // We treat the swap as a hard reset: empirical reactivates only once
  // EMPIRICAL_MIN_SAMPLES runs have accumulated under the new models.
  const currentFingerprint = buildCurrentFingerprint(shape, supervisorActive ? judgeModelId : null);
  const matchingRuns =
    currentFingerprint.size === 0
      ? pastRuns
      : pastRuns.filter((run) => runMatchesFingerprint(currentFingerprint, run.modelByStepId));
  const excludedByModelChange = pastRuns.length - matchingRuns.length;

  // Work calibration uses every *matching* past run — work tokens are
  // isolated from supervisor tokens by `loadPastRuns` (via
  // `supervisorStepIds`), so a past run with the supervisor on still
  // has a clean work-only bucket worth calibrating against. Supervisor
  // calibration is narrower: `buildEmpiricalEstimate` derives
  // `supRatio` from the subset where `run.supervisor === true`, and
  // the supervisor cost is gated by
  // `heuristic.supInputTokens/supOutputTokens` (both 0 when the toggle
  // is off). Net effect: the supervisor toggle no longer silently
  // swaps methodologies — empirical/heuristic is chosen by the same
  // sample size either way, and the toggle just adds/removes the
  // supervisor add-on on top of a consistent work baseline.
  if (matchingRuns.length >= EMPIRICAL_MIN_SAMPLES) {
    return buildEmpiricalEstimate({
      shape,
      heuristic,
      pastRuns: matchingRuns,
      chatModelId,
      judgeModelId,
    });
  }

  return buildHeuristicEstimate({
    shape,
    heuristic,
    chatModelId,
    judgeModelId,
    sampleSize: pastRuns.length,
    excludedByModelChange,
  });
}

function buildEmpiricalEstimate(params: {
  shape: WorkflowShape;
  heuristic: HeuristicTokens;
  pastRuns: PastRunSummary[];
  chatModelId: string;
  judgeModelId: string | null;
}): WorkflowCostEstimate {
  const { shape, heuristic, pastRuns, chatModelId, judgeModelId } = params;

  // Per-run ratio between actual and heuristic prediction. The ratio
  // captures prompt-evolution and tokeniser drift in one number, then
  // gets applied uniformly across all per-model token buckets. Past
  // runs whose model mix differed from the current definition still
  // inform shape drift but don't shift the per-model attribution —
  // that's read from the *current* workflow definition.
  //
  // Work calibration consumes every past run. Supervisor calibration
  // only consumes runs that actually had the supervisor on; otherwise
  // there's no supervisor actual to compare against.
  const workRatios: number[] = [];
  const supRatios: number[] = [];
  for (const run of pastRuns) {
    const pred = predictHeuristic(shape, run.itemCount, run.supervisor, chatModelId);
    const actualWork = run.workInputTokens + run.workOutputTokens;
    const predWork = pred.workInputTokens + pred.workOutputTokens;
    if (predWork > 0 && actualWork > 0) workRatios.push(actualWork / predWork);

    if (run.supervisor) {
      const actualSup = run.supInputTokens + run.supOutputTokens;
      const predSup = pred.supInputTokens + pred.supOutputTokens;
      if (predSup > 0 && actualSup > 0) supRatios.push(actualSup / predSup);
    }
  }

  // Median is more robust than mean for small samples.
  const workRatio = workRatios.length > 0 ? median(workRatios) : 1;
  const supRatio = supRatios.length > 0 ? median(supRatios) : 1;

  const scaledWork = scalePerModel(cloneTokenMap(heuristic.workByModel), workRatio);
  const scaledPerStep = scalePerStep(heuristic.perStep, workRatio);
  const scaledSupInput = heuristic.supInputTokens * supRatio;
  const scaledSupOutput = heuristic.supOutputTokens * supRatio;

  const { midUsd, modelMix, perStep } = priceModelMix({
    workByModel: scaledWork,
    workPerStep: scaledPerStep,
    judgeModelId,
    supervisorStepId: shape.supervisorStepId,
    supInputTokens: scaledSupInput,
    supOutputTokens: scaledSupOutput,
  });

  const rawSpread = relativeMad(workRatios, workRatio);
  const spread = Math.max(EMPIRICAL_RANGE_MIN, Math.min(rawSpread, EMPIRICAL_RANGE_MAX));

  return {
    midUsd,
    lowUsd: Math.max(0, midUsd * (1 - spread)),
    highUsd: midUsd * (1 + spread),
    basedOn: 'empirical',
    sampleSize: pastRuns.length,
    modelUsed: chatModelId,
    judgeModelUsed: judgeModelId,
    modelMix,
    workflowHasSupervisor: shape.hasSupervisor,
    llmStepCount: shape.llmStepCount,
    perStep,
    notes: `Calibrated from ${pastRuns.length} past run${
      pastRuns.length === 1 ? '' : 's'
    } on the current model setup — token usage repriced at current per-model rates.`,
  };
}

function buildHeuristicEstimate(params: {
  shape: WorkflowShape;
  heuristic: HeuristicTokens;
  chatModelId: string;
  judgeModelId: string | null;
  sampleSize: number;
  /**
   * Past runs that exist but were excluded because their per-step model
   * assignment no longer matches the current shape. Drives the
   * "model setup has changed" note so the operator understands *why*
   * the estimator dropped back to heuristic despite the run history.
   */
  excludedByModelChange?: number;
}): WorkflowCostEstimate {
  const {
    shape,
    heuristic,
    chatModelId,
    judgeModelId,
    sampleSize,
    excludedByModelChange = 0,
  } = params;

  const { midUsd, modelMix, perStep } = priceModelMix({
    workByModel: cloneTokenMap(heuristic.workByModel),
    workPerStep: heuristic.perStep.map((s) => ({ ...s })),
    judgeModelId,
    supervisorStepId: shape.supervisorStepId,
    supInputTokens: heuristic.supInputTokens,
    supOutputTokens: heuristic.supOutputTokens,
  });

  const notes = (() => {
    if (excludedByModelChange > 0) {
      return `${excludedByModelChange} prior run${
        excludedByModelChange === 1 ? '' : 's'
      } ran on different models — heuristic used until ${EMPIRICAL_MIN_SAMPLES}+ runs accumulate under the current model setup.`;
    }
    if (sampleSize === 0) {
      return `No prior runs — estimate is a heuristic from this workflow's shape (${
        shape.llmStepCount
      } LLM-producing step${shape.llmStepCount === 1 ? '' : 's'}).`;
    }
    return `Only ${sampleSize} prior run${
      sampleSize === 1 ? '' : 's'
    } with this supervisor setting — heuristic used until ${EMPIRICAL_MIN_SAMPLES}+ are available.`;
  })();

  return {
    midUsd,
    lowUsd: midUsd * HEURISTIC_LOW_MULT,
    highUsd: midUsd * HEURISTIC_HIGH_MULT,
    basedOn: 'heuristic',
    sampleSize,
    modelUsed: chatModelId,
    judgeModelUsed: judgeModelId,
    modelMix,
    workflowHasSupervisor: shape.hasSupervisor,
    llmStepCount: shape.llmStepCount,
    perStep,
    notes,
  };
}

/**
 * Price each model's token allocation independently and assemble the
 * `modelMix` array. A model that resolves to a registry entry with
 * zero pricing (unknown id, free-tier local model) contributes $0 but
 * still appears in the mix so the operator can see *which* model the
 * estimator considered — surfacing the unknown explicitly beats
 * silently dropping the row.
 */
function priceModelMix(params: {
  workByModel: Map<string, PerModelTokens>;
  workPerStep: PerStepTokens[];
  judgeModelId: string | null;
  supervisorStepId: string | null;
  supInputTokens: number;
  supOutputTokens: number;
}): {
  midUsd: number;
  modelMix: WorkflowCostEstimateModel[];
  perStep: WorkflowCostEstimateStep[];
} {
  const {
    workByModel,
    workPerStep,
    judgeModelId,
    supervisorStepId,
    supInputTokens,
    supOutputTokens,
  } = params;
  const modelMix: WorkflowCostEstimateModel[] = [];
  const perStep: WorkflowCostEstimateStep[] = [];
  let midUsd = 0;

  for (const [modelId, tokens] of workByModel) {
    const pricingKnown = isModelPriced(modelId);
    const cost = priceTokens(modelId, tokens.inputTokens, tokens.outputTokens);
    midUsd += cost;
    modelMix.push({
      modelId,
      role: 'work',
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      costUsd: cost,
      pricingKnown,
    });
  }

  // Per-step contributions. Priced independently so a step pinned to a
  // pricier model is attributed its actual share rather than a model-mix
  // average. The sum across `perStep` matches the work portion of
  // `midUsd` modulo floating-point.
  for (const step of workPerStep) {
    const pricingKnown = isModelPriced(step.modelId);
    const cost = priceTokens(step.modelId, step.inputTokens, step.outputTokens);
    perStep.push({
      stepId: step.stepId,
      modelId: step.modelId,
      role: 'work',
      inputTokens: step.inputTokens,
      outputTokens: step.outputTokens,
      costUsd: cost,
      pricingKnown,
    });
  }

  if (judgeModelId && (supInputTokens > 0 || supOutputTokens > 0)) {
    const pricingKnown = isModelPriced(judgeModelId);
    const cost = priceTokens(judgeModelId, supInputTokens, supOutputTokens);
    midUsd += cost;
    modelMix.push({
      modelId: judgeModelId,
      role: 'supervisor',
      inputTokens: supInputTokens,
      outputTokens: supOutputTokens,
      costUsd: cost,
      pricingKnown,
    });
    if (supervisorStepId) {
      perStep.push({
        stepId: supervisorStepId,
        modelId: judgeModelId,
        role: 'supervisor',
        inputTokens: supInputTokens,
        outputTokens: supOutputTokens,
        costUsd: cost,
        pricingKnown,
      });
    }
  }

  return { midUsd, modelMix, perStep };
}

/**
 * Scale per-step token allocations by `ratio`. Returns a fresh array;
 * caller's heuristic copy is preserved. `ratio === 1` short-circuits.
 */
function scalePerStep(steps: PerStepTokens[], ratio: number): PerStepTokens[] {
  if (ratio === 1) return steps.map((s) => ({ ...s }));
  return steps.map((s) => ({
    ...s,
    inputTokens: s.inputTokens * ratio,
    outputTokens: s.outputTokens * ratio,
  }));
}

/**
 * A model is "priced" when the registry has a row for it AND that row
 * carries non-zero pricing. A zero-cost registry entry (e.g. a local
 * provider with no operator-supplied rate) is still treated as unknown
 * for UI purposes — a $0 estimate masquerading as accurate is worse
 * than an explicit "pricing unknown" callout.
 */
function isModelPriced(modelId: string): boolean {
  const m = getModel(modelId);
  if (!m) return false;
  return m.inputCostPerMillion > 0 || m.outputCostPerMillion > 0;
}

function cloneTokenMap(src: Map<string, PerModelTokens>): Map<string, PerModelTokens> {
  const dst = new Map<string, PerModelTokens>();
  for (const [k, v] of src) dst.set(k, { ...v });
  return dst;
}

/**
 * Read the workflow's published definition and derive its cost shape:
 *   - count of LLM-producing steps (excludes supervisor — tracked separately)
 *   - whether there's a supervisor step
 *   - set of supervisor step ids for splitting past run costs
 *
 * Returns a degenerate shape (1 LLM step, no supervisor) if the row
 * can't be loaded or the definition fails schema validation — better
 * to surface a low-confidence estimate than crash the dialog.
 */
export async function loadWorkflowShape(
  workflowId: string,
  chatDefaultModelId: string
): Promise<WorkflowShape> {
  try {
    const workflow = await prisma.aiWorkflow.findUnique({
      where: { id: workflowId },
      select: { publishedVersion: { select: { snapshot: true } } },
    });

    const snapshot = workflow?.publishedVersion?.snapshot;
    if (!snapshot) return degenerateShape(chatDefaultModelId);

    const parsed = workflowDefinitionSchema.safeParse(snapshot);
    if (!parsed.success) {
      logger.warn('loadWorkflowShape: definition failed schema validation', {
        workflowId,
        issues: parsed.error.issues.length,
      });
      return degenerateShape(chatDefaultModelId);
    }

    return await summariseShape(parsed.data, chatDefaultModelId);
  } catch (err) {
    logger.warn('loadWorkflowShape: query failed', {
      workflowId,
      error: err instanceof Error ? err.message : String(err),
    });
    return degenerateShape(chatDefaultModelId);
  }
}

function degenerateShape(_chatDefaultModelId: string): WorkflowShape {
  return {
    llmStepCount: 1,
    hasSupervisor: false,
    supervisorStepIds: new Set(),
    workSteps: [],
    supervisorStepId: null,
    supervisorModelId: null,
  };
}

export async function summariseShape(
  definition: WorkflowDefinition,
  chatDefaultModelId: string
): Promise<WorkflowShape> {
  const supervisorStepIds = new Set<string>();
  const workSteps: StepModelEntry[] = [];
  let supervisorModelId: string | null = null;
  let supervisorOverride: string | null = null;

  // First pass: collect agent slugs we need to resolve and detect the
  // supervisor step. The supervisor's modelOverride wins; otherwise the
  // engine resolves to JUDGE_MODEL at runtime, which we honour
  // separately in `estimateWorkflowCost`.
  const agentSlugs = new Set<string>();
  for (const step of definition.steps) {
    if (step.type === SUPERVISOR_STEP_TYPE) {
      supervisorStepIds.add(step.id);
      const override = readModelOverride(step.config);
      if (override) supervisorOverride = override;
      continue;
    }
    if (!LLM_STEP_TYPES.has(step.type)) continue;
    if (step.type === 'agent_call' && !readModelOverride(step.config)) {
      const slug = readAgentSlug(step.config);
      if (slug) agentSlugs.add(slug);
    }
  }

  // Resolve agent slugs → bound model in one round-trip. Agents
  // without a bound `model` (rare; the form requires it) fall back to
  // the chat default.
  const agentModelBySlug = await loadAgentModels(agentSlugs);

  // Second pass: build the per-step entry list using resolved data.
  for (const step of definition.steps) {
    if (step.type === SUPERVISOR_STEP_TYPE) continue;
    if (!LLM_STEP_TYPES.has(step.type)) continue;

    const override = readModelOverride(step.config);
    let modelId: string;
    if (override) {
      modelId = override;
    } else if (step.type === 'agent_call') {
      const slug = readAgentSlug(step.config);
      const bound = slug ? agentModelBySlug.get(slug) : null;
      modelId = bound ?? chatDefaultModelId;
    } else {
      modelId = chatDefaultModelId;
    }

    workSteps.push({
      stepId: step.id,
      type: step.type,
      modelId,
      multiplier: STEP_LLM_MULTIPLIERS[step.type] ?? 1,
    });
  }

  const llmStepCount = workSteps.reduce((sum, s) => sum + s.multiplier, 0);
  supervisorModelId = supervisorOverride;
  const supervisorStepId =
    supervisorStepIds.size > 0 ? (supervisorStepIds.values().next().value ?? null) : null;

  return {
    llmStepCount,
    hasSupervisor: supervisorStepIds.size > 0,
    supervisorStepIds,
    workSteps,
    supervisorStepId,
    supervisorModelId,
  };
}

function readModelOverride(config: Record<string, unknown>): string | null {
  const val = config.modelOverride;
  return typeof val === 'string' && val.length > 0 ? val : null;
}

function readAgentSlug(config: Record<string, unknown>): string | null {
  const val = config.agentSlug;
  return typeof val === 'string' && val.length > 0 ? val : null;
}

async function loadAgentModels(slugs: Set<string>): Promise<Map<string, string | null>> {
  if (slugs.size === 0) return new Map();
  try {
    const rows = await prisma.aiAgent.findMany({
      where: { slug: { in: Array.from(slugs) } },
      select: { slug: true, model: true },
    });
    const result = new Map<string, string | null>();
    for (const row of rows) {
      result.set(row.slug, row.model && row.model.length > 0 ? row.model : null);
    }
    return result;
  } catch (err) {
    logger.warn('loadAgentModels: query failed', {
      slugs: Array.from(slugs),
      error: err instanceof Error ? err.message : String(err),
    });
    return new Map();
  }
}

async function loadPastRuns(
  workflowId: string,
  supervisorStepIds: ReadonlySet<string>
): Promise<PastRunSummary[]> {
  const executions = await prisma.aiWorkflowExecution.findMany({
    where: { workflowId, status: 'completed' },
    select: { id: true, inputData: true },
    orderBy: { completedAt: 'desc' },
    take: 100,
  });

  if (executions.length === 0) return [];

  const executionIds = executions.map((e) => e.id);
  const costLogs = await prisma.aiCostLog.findMany({
    where: { workflowExecutionId: { in: executionIds } },
    select: {
      workflowExecutionId: true,
      inputTokens: true,
      outputTokens: true,
      metadata: true,
      model: true,
    },
  });

  // Aggregate per execution, splitting supervisor steps from the rest.
  // Track per-(stepId, modelId) token totals so we can derive a
  // dominant-model fingerprint per past run — used downstream to detect
  // model changes.
  interface Aggregate {
    workInput: number;
    workOutput: number;
    supInput: number;
    supOutput: number;
    modelTokensByStep: Map<string, Map<string, number>>;
  }
  const byExecution = new Map<string, Aggregate>();
  for (const row of costLogs) {
    if (!row.workflowExecutionId) continue;
    const stepId = readStepId(row.metadata);
    const isSupervisor = stepId !== undefined && supervisorStepIds.has(stepId);
    const modelId = typeof row.model === 'string' && row.model.length > 0 ? row.model : null;

    const agg: Aggregate = byExecution.get(row.workflowExecutionId) ?? {
      workInput: 0,
      workOutput: 0,
      supInput: 0,
      supOutput: 0,
      modelTokensByStep: new Map<string, Map<string, number>>(),
    };
    if (isSupervisor) {
      agg.supInput += row.inputTokens;
      agg.supOutput += row.outputTokens;
    } else {
      agg.workInput += row.inputTokens;
      agg.workOutput += row.outputTokens;
    }
    if (stepId && modelId) {
      const stepMap = agg.modelTokensByStep.get(stepId) ?? new Map<string, number>();
      stepMap.set(modelId, (stepMap.get(modelId) ?? 0) + row.inputTokens + row.outputTokens);
      agg.modelTokensByStep.set(stepId, stepMap);
    }
    byExecution.set(row.workflowExecutionId, agg);
  }

  const summaries: PastRunSummary[] = [];
  for (const exec of executions) {
    const agg = byExecution.get(exec.id);
    if (!agg) continue;
    const totals = agg.workInput + agg.workOutput + agg.supInput + agg.supOutput;
    if (totals === 0) continue;

    const parsed = parseInputData(exec.inputData);
    const modelByStepId = new Map<string, string>();
    for (const [stepId, modelMap] of agg.modelTokensByStep) {
      let bestModel = '';
      let bestTokens = -1;
      for (const [modelId, tokens] of modelMap) {
        if (tokens > bestTokens) {
          bestTokens = tokens;
          bestModel = modelId;
        }
      }
      if (bestModel) modelByStepId.set(stepId, bestModel);
    }

    summaries.push({
      executionId: exec.id,
      itemCount: parsed.itemCount,
      supervisor: parsed.supervisor,
      workInputTokens: agg.workInput,
      workOutputTokens: agg.workOutput,
      supInputTokens: agg.supInput,
      supOutputTokens: agg.supOutput,
      modelByStepId,
    });
  }

  return summaries;
}

/**
 * Resolved-model fingerprint of the *current* workflow shape. Maps each
 * LLM step id (work or supervisor) to the model id that step would use
 * at runtime. Compared against `PastRunSummary.modelByStepId` to decide
 * whether a past run is still representative of what the workflow does
 * now — a step pointed at a different model has a different token shape
 * (verbosity profile) and almost certainly a different per-token cost,
 * so empirical reuse of its tokens would be dishonest.
 *
 * Supervisor is included only when the caller asked for it
 * (`supervisorActive`); otherwise the supervisor's tokens contribute
 * nothing to the current estimate, so its past model is irrelevant.
 */
function buildCurrentFingerprint(
  shape: WorkflowShape,
  judgeModelId: string | null
): Map<string, string> {
  const fp = new Map<string, string>();
  for (const step of shape.workSteps) {
    fp.set(step.stepId, step.modelId);
  }
  if (shape.supervisorStepId && judgeModelId) {
    fp.set(shape.supervisorStepId, judgeModelId);
  }
  return fp;
}

/**
 * A past run matches the current fingerprint if every step that *both*
 * the current shape and the past run know about resolves to the same
 * model. The check is intentionally lenient on two edges:
 *
 *   - **Steps in the current shape with no past-run data**: pass
 *     through. The empirical ratio is a uniform scale over the
 *     heuristic baseline, so a step with no past data simply receives
 *     its heuristic per-step tokens priced at its current model rate —
 *     there's no historical token shape to misprice.
 *   - **Steps in the past run that no longer exist**: ignored. Removed
 *     steps don't contribute to the current cost, so their old model
 *     doesn't matter.
 *
 * The run is rejected when *any* shared step has a different model —
 * that's the swap the operator just made on the canvas, and reusing
 * tokens from the old model would silently misprice the new one.
 *
 * A run with zero overlap with the current shape (no shared step ids)
 * is rejected: there's no signal that it's the same workflow at all.
 */
function runMatchesFingerprint(
  currentFp: Map<string, string>,
  runFp: Map<string, string>
): boolean {
  let overlap = 0;
  for (const [stepId, currentModel] of currentFp) {
    const runModel = runFp.get(stepId);
    if (runModel === undefined) continue;
    if (runModel !== currentModel) return false;
    overlap += 1;
  }
  return overlap > 0;
}

function readStepId(metadata: unknown): string | undefined {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return undefined;
  }
  const value = (metadata as Record<string, unknown>).stepId;
  return typeof value === 'string' ? value : undefined;
}

interface ParsedInputData {
  /**
   * Best-effort itemCount from common conventional input shapes.
   * Returns 0 when no recognisable list field is present — generic
   * workflows that pass arbitrary input still calibrate via the
   * aggregate token totals, just without per-item scaling.
   */
  itemCount: number;
  supervisor: boolean;
}

/**
 * Extract calibration-relevant fields from a past execution's inputData.
 *
 * Looks for common list fields by name (`modelIds`, `items`, `inputs`,
 * `ids`) and uses the first non-empty array's length as the item count.
 * Workflows that store their inputs under a different name simply get
 * `itemCount: 0` — they still calibrate from aggregate token totals,
 * the per-item heuristic just doesn't fire.
 *
 * `supervisor` follows the engine's strict equality: only the literal
 * boolean `false` opts out; anything else (undefined, null, string
 * `'false'`, `0`) means the supervisor ran.
 */
export function parseInputData(raw: unknown): ParsedInputData {
  const fallback: ParsedInputData = { itemCount: 0, supervisor: true };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fallback;
  const obj = raw as Record<string, unknown>;

  let itemCount = 0;
  for (const key of ['modelIds', 'items', 'inputs', 'ids'] as const) {
    const val = obj[key];
    if (Array.isArray(val) && val.length > 0) {
      itemCount = val.length;
      break;
    }
  }
  return {
    itemCount,
    supervisor: obj.__runSupervisor !== false,
  };
}
