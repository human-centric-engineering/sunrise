/**
 * `supervisor` — neutral post-hoc audit of a workflow execution.
 *
 * Thin in-workflow wrapper around `runSupervisorAssessment` in
 * `@/lib/orchestration/supervisor`. The shared core handles prompt
 * building, JSON parsing + retry, citation validation, and
 * verdict-downgrade. This file owns the engine-side concerns: config
 * parsing, run-time toggle, `runLlmCall` plumbing, `failOnVerdict`
 * propagation, and the `contextPatch` write back to the row.
 *
 * Run-time toggle: when `respectRuntimeOptOut` is true (default) and
 * `ctx.inputData.__runSupervisor === false`, the step short-circuits
 * with `expectedSkip: true`. This is how the run dialog's "Run
 * supervisor" checkbox opts out per-execution without modifying the
 * template.
 *
 * **Dispatch cache**: the supervisor step does NOT participate in
 * `AiWorkflowStepDispatch` (it's an LLM call, same as `llm_call` /
 * `evaluate` / `guard` / `reflect` / `agent_call` / `plan` /
 * `orchestrator`). Only steps with external side-effects that
 * shouldn't double-act on crash recovery cache through dispatch
 * (`tool_call`, `external_call`, `send_notification`). The trade-off
 * for the supervisor is: a lease handoff mid-step can re-bill the
 * judge-model call. Acceptable because (a) lease windows are minutes,
 * supervisor takes seconds; (b) the verdict columns are written via
 * `contextPatch` only on a complete step result, so partial state is
 * impossible — the worst case is one extra LLM bill, never an
 * inconsistent row.
 *
 * Platform-agnostic: no Next.js imports.
 */

import type { StepResult, SupervisorReport, WorkflowStep } from '@/types/orchestration';
import { supervisorConfigSchema } from '@/lib/validations/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';
import { ExecutorError } from '@/lib/orchestration/engine/errors';
import { runLlmCall } from '@/lib/orchestration/engine/llm-runner';
import { registerStepType } from '@/lib/orchestration/engine/executor-registry';
import { JUDGE_MODEL } from '@/lib/orchestration/evaluations/judge-model';
import { runSupervisorAssessment, type LlmCallShim } from '@/lib/orchestration/supervisor';
import { logger } from '@/lib/logging';

export async function executeSupervisor(
  step: WorkflowStep,
  ctx: Readonly<ExecutionContext>
): Promise<StepResult> {
  const config = supervisorConfigSchema.parse(step.config);

  // Run-time toggle — first action so the executor never bills the
  // judge-model when the operator explicitly opted out at trigger time.
  //
  // **Strict `=== false` is intentional.** Only the literal boolean
  // `false` opts out. Absent / undefined / null / string "false" / 0
  // all run the supervisor. This is safe-by-default: an external
  // caller (webhook, MCP, API client) passing the wrong type doesn't
  // accidentally suppress an audit — it gets one. Operators who genuinely
  // want to skip from a non-dialog trigger must explicitly send
  // `{ "__runSupervisor": false }` (boolean) in their payload.
  const respectOptOut = config.respectRuntimeOptOut ?? true;
  if (respectOptOut && ctx.inputData.__runSupervisor === false) {
    logger.info('supervisor skipped — __runSupervisor=false', {
      executionId: ctx.executionId,
      stepId: step.id,
    });
    // Set BOTH `output.reason` (for programmatic consumers reading
    // step outputs) AND top-level `skipError` (which the engine
    // promotes onto the trace entry's `error` field — the trace UI
    // reads `entry.error` and otherwise shows "no reason captured").
    const reason = 'supervisor disabled at trigger time';
    return {
      output: { skipped: true, reason },
      tokensUsed: 0,
      costUsd: 0,
      skipped: true,
      skipError: reason,
      expectedSkip: true,
    };
  }

  // Model resolution: explicit step config > JUDGE_MODEL env var > undefined.
  // When `modelOverride` is undefined, `runLlmCall` falls through to
  // `getDefaultModelForTask('chat')` — the same path every other LLM step
  // takes. This means a deployment with no Anthropic provider (e.g.
  // OpenAI-only, OpenRouter, Ollama) gets a working supervisor automatically;
  // the "independent judge ≥ subject" promise is best-effort and only fully
  // realised when EVALUATION_JUDGE_MODEL is explicitly set to a stronger
  // model than the workflow's primary chat model.
  const useJudgeModel = config.useJudgeModel ?? true;
  const modelOverride =
    config.modelOverride && config.modelOverride.length > 0
      ? config.modelOverride
      : useJudgeModel && JUDGE_MODEL !== null
        ? JUDGE_MODEL
        : undefined;

  // Engine-side LLM shim — bills cost, surfaces telemetry, forwards
  // the cancellation signal. The shared core treats it as opaque.
  // `reasoningEffort` is captured from the step config in closure scope
  // rather than threaded through the shim's `opts` contract — the
  // supervisor's internal callers don't know about reasoning effort,
  // but the step author does, and the step's setting should apply to
  // every LLM call the supervisor makes.
  const llmCall: LlmCallShim = async (prompt, opts) => {
    const result = await runLlmCall(ctx, {
      stepId: step.id,
      prompt,
      modelOverride,
      temperature: opts.temperature,
      reasoningEffort: config.reasoningEffort ?? undefined,
    });
    return { content: result.content, tokensUsed: result.tokensUsed, costUsd: result.costUsd };
  };

  let assessment;
  try {
    assessment = await runSupervisorAssessment({
      stepOutputs: ctx.stepOutputs,
      // outputData is only set at finalize; supervisor sees null for
      // in-workflow runs unless the workflow's mid-flow step already
      // wrote a synthetic outputData via stepOutputs.
      inputData: ctx.inputData,
      outputData: null,
      workflowId: ctx.workflowId,
      executionId: ctx.executionId,
      assessmentCriteria: config.assessmentCriteria,
      redTeamPrompts: config.redTeamPrompts,
      requireEvidenceCitations: config.requireEvidenceCitations ?? true,
      minWeaknesses: config.minWeaknesses ?? 1,
      includeStepOutputs: config.includeStepOutputs ?? 'auto',
      temperature: config.temperature ?? 0.2,
      llmCall,
      triggeredBy: 'in_workflow',
    });
  } catch (err) {
    throw err instanceof ExecutorError
      ? err
      : new ExecutorError(
          step.id,
          'supervisor_llm_failed',
          err instanceof Error ? err.message : 'supervisor LLM call failed',
          err
        );
  }

  const finalReport = assessment.report;
  const failOnVerdict = config.failOnVerdict ?? 'never';

  // failOnVerdict=fail throws ExecutorError; engine's errorStrategy decides
  // (default 'fail' terminates workflow, 'skip' continues, 'fallback' routes).
  if (failOnVerdict === 'fail' && finalReport.verdict === 'fail') {
    throw new ExecutorError(
      step.id,
      'supervisor_verdict_fail',
      `Supervisor verdict is 'fail': ${finalReport.summary.slice(0, 200)}`
    );
  }

  return {
    output: finalReport,
    tokensUsed: assessment.tokensUsed,
    costUsd: assessment.costUsd,
    contextPatch: buildVerdictContextPatch(finalReport),
  };
}

/**
 * Build the column-patch object lifted into the next checkpoint /
 * finalize write. Kept here (not in the engine) so the engine doesn't
 * grow knowledge of supervisor semantics — the engine's allowlist is
 * the gate; the executor decides what to publish.
 */
function buildVerdictContextPatch(report: SupervisorReport): Record<string, unknown> {
  return {
    supervisorVerdict: report.verdict,
    supervisorScore: report.score,
    supervisorReport: report,
    supervisorReviewedAt: new Date(),
  };
}

registerStepType('supervisor', executeSupervisor);

// ─── Testing-only exports ───────────────────────────────────────────────────
// Kept for backwards compatibility with the existing test file — those
// helpers now live in `@/lib/orchestration/supervisor`. New tests should
// import directly from there.
export {
  sampleString,
  serialiseStepOutput,
  buildProjection,
  buildPrompt,
  tryParse,
  validateCitations,
  reportShapeSchema,
} from '@/lib/orchestration/supervisor';
import {
  sampleString as _sampleString,
  serialiseStepOutput as _serialise,
  buildProjection as _build,
  buildPrompt as _bp,
  tryParse as _tp,
  validateCitations as _vc,
  reportShapeSchema as _rss,
} from '@/lib/orchestration/supervisor';
export const __test__ = {
  sampleString: _sampleString,
  serialiseStepOutput: _serialise,
  buildProjection: (
    ctx: { stepOutputs: Record<string, unknown> },
    mode: 'auto' | 'all' | 'terminal-only'
  ): ReturnType<typeof _build> => _build(ctx.stepOutputs, mode),
  buildPrompt: _bp,
  tryParse: _tp,
  validateCitations: _vc,
  reportShapeSchema: _rss,
};
