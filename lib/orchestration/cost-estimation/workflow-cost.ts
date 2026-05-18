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
import { getModel } from '@/lib/orchestration/llm/model-registry';
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

export interface WorkflowCostEstimate {
  midUsd: number;
  lowUsd: number;
  highUsd: number;
  basedOn: 'empirical' | 'heuristic';
  sampleSize: number;
  /** Chat-default model used to price non-supervisor LLM steps. */
  modelUsed: string;
  /**
   * Judge model used to price the supervisor step.
   * Null when `supervisor: false`, when the workflow has no
   * supervisor step, or when the estimator was invoked without a
   * supervisor toggle.
   */
  judgeModelUsed: string | null;
  /** Whether the workflow has a supervisor step at all. */
  workflowHasSupervisor: boolean;
  /** Count of LLM-producing steps in the workflow (excluding supervisor). */
  llmStepCount: number;
  /** Short explanation rendered in trigger-UI FieldHelp popovers. */
  notes: string;
}

interface PastRunSummary {
  /** itemCount derived from inputData.modelIds or a similar input array. */
  itemCount: number;
  supervisor: boolean;
  workInputTokens: number;
  workOutputTokens: number;
  supInputTokens: number;
  supOutputTokens: number;
}

interface WorkflowShape {
  llmStepCount: number;
  hasSupervisor: boolean;
  /** Step ids that have type 'supervisor' — used to split past run costs. */
  supervisorStepIds: ReadonlySet<string>;
}

interface HeuristicTokens {
  workInputTokens: number;
  workOutputTokens: number;
  supInputTokens: number;
  supOutputTokens: number;
}

function predictHeuristic(
  shape: WorkflowShape,
  itemCount: number,
  supervisor: boolean
): HeuristicTokens {
  const llmSteps = Math.max(shape.llmStepCount, 1); // at least one step
  return {
    workInputTokens:
      HEURISTIC.INPUT_TOKENS_PER_LLM_STEP * llmSteps + HEURISTIC.PER_ITEM_INPUT_TOKENS * itemCount,
    workOutputTokens:
      HEURISTIC.OUTPUT_TOKENS_PER_LLM_STEP * llmSteps +
      HEURISTIC.PER_ITEM_OUTPUT_TOKENS * itemCount,
    supInputTokens: supervisor && shape.hasSupervisor ? HEURISTIC.SUPERVISOR_INPUT_TOKENS : 0,
    supOutputTokens: supervisor && shape.hasSupervisor ? HEURISTIC.SUPERVISOR_OUTPUT_TOKENS : 0,
  };
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
}

export async function estimateWorkflowCost(
  input: EstimateWorkflowCostInput
): Promise<WorkflowCostEstimate> {
  const { workflowId, itemCount = 0, supervisor = false } = input;

  const chatModelId = (await getDefaultModelForTaskOrNull('chat')) ?? FALLBACK_MODEL_ID;

  // Workflow shape — drives the heuristic + supervisor detection.
  const shape = await loadWorkflowShape(workflowId);
  const supervisorActive = supervisor && shape.hasSupervisor;
  const judgeModelId = supervisorActive ? (JUDGE_MODEL ?? chatModelId) : null;

  const heuristic = predictHeuristic(shape, itemCount, supervisor);

  let pastRuns: PastRunSummary[] = [];
  try {
    pastRuns = await loadPastRuns(workflowId, shape.supervisorStepIds);
  } catch (err) {
    logger.warn('estimateWorkflowCost: past-runs query failed, falling back to heuristic', {
      workflowId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Filter past runs to ones that match the requested supervisor toggle
  // *as long as the workflow even has a supervisor*. For workflows
  // without supervisor steps, the toggle is meaningless and we use all
  // past runs.
  const matchingRuns = shape.hasSupervisor
    ? pastRuns.filter((r) => r.supervisor === supervisor)
    : pastRuns;

  if (matchingRuns.length >= EMPIRICAL_MIN_SAMPLES) {
    return buildEmpiricalEstimate({
      shape,
      heuristic,
      matchingRuns,
      chatModelId,
      judgeModelId,
    });
  }

  return buildHeuristicEstimate({
    shape,
    heuristic,
    chatModelId,
    judgeModelId,
    sampleSize: matchingRuns.length,
  });
}

function buildEmpiricalEstimate(params: {
  shape: WorkflowShape;
  heuristic: HeuristicTokens;
  matchingRuns: PastRunSummary[];
  chatModelId: string;
  judgeModelId: string | null;
}): WorkflowCostEstimate {
  const { shape, heuristic, matchingRuns, chatModelId, judgeModelId } = params;

  // Per-run ratio between actual and heuristic prediction. The ratio
  // captures prompt-evolution and tokeniser drift in one number.
  const workRatios: number[] = [];
  const supRatios: number[] = [];
  for (const run of matchingRuns) {
    const pred = predictHeuristic(shape, run.itemCount, run.supervisor);
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

  const scaledWorkInput = heuristic.workInputTokens * workRatio;
  const scaledWorkOutput = heuristic.workOutputTokens * workRatio;
  const scaledSupInput = heuristic.supInputTokens * supRatio;
  const scaledSupOutput = heuristic.supOutputTokens * supRatio;

  const midUsd =
    priceTokens(chatModelId, scaledWorkInput, scaledWorkOutput) +
    (judgeModelId ? priceTokens(judgeModelId, scaledSupInput, scaledSupOutput) : 0);

  const rawSpread = relativeMad(workRatios, workRatio);
  const spread = Math.max(EMPIRICAL_RANGE_MIN, Math.min(rawSpread, EMPIRICAL_RANGE_MAX));

  return {
    midUsd,
    lowUsd: Math.max(0, midUsd * (1 - spread)),
    highUsd: midUsd * (1 + spread),
    basedOn: 'empirical',
    sampleSize: matchingRuns.length,
    modelUsed: chatModelId,
    judgeModelUsed: judgeModelId,
    workflowHasSupervisor: shape.hasSupervisor,
    llmStepCount: shape.llmStepCount,
    notes: `Calibrated from ${matchingRuns.length} past run${
      matchingRuns.length === 1 ? '' : 's'
    } — token usage repriced at current model rates.`,
  };
}

function buildHeuristicEstimate(params: {
  shape: WorkflowShape;
  heuristic: HeuristicTokens;
  chatModelId: string;
  judgeModelId: string | null;
  sampleSize: number;
}): WorkflowCostEstimate {
  const { shape, heuristic, chatModelId, judgeModelId, sampleSize } = params;

  const midUsd =
    priceTokens(chatModelId, heuristic.workInputTokens, heuristic.workOutputTokens) +
    (judgeModelId
      ? priceTokens(judgeModelId, heuristic.supInputTokens, heuristic.supOutputTokens)
      : 0);

  return {
    midUsd,
    lowUsd: midUsd * HEURISTIC_LOW_MULT,
    highUsd: midUsd * HEURISTIC_HIGH_MULT,
    basedOn: 'heuristic',
    sampleSize,
    modelUsed: chatModelId,
    judgeModelUsed: judgeModelId,
    workflowHasSupervisor: shape.hasSupervisor,
    llmStepCount: shape.llmStepCount,
    notes:
      sampleSize === 0
        ? `No prior runs — estimate is a heuristic from this workflow's shape (${shape.llmStepCount} LLM-producing step${
            shape.llmStepCount === 1 ? '' : 's'
          }).`
        : `Only ${sampleSize} prior run${
            sampleSize === 1 ? '' : 's'
          } with this supervisor setting — heuristic used until ${EMPIRICAL_MIN_SAMPLES}+ are available.`,
  };
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
async function loadWorkflowShape(workflowId: string): Promise<WorkflowShape> {
  try {
    const workflow = await prisma.aiWorkflow.findUnique({
      where: { id: workflowId },
      select: { publishedVersion: { select: { snapshot: true } } },
    });

    const snapshot = workflow?.publishedVersion?.snapshot;
    if (!snapshot) return { llmStepCount: 1, hasSupervisor: false, supervisorStepIds: new Set() };

    const parsed = workflowDefinitionSchema.safeParse(snapshot);
    if (!parsed.success) {
      logger.warn('loadWorkflowShape: definition failed schema validation', {
        workflowId,
        issues: parsed.error.issues.length,
      });
      return { llmStepCount: 1, hasSupervisor: false, supervisorStepIds: new Set() };
    }

    return summariseShape(parsed.data);
  } catch (err) {
    logger.warn('loadWorkflowShape: query failed', {
      workflowId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { llmStepCount: 1, hasSupervisor: false, supervisorStepIds: new Set() };
  }
}

export function summariseShape(definition: WorkflowDefinition): WorkflowShape {
  let llmStepCount = 0;
  const supervisorStepIds = new Set<string>();
  for (const step of definition.steps) {
    if (step.type === SUPERVISOR_STEP_TYPE) {
      supervisorStepIds.add(step.id);
      continue;
    }
    if (LLM_STEP_TYPES.has(step.type)) {
      llmStepCount += STEP_LLM_MULTIPLIERS[step.type] ?? 1;
    }
  }
  return {
    llmStepCount,
    hasSupervisor: supervisorStepIds.size > 0,
    supervisorStepIds,
  };
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
    },
  });

  // Aggregate per execution, splitting supervisor steps from the rest.
  interface Aggregate {
    workInput: number;
    workOutput: number;
    supInput: number;
    supOutput: number;
  }
  const byExecution = new Map<string, Aggregate>();
  for (const row of costLogs) {
    if (!row.workflowExecutionId) continue;
    const stepId = readStepId(row.metadata);
    const isSupervisor = stepId !== undefined && supervisorStepIds.has(stepId);

    const agg = byExecution.get(row.workflowExecutionId) ?? {
      workInput: 0,
      workOutput: 0,
      supInput: 0,
      supOutput: 0,
    };
    if (isSupervisor) {
      agg.supInput += row.inputTokens;
      agg.supOutput += row.outputTokens;
    } else {
      agg.workInput += row.inputTokens;
      agg.workOutput += row.outputTokens;
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
    summaries.push({
      itemCount: parsed.itemCount,
      supervisor: parsed.supervisor,
      workInputTokens: agg.workInput,
      workOutputTokens: agg.workOutput,
      supInputTokens: agg.supInput,
      supOutputTokens: agg.supOutput,
    });
  }

  return summaries;
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
