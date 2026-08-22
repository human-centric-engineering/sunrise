/**
 * `judge_call` — drive an evaluation judge agent inline as a workflow
 * step. Unlocks QA gates, self-review loops, multi-judge approval, and
 * cost-aware routing — patterns that need a structured `{score,reasoning}`
 * verdict mid-workflow without going through the batch evaluation runner.
 *
 * Config:
 *   - `judgeAgentSlug: string`      — `AiAgent.slug` with `kind='judge'`.
 *   - `question: string`             — the QUESTION payload (template-interpolated).
 *   - `answer: string`               — the ANSWER payload (template-interpolated).
 *   - `expectedOutput?: string`      — optional reference answer (template-interpolated).
 *   - `subjectBrandVoice?: string`   — only honoured by `eval-judge-brand-voice`.
 *
 * Template syntax (`{{stepId.output}}`, `{{input.foo}}`, `{{previous.output}}`)
 * is supported on every string field so a judge can score a prior
 * step's output without the workflow author having to glue the prompt
 * together by hand.
 *
 * Output: `{ score: number | null, reasoning: string, evaluationSteps?: string[],
 *           passed: boolean, threshold: number | null }`.
 * `passed` is `true` when no threshold is set, or when `score >= threshold`.
 * The boolean is the natural anchor for `route` step branching ("publish
 * if passed, escalate otherwise"). Workflows that want to branch on the
 * raw score string-match `{{<this-step-id>.output.score}}` in their
 * route conditions.
 *
 * Cost: the judge call writes one `AiCostLog` row attributed to the judge
 * agent, and `ctx.costLogMetadata` is forwarded so an evaluation run's tags
 * reach it.
 *
 * **The row carries no `workflowExecutionId` and no `stepId`**, because it is
 * written by the streaming chat handler rather than by an executor, and that
 * handler sets neither. So the judge's spend does not appear against this step
 * in the execution panels and `loadPastRuns` cannot attribute it. The step
 * total is still correct — `StepResult.costUsd` carries it — but by a
 * different mechanism than the one an earlier version of this comment named.
 * Recorded as a known exception in `.context/orchestration/capabilities.md`
 * rather than fixed here: making it true means the chat handler accepting an
 * execution link, which is a wider change than #600.
 */

import type { StepResult, WorkflowStep } from '@/types/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';
import { ExecutorError } from '@/lib/orchestration/engine/errors';
import { registerStepType } from '@/lib/orchestration/engine/executor-registry';
import { interpolatePrompt } from '@/lib/orchestration/engine/interpolate-prompt';
import { driveJudgeAgent } from '@/lib/orchestration/evaluations/judge-driver';
import { judgeCallConfigSchema } from '@/lib/validations/orchestration';

export async function executeJudgeCall(
  step: WorkflowStep,
  ctx: Readonly<ExecutionContext>
): Promise<StepResult> {
  const config = judgeCallConfigSchema.parse(step.config);

  const judgeAgentSlug = config.judgeAgentSlug.trim();
  if (judgeAgentSlug.length === 0) {
    throw new ExecutorError(
      step.id,
      'missing_judge_agent_slug',
      'judge_call step is missing a judgeAgentSlug'
    );
  }

  // The judge runs through `streamChat`, whose `ChatRequest.userId` is
  // required: it scopes the judge conversation, its history, and its memory
  // to an account. There is no account behind a system-owned run, and
  // borrowing the schedule's or trigger's author would file a judge
  // transcript — which quotes the material under review, up to and including
  // a third party's inbound message — into that person's own chat history.
  // So this step is unavailable to system-owned runs rather than
  // approximated; a typed error beats a plausible mis-attribution.
  //
  // Since #502 that means every scheduled and inbound run, not just the rare
  // no-user invocation. Put `judge_call` in a workflow started by an admin,
  // or grade after the fact through the evaluations surface.
  if (ctx.userId === null) {
    throw new ExecutorError(
      step.id,
      'judge_call_requires_user_context',
      'judge_call needs a user-scoped execution context. Schedule- and inbound-triggered runs are system-owned (no userId), so they cannot use this step.'
    );
  }

  // Template-interpolate every string field so a workflow author can
  // pull values out of prior step outputs without external glue.
  // `interpolatePrompt` returns the empty string for missing refs —
  // matches the engine-wide template behaviour.
  const question = interpolatePrompt(config.question, ctx);
  const answer = interpolatePrompt(config.answer, ctx);
  const expectedOutput =
    typeof config.expectedOutput === 'string'
      ? interpolatePrompt(config.expectedOutput, ctx)
      : undefined;
  const subjectBrandVoice =
    typeof config.subjectBrandVoice === 'string'
      ? interpolatePrompt(config.subjectBrandVoice, ctx)
      : undefined;

  const result = await driveJudgeAgent({
    agentSlug: judgeAgentSlug,
    userId: ctx.userId,
    question,
    answer,
    ...(expectedOutput && expectedOutput.length > 0 ? { expectedOutput } : {}),
    ...(subjectBrandVoice && subjectBrandVoice.length > 0 ? { subjectBrandVoice } : {}),
    // Forward the carrier. The comment that used to sit here said the
    // opposite — that `ExecuteOptions.costLogMetadata` "already tags every
    // cost row via the executors' merged metadata" — and it was wrong in a way
    // that stopped anyone looking: `driveJudgeAgent` does not log through an
    // executor at all. It goes to `drainStreamChat` → the streaming chat
    // handler, whose `logCost` calls tag from `request.costLogMetadata` only.
    // So evaluating a workflow with a `judge_call` step tagged every other
    // step's rows and left the judge's untagged (#600).
    // `role` is overridden, not inherited. A subject workflow's execution is
    // stamped `role: 'subject'` (`run-cases/workflow-case.ts`), and forwarding
    // that wholesale would tag the JUDGE agent's chat rows as subject spend —
    // so the first role-based split of evaluation cost would bill the judge to
    // the thing it was judging. Every other judge path sets `role: 'judge'`
    // explicitly for this same `driveJudgeAgent` call; this one now matches.
    ...(ctx.costLogMetadata ? { costLogMetadata: { ...ctx.costLogMetadata, role: 'judge' } } : {}),
  });

  const threshold = typeof config.threshold === 'number' ? config.threshold : null;
  const passed =
    typeof result.score === 'number' && threshold !== null ? result.score >= threshold : true;

  const output: Record<string, unknown> = {
    score: result.score,
    reasoning: result.reasoning,
    passed,
    threshold,
    judgeAgentSlug,
  };
  if (result.evaluationSteps && result.evaluationSteps.length > 0) {
    output.evaluationSteps = result.evaluationSteps;
  }
  if (result.errorCode) {
    output.errorCode = result.errorCode;
  }

  return {
    output,
    tokensUsed: result.tokenUsage.input + result.tokenUsage.output,
    costUsd: result.costUsd,
  };
}

registerStepType('judge_call', executeJudgeCall);
