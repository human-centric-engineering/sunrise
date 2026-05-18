/**
 * Admin Orchestration — Retroactive supervisor review
 *
 * POST /api/v1/admin/orchestration/executions/:id/review
 *
 * Audits a completed (or failed) execution after the fact. The
 * operator's path when:
 *  - the workflow template doesn't include a `supervisor` step,
 *  - the operator skipped the supervisor at trigger time
 *    (`inputData.__runSupervisor: false`), or
 *  - the operator wants a fresh verdict on a previously-supervised run.
 *
 * Loads the persisted `executionTrace`, reconstructs the
 * `stepOutputs` map keyed by step id, runs the shared
 * `runSupervisorAssessment` core (same prompt + citation validator as
 * the in-workflow path), writes the four supervisor columns, and
 * archives any prior verdict into `supervisorReport.previousVerdicts[]`
 * with `triggeredBy: 'in_workflow' | 'retroactive'`.
 *
 * Ownership: rows are scoped to `session.user.id`. Cross-user access
 * returns 404.
 *
 * Authentication: Admin role required.
 */

import { z } from 'zod';

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { logger } from '@/lib/logging';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { cuidSchema } from '@/lib/validations/common';
import { executionTraceSchema } from '@/lib/validations/orchestration';
import {
  CostOperation,
  WorkflowStatus,
  type ExecutionTraceEntry,
  type SupervisorPreviousVerdict,
  type SupervisorReport,
} from '@/types/orchestration';

/**
 * Narrow schema for the fields we read off a *prior* supervisor report
 * when archiving it into `previousVerdicts[]`. Validates only what's
 * lifted onto the new report — verdict, score, triggeredBy, and the
 * nested `previousVerdicts[]` chain — so a corrupted or hand-edited
 * Json column doesn't crash the rerun. We don't validate the whole
 * SupervisorReport shape here because the new report is freshly built
 * by `runSupervisorAssessment` (already type-safe) and the read path
 * only touches these fields.
 */
const supervisorVerdictEnum = z.enum(['pass', 'concerns', 'fail', 'inconclusive']);
const supervisorTriggeredByEnum = z.enum(['in_workflow', 'retroactive']);
const supervisorPreviousVerdictSchema = z.object({
  verdict: supervisorVerdictEnum,
  score: z.number().nullable(),
  reviewedAt: z.string(),
  triggeredBy: supervisorTriggeredByEnum,
});
const priorSupervisorReportSchema = z.object({
  verdict: supervisorVerdictEnum,
  // `score` is permissive so a benign type drift (e.g. score stored as a
  // string by an older writer) doesn't reject the whole archive. The
  // downstream `typeof prior.score === 'number'` guard handles the cast.
  score: z.unknown().optional(),
  triggeredBy: supervisorTriggeredByEnum.optional(),
  previousVerdicts: z.array(supervisorPreviousVerdictSchema).optional(),
});
import { calculateCost, logCost } from '@/lib/orchestration/llm/cost-tracker';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { getModel } from '@/lib/orchestration/llm/model-registry';
import { getDefaultModelForTask } from '@/lib/orchestration/llm/settings-resolver';
import { JUDGE_MODEL } from '@/lib/orchestration/evaluations/judge-model';
import { runSupervisorAssessment, type LlmCallShim } from '@/lib/orchestration/supervisor';

const TERMINAL_STATUSES = new Set<string>([
  WorkflowStatus.COMPLETED,
  WorkflowStatus.FAILED,
  WorkflowStatus.CANCELLED,
]);

const DEFAULT_ASSESSMENT_CRITERIA = [
  'Did the workflow accomplish its stated objective?',
  'Are step outputs internally consistent — does step N reference step N-1 truthfully?',
  'Did any step fail unexpectedly (status: failed) or skip without expectedSkip=true?',
  'Did the terminal output reflect what the trace actually shows happened, or is it optimistic?',
  'If the workflow ended in error / cancelled, is the cause traceable to a specific step?',
].join('\n');

const reviewBodySchema = z.object({
  /** Optional override of the rubric. Defaults to a generic one. */
  assessmentCriteria: z.string().min(1).max(8000).optional(),
  /** Optional extra red-team prompts to append to the defaults. */
  redTeamPrompts: z.array(z.string().min(1).max(500)).max(20).optional(),
  /** Force a particular model. Otherwise the configured JUDGE_MODEL is used. */
  modelOverride: z.string().min(1).max(200).optional(),
  /** Truncation strategy hint. Defaults to 'auto'. */
  includeStepOutputs: z.enum(['auto', 'all', 'terminal-only']).optional(),
  /** Citation-validator floor. Defaults to 1. */
  minWeaknesses: z.number().int().min(0).max(20).optional(),
});

/**
 * Rebuild `stepOutputs` (step.id → output) from the persisted trace.
 * `executionTrace` carries one entry per step; we keep only completed
 * steps' outputs because skipped/awaiting entries don't have a
 * defensible output to cite.
 */
function stepOutputsFromTrace(trace: ExecutionTraceEntry[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const entry of trace) {
    if (entry.status === 'completed' && entry.output !== undefined) {
      out[entry.stepId] = entry.output;
    }
  }
  return out;
}

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsedId = cuidSchema.safeParse(rawId);
  if (!parsedId.success) {
    throw new ValidationError('Invalid execution id', { id: ['Must be a valid CUID'] });
  }
  const id = parsedId.data;

  // Parse the body (empty body is fine — all fields are optional).
  let body: z.infer<typeof reviewBodySchema>;
  try {
    const raw = (await request.json().catch(() => ({}))) as unknown;
    body = reviewBodySchema.parse(raw);
  } catch (err) {
    throw new ValidationError(
      'Invalid request body',
      err instanceof z.ZodError ? { _: err.issues.map((i) => i.message) } : { _: ['parse failed'] }
    );
  }

  const execution = await prisma.aiWorkflowExecution.findUnique({ where: { id } });
  if (!execution || execution.userId !== session.user.id) {
    throw new NotFoundError(`Execution ${id} not found`);
  }

  if (!TERMINAL_STATUSES.has(execution.status)) {
    throw new ConflictError(
      `Execution is ${execution.status}. Retroactive review is only available on terminal executions.`
    );
  }

  // Parse the persisted trace through the validator — drops noise.
  const trace = executionTraceSchema.parse(execution.executionTrace);
  const stepOutputs = stepOutputsFromTrace(trace);

  if (Object.keys(stepOutputs).length === 0) {
    throw new ConflictError(
      'Execution trace contains no completed steps to review — there is nothing for the supervisor to audit. This usually means the workflow failed before any step could complete (validation error, immediate budget exhaustion, etc.).'
    );
  }

  // Resolve the judge model + provider.
  // Priority: explicit body override > EVALUATION_JUDGE_MODEL env > system
  // default chat model. The final fallback ensures a deployment with no
  // Anthropic provider (the previous hard-coded default) still gets a
  // working retroactive review using whatever the operator configured.
  const modelId = body.modelOverride ?? JUDGE_MODEL ?? (await getDefaultModelForTask('chat'));
  const modelInfo = getModel(modelId);
  if (!modelInfo) {
    throw new ValidationError('Unknown model', {
      modelOverride: [`Model "${modelId}" is not in the model registry`],
    });
  }
  const provider = await getProvider(modelInfo.provider);

  // Provider-agnostic LLM shim. Bills cost per call as a side-effect;
  // the shared core treats this as opaque.
  const llmCall: LlmCallShim = async (prompt, opts) => {
    const response = await provider.chat([{ role: 'user', content: prompt }], {
      model: modelId,
      temperature: opts.temperature,
    });
    const cost = calculateCost(modelId, response.usage.inputTokens, response.usage.outputTokens);
    void logCost({
      workflowExecutionId: id,
      model: modelId,
      provider: modelInfo.provider,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      operation: CostOperation.EVALUATION,
      isLocal: cost.isLocal,
      metadata: { phase: 'retroactive_supervisor' },
    }).catch((err: unknown) => {
      log.warn('retroactive supervisor: cost log failed', {
        executionId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return {
      content: response.content,
      tokensUsed: response.usage.inputTokens + response.usage.outputTokens,
      costUsd: cost.totalCostUsd,
    };
  };

  const assessment = await runSupervisorAssessment({
    stepOutputs,
    inputData: execution.inputData,
    outputData: execution.outputData,
    workflowId: execution.workflowId,
    executionId: id,
    assessmentCriteria: body.assessmentCriteria ?? DEFAULT_ASSESSMENT_CRITERIA,
    redTeamPrompts: body.redTeamPrompts,
    requireEvidenceCitations: true,
    minWeaknesses: body.minWeaknesses ?? 1,
    includeStepOutputs: body.includeStepOutputs ?? 'auto',
    temperature: 0.2,
    llmCall,
    triggeredBy: 'retroactive',
  });

  // Archive any prior verdict into supervisorReport.previousVerdicts[] —
  // operators rerun for a reason; overwriting silently would discard the
  // history they want to compare against. Validate the prior column
  // shape so a corrupted Json row can't break the archive lift; on
  // parse failure we log and skip the archive rather than fail the
  // rerun (the new verdict still writes through cleanly).
  const finalReport: SupervisorReport = { ...assessment.report };
  if (execution.supervisorVerdict && execution.supervisorReport) {
    const priorParsed = priorSupervisorReportSchema.safeParse(execution.supervisorReport);
    if (priorParsed.success) {
      const prior = priorParsed.data;
      const priorEntry: SupervisorPreviousVerdict = {
        verdict: prior.verdict,
        score: typeof prior.score === 'number' ? prior.score : null,
        reviewedAt: execution.supervisorReviewedAt?.toISOString() ?? new Date(0).toISOString(),
        triggeredBy: prior.triggeredBy ?? 'in_workflow',
      };
      const existing = prior.previousVerdicts ?? [];
      finalReport.previousVerdicts = [...existing, priorEntry];
    } else {
      logger.warn('Prior supervisorReport failed schema validation — archive skipped', {
        executionId: id,
        issues: priorParsed.error.issues.map((i) => i.message),
      });
    }
  }

  await prisma.aiWorkflowExecution.update({
    where: { id },
    data: {
      supervisorVerdict: finalReport.verdict,
      supervisorScore: finalReport.score,
      supervisorReport: finalReport as unknown as object,
      supervisorReviewedAt: new Date(),
    },
  });

  log.info('Retroactive supervisor review completed', {
    executionId: id,
    verdict: finalReport.verdict,
    score: finalReport.score,
    tokensUsed: assessment.tokensUsed,
    costUsd: assessment.costUsd,
  });

  return successResponse({
    verdict: finalReport.verdict,
    score: finalReport.score,
    summary: finalReport.summary,
    report: finalReport,
    tokensUsed: assessment.tokensUsed,
    costUsd: assessment.costUsd,
  });
});
