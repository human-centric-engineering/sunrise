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
 * Ownership: the caller's own runs, plus system-owned runs (`userId = null`
 * — schedule- and inbound-triggered) where the authorization policy permits
 * an unattributed read, which a default install does. Another admin's own run
 * returns 404 (not 403) — we never confirm existence of a row the caller
 * cannot see.
 *
 * 403 if the provider-eligibility seam bars the provider the chat task
 * default resolves to — only when neither `modelOverride` nor
 * `EVALUATION_JUDGE_MODEL` supplied the model.
 *
 * Authentication: Admin role required.
 */

import { z } from 'zod';
import { Prisma } from '@prisma/client';

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { cuidSchema } from '@/lib/validations/common';
import {
  adminCanViewExecution,
  executionVisibilityWhere,
} from '@/lib/orchestration/access/execution-access';
import { executionTraceSchema } from '@/lib/validations/orchestration';
import {
  CostOperation,
  WorkflowStatus,
  type ExecutionTraceEntry,
  type SupervisorReport,
} from '@/types/orchestration';
import { calculateCost, logCost } from '@/lib/orchestration/llm/cost-tracker';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { hydrateFromDb as hydrateModelRegistryFromDb } from '@/lib/orchestration/llm/model-registry-db-hydrate';
import { getModel } from '@/lib/orchestration/llm/model-registry';
import { getDefaultModelForTask } from '@/lib/orchestration/llm/settings-resolver';
import {
  isProviderEligible,
  ProviderCallRefusedError,
} from '@/lib/orchestration/llm/provider-eligibility';
import { JUDGE_MODEL } from '@/lib/orchestration/evaluations/judge-model';
import { runSupervisorAssessment, type LlmCallShim } from '@/lib/orchestration/supervisor';
import {
  STORED_VERDICT_SELECT,
  withPriorArchived,
} from '@/lib/orchestration/supervisor/verdict-history';
import { withRunRowLocked } from '@/lib/orchestration/engine/run-row-lock';
import { findErasedSinceCopy, redactErased, toStoredJson } from '@/lib/privacy/run-recipients';

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

/**
 * The stored report's summary. Redaction keeps the report's shape, so it is
 * there; a report without one answers `[erased]` rather than the unredacted
 * summary.
 */
function summaryOf(report: SupervisorReport | Prisma.JsonValue): string {
  return typeof report === 'object' &&
    report !== null &&
    !Array.isArray(report) &&
    'summary' in report &&
    typeof report.summary === 'string'
    ? report.summary
    : '[erased]';
}

export const POST = withAdminAuth<{ id: string }>(
  async (request, session, { params }) => {
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
        err instanceof z.ZodError
          ? { _: err.issues.map((i) => i.message) }
          : { _: ['parse failed'] }
      );
    }

    // Before the read: the report is built from this copy of the run, and an
    // erasure during the model call below must still be taken out of it.
    const takenAt = new Date();
    const execution = await prisma.aiWorkflowExecution.findUnique({ where: { id } });
    if (!execution || !adminCanViewExecution(execution, session)) {
      throw new NotFoundError(`Execution ${id} not found`);
    }

    if (!TERMINAL_STATUSES.has(execution.status)) {
      throw new ConflictError(
        `Execution is ${execution.status}. Retroactive review is only available on terminal executions.`
      );
    }

    // Parse the persisted trace through the validator — drops noise.
    const trace = executionTraceSchema.parse(execution.executionTrace);
    // Webhook and API URLs are reduced inside runSupervisorAssessment (t-777).
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
    //
    // Held separately because the eligibility check below turns on WHICH arm
    // answered, not on what the model is.
    const operatorChoice = body.modelOverride ?? JUDGE_MODEL ?? null;
    const modelId = operatorChoice ?? (await getDefaultModelForTask('chat'));
    await hydrateModelRegistryFromDb();
    const modelInfo = getModel(modelId);
    if (!modelInfo) {
      throw new ValidationError('Unknown model', {
        modelOverride: [`Model "${modelId}" is not in the model registry`],
      });
    }

    // Provider eligibility, on the task-default arm only. A request's
    // `modelOverride` and the `EVALUATION_JUDGE_MODEL` env var are both an
    // operator's recorded choice — the same category as an explicit
    // `agent.provider`, which the seam also leaves alone. The third arm is
    // Sunrise choosing, and what it sends is the execution's own step outputs.
    if (operatorChoice === null) {
      const permitted = await isProviderEligible(modelInfo.provider, {
        task: 'chat',
        source: 'primary',
        primarySlug: null,
      });
      if (!permitted) {
        log.error('Retroactive review blocked: default model resolves to a barred provider', {
          executionId: id,
          modelId,
          providerSlug: modelInfo.provider,
          fix: 'This provider is not permitted: at TENANCY_MODE=multi, by the org’s approved providers (GET /api/v1/admin/orgs/[id]/providers); or by the rule registered via registerProviderEligibility() in lib/app/llm-providers.ts — by policy, or because it threw (a rule that cannot be evaluated denies). Point the chat task default at a permitted model, set EVALUATION_JUDGE_MODEL, pass modelOverride, or widen the rule.',
        });
        // 403 with its own code, matching the enrich-keywords route: the admin is
        // authorised and nothing is broken — the deployment's own policy bars the
        // provider the task default resolves to, and the remedy is a settings
        // change rather than a permission one.
        return errorResponse(
          `The default chat model "${modelId}" resolves to provider "${modelInfo.provider}", which is not permitted for retroactive review. Set EVALUATION_JUDGE_MODEL, pass an explicit modelOverride, or point the chat default at a permitted model.`,
          { code: 'provider_not_permitted', status: 403 }
        );
      }
    }

    // The call-time gate (§120 t-741) is told which arm answered, as above.
    const provider = await getProvider(modelInfo.provider, {
      task: 'chat',
      source: operatorChoice === null ? 'primary' : 'explicit',
      primarySlug: null,
    });

    // Provider-agnostic LLM shim. Bills cost per call as a side-effect;
    // the shared core treats this as opaque.
    const llmCall: LlmCallShim = async (prompt, opts) => {
      const response = await provider.chat([{ role: 'user', content: prompt }], {
        model: modelId,
        temperature: opts.temperature,
      });
      const cost = calculateCost(
        modelId,
        response.usage.inputTokens,
        response.usage.outputTokens,
        response.usage
      );
      void logCost({
        workflowExecutionId: id,
        userId: session.user.id,
        model: modelId,
        provider: modelInfo.provider,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cacheReadTokens: response.usage.cacheReadTokens,
        cacheWriteTokens: response.usage.cacheWriteTokens,
        serviceTier: response.usage.serviceTier,
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

    let assessment: Awaited<ReturnType<typeof runSupervisorAssessment>>;
    try {
      assessment = await runSupervisorAssessment({
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
    } catch (err) {
      // The call-time gate (§120 t-741) refused an operator-chosen judge — a
      // request `modelOverride` or `EVALUATION_JUDGE_MODEL`, which the check
      // above deliberately leaves to it. Same answer as that check gives the
      // task-default arm: a policy refusal, not a server fault. Provider errors
      // bubble out of the assessment unwrapped, so this is the error itself.
      if (err instanceof ProviderCallRefusedError) {
        // Only a POLICY refusal is the admin's to fix, by choosing another judge:
        // 403. One made for want of an org scope (at `multi`) would refuse every
        // model alike — a server fault, so it answers as one.
        if (err.reason === 'policy') {
          return errorResponse(
            `The judge model "${modelId}" resolves to provider "${modelInfo.provider}", which is not permitted for retroactive review. Choose a judge model on a permitted provider.`,
            { code: 'provider_not_permitted', status: 403 }
          );
        }
        log.error('Retroactive review judge call ran outside an org scope', { executionId: id });
        return errorResponse(
          'The review could not run: the judge call had no organisation scope.',
          {
            code: 'tenant_scope_missing',
            status: 500,
          }
        );
      }
      throw err;
    }

    // Written under the run's row lock (§122 t-901), with anyone erased since
    // the read above taken out of the report: the model call between the two
    // can take long enough for an erasure to land, and the report quotes the
    // run it read. By erasure's rule: an id wherever it appears, an address
    // only where it is a whole value, never inside the report's prose. The
    // lock orders this against an erasure, which redacts the report itself
    // under the same lock (t-882): a review written while an erasure is still
    // open waits for it and finds its receipt, or erasure reads what it wrote.
    // Confined as the read above was, so the owner layer sees a write it can
    // check: the row it returns is one this caller may read.
    const report = await withRunRowLocked(id, async (tx) => {
      // The prior verdict is read here, under the lock, not taken from the
      // read above: a second review of the run that overlapped this one may
      // have written since, and archiving the older copy would drop its
      // verdict from the history (t-925). The run itself must not have moved on
      // since the read the report was built from (code review): a retry-step
      // during the model call sets it back to pending and clears `completedAt`,
      // and a run that then finishes again stamps a new one — either way the
      // report would judge a trace that no longer exists. `updatedAt` is not
      // compared: an overlapping review moves it, and that one is archived.
      const prior = await tx.aiWorkflowExecution.findUnique({
        where: { id },
        select: { status: true, completedAt: true, ...STORED_VERDICT_SELECT },
      });
      if (!prior) throw new NotFoundError(`Execution ${id} not found`);
      if (
        prior.status !== execution.status ||
        prior.completedAt?.getTime() !== execution.completedAt?.getTime()
      ) {
        throw new ConflictError(
          'The execution was retried during the review; nothing was written. Review it again.'
        );
      }
      const finalReport = withPriorArchived(assessment.report, prior, id);
      const erased = await findErasedSinceCopy(tx, takenAt, [finalReport]);
      const stored = erased ? redactErased(toStoredJson(finalReport), erased) : finalReport;
      await tx.aiWorkflowExecution.update({
        where: { id, AND: [executionVisibilityWhere(session)] },
        data: {
          supervisorVerdict: finalReport.verdict,
          supervisorScore: finalReport.score,
          supervisorReport: stored as unknown as Prisma.InputJsonValue,
          supervisorReviewedAt: new Date(),
        },
      });
      return stored;
    });
    // What the caller gets is what was stored, redacted alike (code review).
    const summary = summaryOf(report);

    log.info('Retroactive supervisor review completed', {
      executionId: id,
      verdict: assessment.report.verdict,
      score: assessment.report.score,
      tokensUsed: assessment.tokensUsed,
      costUsd: assessment.costUsd,
    });

    return successResponse({
      verdict: assessment.report.verdict,
      score: assessment.report.score,
      summary,
      report,
      tokensUsed: assessment.tokensUsed,
      costUsd: assessment.costUsd,
    });
  },
  {
    tier: 'org',
    ownership: {
      decidedBy: 'self',
      because:
        "Acts only on executions this caller may see — their own, an ownerless (scheduled or inbound) run where the policy permits it, or one whose trace names them as an approver — keyed on the caller's id.",
    },
  }
);
