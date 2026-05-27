/**
 * Evaluation cost estimator
 *
 * Predicts the USD cost of a queued batch evaluation run *before* it
 * fires, so the run-create form can show a number near the submit
 * button. Mirrors the workflow estimator's two-mode contract:
 *
 *   - **empirical** — when ≥3 prior `completed` runs match the current
 *     fingerprint `(agentId, sorted judgeAgentSlugs, datasetContentHash)`
 *     we take the median per-case cost from those runs, multiply by the
 *     dataset's current case count, and surface a tight range around it.
 *     The fingerprint is deliberately strict: a judge swap or a
 *     re-uploaded dataset resets the empirical floor until 3 new runs
 *     have accumulated. Looser keys risk silent misprice when the
 *     operator swaps the subject's bound model or replaces a judge.
 *
 *   - **heuristic** — otherwise. Per-case shape is a single subject call
 *     (~1500 input + 500 output tokens at the subject agent's bound
 *     model) plus one call per judge agent (~600 input + 150 output at
 *     each judge's bound model). Heuristic graders cost nothing and are
 *     not counted. Range is wide (±50% / ×2) to signal uncertainty.
 *
 * Pricing comes from the model registry (`getModel`) — operator-curated
 * `AiProviderModel.costPerMillionTokens` overrides the static fallback.
 * A model with no pricing surfaces as `pricingKnown: false` on the
 * relevant `modelMix` entry so the UI can call out the unknown rather
 * than silently reading $0 as "free".
 *
 * Phase 2.0 plumbing tags every chat-handler `AiCostLog` row written by
 * the eval worker with `metadata.role: 'subject' | 'judge'` so the
 * empirical mode can verify the per-role split when we extend this to
 * report a model-mix breakdown. For Phase 2.1 the empirical floor uses
 * `AiEvaluationRun.totalCostUsd / casesDone` directly — same answer,
 * fewer joins.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { getModel, refreshFromOpenRouter } from '@/lib/orchestration/llm/model-registry';
import { hydrateFromDb as hydrateModelRegistryFromDb } from '@/lib/orchestration/llm/model-registry-db-hydrate';
import { getDefaultModelForTaskOrNull } from '@/lib/orchestration/llm/settings-resolver';
import {
  loadWorkflowShape,
  type WorkflowShape,
} from '@/lib/orchestration/cost-estimation/workflow-cost';

/** Heuristic per-case token shape — calibrated against Phase 1 judge prompts. */
const HEURISTIC = {
  SUBJECT_INPUT_TOKENS_PER_CASE: 1_500,
  SUBJECT_OUTPUT_TOKENS_PER_CASE: 500,
  JUDGE_INPUT_TOKENS_PER_CASE: 600,
  JUDGE_OUTPUT_TOKENS_PER_CASE: 150,
  // Workflow-subject case: each LLM-producing step in the published
  // workflow definition contributes its own slice. The numbers mirror
  // `workflow-cost.ts`'s base per-step heuristic (3k in / 1k out) so the
  // two estimators stay aligned when the same workflow appears as both
  // an orchestration target and an eval subject.
  WORKFLOW_STEP_INPUT_TOKENS_PER_CASE: 3_000,
  WORKFLOW_STEP_OUTPUT_TOKENS_PER_CASE: 1_000,
} as const;

/** Last-resort model id if neither the agent nor the chat default resolves. */
const FALLBACK_MODEL_ID = 'claude-sonnet-4-6';

/** Minimum matching past runs needed before empirical mode is trusted. */
const EMPIRICAL_MIN_SAMPLES = 3;

/** Range bounds (fraction of mid) for empirical mode. */
const EMPIRICAL_RANGE_MIN = 0.15;
const EMPIRICAL_RANGE_MAX = 0.5;

/** Heuristic mode is rough — wide range. */
const HEURISTIC_LOW_MULT = 0.5;
const HEURISTIC_HIGH_MULT = 2.0;

export interface EvaluationCostEstimateModel {
  modelId: string;
  /** 'subject' = the agent under test; 'judge' = a model grader. */
  role: 'subject' | 'judge';
  /** Set on `role: 'judge'` rows so the UI can label per-judge contribution. */
  judgeAgentSlug?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /**
   * False when `getModel(modelId)` has no pricing data. The cost
   * contribution is $0 in that case; surface the unknown rather than
   * mask it.
   */
  pricingKnown: boolean;
}

export interface EvaluationCostEstimate {
  midUsd: number;
  lowUsd: number;
  highUsd: number;
  basedOn: 'empirical' | 'heuristic';
  /** Number of past runs that matched the fingerprint. */
  sampleSize: number;
  /** Cases in the dataset at estimate time. */
  caseCount: number;
  /** Per-call breakdown by model + role. Heuristic + empirical share the shape. */
  modelMix: EvaluationCostEstimateModel[];
  /** Short, plain-English note rendered in FieldHelp + the form footer. */
  notes: string;
}

export interface EstimateEvaluationRunCostInput {
  /**
   * Whether the subject is an agent or a workflow. Defaults to 'agent'
   * (the Phase 1 shape) when omitted so existing callers keep working.
   */
  subjectKind?: 'agent' | 'workflow';
  /** Subject agent id (the agent under test). Required when `subjectKind === 'agent'`. */
  agentId?: string;
  /** Subject workflow id. Required when `subjectKind === 'workflow'`. */
  workflowId?: string;
  /** Slugs of the judge agents (model graders) in this run, in any order. */
  judgeAgentSlugs: string[];
  /** Dataset id — drives `caseCount` and the fingerprint. */
  datasetId: string;
  /**
   * Caller's user id. Used to scope the past-runs query so the
   * empirical calibration only consumes the caller's own historical
   * runs — agents are shared across admins but `AiEvaluationRun.userId`
   * is the ownership column, and consuming another admin's past spend
   * here would leak their per-agent cost signal into this caller's
   * estimate. (The exposure is narrower than the
   * `seed-loader.loadFailureSeed` case — aggregate USD only, no case
   * content — but we treat the two consistently.)
   */
  userId: string;
  /**
   * Optional override for the case count. Useful in tests and for
   * preview-mode estimates against an in-progress dataset capture.
   * Defaults to the dataset's current row count.
   */
  caseCount?: number;
}

interface AgentSubjectShape {
  kind: 'agent';
  agentId: string;
  modelId: string;
}

interface WorkflowSubjectShape {
  kind: 'workflow';
  workflowId: string;
  shape: WorkflowShape;
}

type SubjectShape = AgentSubjectShape | WorkflowSubjectShape;

interface JudgeShape {
  agentSlug: string;
  modelId: string;
}

interface PastRunSummary {
  runId: string;
  casesDone: number;
  totalCostUsd: number;
}

export async function estimateEvaluationRunCost(
  input: EstimateEvaluationRunCostInput
): Promise<EvaluationCostEstimate> {
  const subjectKind = input.subjectKind ?? 'agent';
  const { judgeAgentSlugs, datasetId, userId } = input;

  if (subjectKind === 'agent' && !input.agentId) {
    throw new Error('estimateEvaluationRunCost: agentId is required when subjectKind=agent');
  }
  if (subjectKind === 'workflow' && !input.workflowId) {
    throw new Error('estimateEvaluationRunCost: workflowId is required when subjectKind=workflow');
  }

  // Warm the registry once. Both helpers are cached (24h / 60s) so the
  // network/DB cost is paid once per process, not per estimate.
  await Promise.allSettled([refreshFromOpenRouter(), hydrateModelRegistryFromDb()]);

  const chatDefaultModelId = (await getDefaultModelForTaskOrNull('chat')) ?? FALLBACK_MODEL_ID;

  const [subjectShape, judgeShapes, datasetMeta] = await Promise.all([
    subjectKind === 'agent'
      ? loadSubjectShape(input.agentId as string, chatDefaultModelId)
      : loadWorkflowSubjectShape(input.workflowId as string, chatDefaultModelId),
    loadJudgeShapes(judgeAgentSlugs, chatDefaultModelId),
    loadDatasetMeta(datasetId),
  ]);

  const caseCount = input.caseCount ?? datasetMeta.caseCount;

  let pastRuns: PastRunSummary[] = [];
  try {
    pastRuns = await loadMatchingPastRuns({
      subjectKind,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.workflowId ? { workflowId: input.workflowId } : {}),
      userId,
      judgeAgentSlugs,
      datasetContentHash: datasetMeta.contentHash,
    });
  } catch (err) {
    logger.warn('estimateEvaluationRunCost: past-runs query failed, falling back to heuristic', {
      subjectKind,
      agentId: input.agentId,
      workflowId: input.workflowId,
      datasetId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (pastRuns.length >= EMPIRICAL_MIN_SAMPLES && caseCount > 0) {
    return buildEmpiricalEstimate({
      pastRuns,
      caseCount,
      subjectShape,
      judgeShapes,
    });
  }

  return buildHeuristicEstimate({
    caseCount,
    subjectShape,
    judgeShapes,
    sampleSize: pastRuns.length,
  });
}

async function loadWorkflowSubjectShape(
  workflowId: string,
  chatDefault: string
): Promise<WorkflowSubjectShape> {
  const shape = await loadWorkflowShape(workflowId, chatDefault);
  return { kind: 'workflow', workflowId, shape };
}

function buildHeuristicEstimate(params: {
  caseCount: number;
  subjectShape: SubjectShape;
  judgeShapes: JudgeShape[];
  sampleSize: number;
}): EvaluationCostEstimate {
  const { caseCount, subjectShape, judgeShapes, sampleSize } = params;

  const modelMix: EvaluationCostEstimateModel[] = [];
  let midUsd = 0;

  if (caseCount > 0) {
    if (subjectShape.kind === 'agent') {
      const subjectInput = HEURISTIC.SUBJECT_INPUT_TOKENS_PER_CASE * caseCount;
      const subjectOutput = HEURISTIC.SUBJECT_OUTPUT_TOKENS_PER_CASE * caseCount;
      const subjectCost = priceTokens(subjectShape.modelId, subjectInput, subjectOutput);
      midUsd += subjectCost;
      modelMix.push({
        modelId: subjectShape.modelId,
        role: 'subject',
        inputTokens: subjectInput,
        outputTokens: subjectOutput,
        costUsd: subjectCost,
        pricingKnown: isModelPriced(subjectShape.modelId),
      });
    } else {
      // Workflow subject — union per-LLM-step tokens by resolved model.
      // Each workSteps entry already has its multiplier (agent_call × 3,
      // reflect × 2, etc.) baked in by `summariseShape`.
      const byModel = new Map<string, { input: number; output: number }>();
      for (const step of subjectShape.shape.workSteps) {
        const inputTokens =
          HEURISTIC.WORKFLOW_STEP_INPUT_TOKENS_PER_CASE * step.multiplier * caseCount;
        const outputTokens =
          HEURISTIC.WORKFLOW_STEP_OUTPUT_TOKENS_PER_CASE * step.multiplier * caseCount;
        const existing = byModel.get(step.modelId) ?? { input: 0, output: 0 };
        existing.input += inputTokens;
        existing.output += outputTokens;
        byModel.set(step.modelId, existing);
      }
      for (const [modelId, tokens] of byModel) {
        const cost = priceTokens(modelId, tokens.input, tokens.output);
        midUsd += cost;
        modelMix.push({
          modelId,
          role: 'subject',
          inputTokens: tokens.input,
          outputTokens: tokens.output,
          costUsd: cost,
          pricingKnown: isModelPriced(modelId),
        });
      }
    }

    for (const judge of judgeShapes) {
      const judgeInput = HEURISTIC.JUDGE_INPUT_TOKENS_PER_CASE * caseCount;
      const judgeOutput = HEURISTIC.JUDGE_OUTPUT_TOKENS_PER_CASE * caseCount;
      const judgeCost = priceTokens(judge.modelId, judgeInput, judgeOutput);
      midUsd += judgeCost;
      modelMix.push({
        modelId: judge.modelId,
        role: 'judge',
        judgeAgentSlug: judge.agentSlug,
        inputTokens: judgeInput,
        outputTokens: judgeOutput,
        costUsd: judgeCost,
        pricingKnown: isModelPriced(judge.modelId),
      });
    }
  }

  const notes = (() => {
    if (caseCount === 0) {
      return 'Dataset has no cases — estimate is $0 until cases are added.';
    }
    if (sampleSize === 0) {
      return `Heuristic estimate from ${caseCount} case${caseCount === 1 ? '' : 's'} × per-call token assumptions. Will tighten after 3 runs with the same agent + judges + dataset.`;
    }
    return `Only ${sampleSize} prior run${sampleSize === 1 ? '' : 's'} match the agent + judges + dataset — heuristic used until ${EMPIRICAL_MIN_SAMPLES}+ are available.`;
  })();

  return {
    midUsd,
    lowUsd: midUsd * HEURISTIC_LOW_MULT,
    highUsd: midUsd * HEURISTIC_HIGH_MULT,
    basedOn: 'heuristic',
    sampleSize,
    caseCount,
    modelMix,
    notes,
  };
}

function buildEmpiricalEstimate(params: {
  pastRuns: PastRunSummary[];
  caseCount: number;
  subjectShape: SubjectShape;
  judgeShapes: JudgeShape[];
}): EvaluationCostEstimate {
  const { pastRuns, caseCount, subjectShape, judgeShapes } = params;

  const perCaseCosts = pastRuns
    .filter((r) => r.casesDone > 0)
    .map((r) => r.totalCostUsd / r.casesDone);
  const perCaseMedian = median(perCaseCosts);
  const midUsd = perCaseMedian * caseCount;

  // Split midUsd back into a heuristic-shaped modelMix so the UI can
  // render per-model contributions. Empirical mode trusts the dollar
  // total but reuses heuristic token shape for the breakdown — the
  // alternative would be querying AiCostLog rows by run id, which
  // double-runs work for marginal UI gain.
  const heuristicSplit = buildHeuristicEstimate({
    caseCount,
    subjectShape,
    judgeShapes,
    sampleSize: pastRuns.length,
  });
  const heuristicTotal = heuristicSplit.midUsd;
  const scale = heuristicTotal > 0 ? midUsd / heuristicTotal : 0;
  const modelMix = heuristicSplit.modelMix.map((m) => ({
    ...m,
    costUsd: m.costUsd * scale,
  }));

  const rawSpread = relativeMad(perCaseCosts, perCaseMedian);
  const spread = Math.max(EMPIRICAL_RANGE_MIN, Math.min(rawSpread, EMPIRICAL_RANGE_MAX));

  return {
    midUsd,
    lowUsd: Math.max(0, midUsd * (1 - spread)),
    highUsd: midUsd * (1 + spread),
    basedOn: 'empirical',
    sampleSize: pastRuns.length,
    caseCount,
    modelMix,
    notes: `Calibrated from ${pastRuns.length} past run${pastRuns.length === 1 ? '' : 's'} with the same agent, judges, and dataset (median per-case cost × ${caseCount} case${caseCount === 1 ? '' : 's'}).`,
  };
}

async function loadSubjectShape(agentId: string, chatDefault: string): Promise<AgentSubjectShape> {
  try {
    const row = await prisma.aiAgent.findUnique({
      where: { id: agentId },
      select: { model: true },
    });
    const modelId = row?.model && row.model.length > 0 ? row.model : chatDefault;
    return { kind: 'agent', agentId, modelId };
  } catch (err) {
    logger.warn('estimateEvaluationRunCost: subject agent lookup failed', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'agent', agentId, modelId: chatDefault };
  }
}

async function loadJudgeShapes(slugs: string[], chatDefault: string): Promise<JudgeShape[]> {
  if (slugs.length === 0) return [];
  try {
    const rows = await prisma.aiAgent.findMany({
      where: { slug: { in: slugs } },
      select: { slug: true, model: true },
    });
    const bySlug = new Map(rows.map((r) => [r.slug, r.model] as const));
    return slugs.map((agentSlug) => {
      const m = bySlug.get(agentSlug);
      return {
        agentSlug,
        modelId: m && m.length > 0 ? m : chatDefault,
      };
    });
  } catch (err) {
    logger.warn('estimateEvaluationRunCost: judge agent lookup failed', {
      slugs,
      error: err instanceof Error ? err.message : String(err),
    });
    return slugs.map((agentSlug) => ({ agentSlug, modelId: chatDefault }));
  }
}

async function loadDatasetMeta(
  datasetId: string
): Promise<{ caseCount: number; contentHash: string | null }> {
  try {
    const dataset = await prisma.aiDataset.findUnique({
      where: { id: datasetId },
      select: { contentHash: true, caseCount: true },
    });
    if (!dataset) return { caseCount: 0, contentHash: null };
    return {
      caseCount: dataset.caseCount ?? 0,
      contentHash: dataset.contentHash ?? null,
    };
  } catch (err) {
    logger.warn('estimateEvaluationRunCost: dataset lookup failed', {
      datasetId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { caseCount: 0, contentHash: null };
  }
}

interface MetricConfigRow {
  slug?: unknown;
  config?: unknown;
}

/** Extract the sorted judge-agent slug list from a stored `metricConfigs` JSON. */
function extractJudgeSlugs(metricConfigs: unknown): string[] {
  if (!Array.isArray(metricConfigs)) return [];
  const slugs: string[] = [];
  for (const entry of metricConfigs as MetricConfigRow[]) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.slug !== 'judge_agent') continue;
    const cfg = entry.config;
    if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
      const agentSlug = (cfg as { agentSlug?: unknown }).agentSlug;
      if (typeof agentSlug === 'string' && agentSlug.length > 0) {
        slugs.push(agentSlug);
      }
    }
  }
  return slugs.sort();
}

async function loadMatchingPastRuns(params: {
  subjectKind: 'agent' | 'workflow';
  agentId?: string;
  workflowId?: string;
  userId: string;
  judgeAgentSlugs: string[];
  datasetContentHash: string | null;
}): Promise<PastRunSummary[]> {
  const { subjectKind, agentId, workflowId, userId, judgeAgentSlugs, datasetContentHash } = params;
  if (!datasetContentHash) return [];

  const candidates = await prisma.aiEvaluationRun.findMany({
    where: {
      userId,
      datasetContentHash,
      status: 'completed',
      subjectKind,
      ...(subjectKind === 'agent' && agentId ? { agentId } : {}),
      ...(subjectKind === 'workflow' && workflowId ? { workflowId } : {}),
    },
    select: {
      id: true,
      metricConfigs: true,
      totalCostUsd: true,
      progress: true,
    },
    orderBy: { completedAt: 'desc' },
    take: 50,
  });

  const wantedFingerprint = [...judgeAgentSlugs].sort().join(',');
  const summaries: PastRunSummary[] = [];
  for (const run of candidates) {
    const slugs = extractJudgeSlugs(run.metricConfigs);
    if (slugs.join(',') !== wantedFingerprint) continue;
    const casesDone = readCasesDone(run.progress);
    const cost = typeof run.totalCostUsd === 'number' ? run.totalCostUsd : 0;
    if (casesDone <= 0 || cost <= 0) continue;
    summaries.push({ runId: run.id, casesDone, totalCostUsd: cost });
  }
  return summaries;
}

function readCasesDone(progress: unknown): number {
  if (progress === null || typeof progress !== 'object' || Array.isArray(progress)) return 0;
  const value = (progress as Record<string, unknown>).casesDone;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

// ---------------------------------------------------------------------------
// Pricing helpers — duplicated from workflow-cost.ts deliberately. Each
// estimator is small enough to stay self-contained; a shared module
// would couple two unrelated change rhythms.
// ---------------------------------------------------------------------------

function priceTokens(modelId: string, inputTokens: number, outputTokens: number): number {
  const model = getModel(modelId);
  if (!model) return 0;
  return (
    (inputTokens / 1_000_000) * model.inputCostPerMillion +
    (outputTokens / 1_000_000) * model.outputCostPerMillion
  );
}

function isModelPriced(modelId: string): boolean {
  const m = getModel(modelId);
  if (!m) return false;
  return m.inputCostPerMillion > 0 || m.outputCostPerMillion > 0;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function relativeMad(values: number[], centre: number): number {
  if (values.length === 0 || centre === 0) return 0;
  const devs = values.map((v) => Math.abs(v - centre));
  return median(devs) / centre;
}
