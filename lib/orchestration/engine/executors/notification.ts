/**
 * `send_notification` — Send email or webhook notifications from a workflow.
 *
 * Config:
 *   - `channel: 'email' | 'webhook'` — notification channel.
 *   - `to: string | string[]` — email recipients. Each may be a literal address
 *     or a `{{…}}` template resolved per run (e.g. `{{input.userEmail}}`); the
 *     resolved value is validated as an email at runtime.
 *   - `subject?: string` — email subject (required for email channel).
 *   - `bodyTemplate: string` — message body with `{{input}}` interpolation.
 *   - `webhookUrl?: string` — target URL (required for webhook channel).
 *
 * Supports `{{input}}` / `{{input.<key>}}` and `{{<stepId>.output}}` template
 * variables in `to`, `subject`, and `bodyTemplate`.
 */

import { z } from 'zod';
import type { StepResult, WorkflowStep } from '@/types/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';
import {
  buildIdempotencyKey,
  lookupDispatch,
  recordDispatch,
} from '@/lib/orchestration/engine/dispatch-cache';
import { ExecutorError } from '@/lib/orchestration/engine/errors';
import { interpolatePrompt } from '@/lib/orchestration/engine/llm-runner';
import { registerStepType } from '@/lib/orchestration/engine/executor-registry';
import { sendEmail } from '@/lib/email/send';
import { dispatchWebhookEvent } from '@/lib/orchestration/webhooks/dispatcher';
import { logger } from '@/lib/logging';
import { WorkflowNotification } from '@/emails/workflow-notification';
import { notificationToSchema } from '@/lib/validations/orchestration';

// ─── Config schema ──────────────────────────────────────────────────────────

/**
 * Opt-in terminal status. When set to `'failed'`, the executor returns a
 * StepResult with `failWorkflow` populated — the engine then marks the
 * workflow as FAILED with the interpolated body as the reason. Use for
 * fail-branch tail steps that send a notification AND want the workflow's
 * final status to reflect the underlying problem (e.g. the
 * `report_validation_failure` step in the provider-model-audit template).
 *
 * Default behaviour (unset) leaves status routing to the normal DAG-walk
 * completion logic — the step is just a side effect.
 */
const terminalStatusSchema = z.enum(['completed', 'failed']).optional();

const notificationConfigSchema = z.discriminatedUnion('channel', [
  z.object({
    channel: z.literal('email'),
    // `to` may be a literal email OR a `{{…}}` template resolved per run — the
    // resolved value is validated as an email at runtime (see `resolveRecipients`
    // below). Shared with the design-time schema so validation can't drift.
    to: notificationToSchema,
    subject: z.string().min(1).max(200),
    bodyTemplate: z.string().min(1).max(10_000),
    terminalStatus: terminalStatusSchema,
  }),
  z.object({
    channel: z.literal('webhook'),
    webhookUrl: z.string().url(),
    bodyTemplate: z.string().min(1).max(10_000),
    terminalStatus: terminalStatusSchema,
  }),
]);

/** Max length of the failure reason carried to `errorMessage` / the
 * `workflow_failed` event. The bodyTemplate can be a multi-paragraph
 * email; truncate so the column / event payload stays bounded. */
const FAILURE_REASON_MAX = 2000;

function deriveFailureReason(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) return 'Workflow terminated by send_notification (no body)';
  if (trimmed.length <= FAILURE_REASON_MAX) return trimmed;
  return `${trimmed.slice(0, FAILURE_REASON_MAX - 1).trimEnd()}…`;
}

/**
 * Resolve the email recipient(s) for this run: interpolate each address the
 * same way `subject`/`bodyTemplate` are, then validate the *resolved* value is
 * a well-formed email. A literal `to` interpolates to itself and validates
 * exactly as before; a `{{…}}` template (e.g. `{{input.userEmail}}`) is
 * resolved per run. The single-vs-array shape is preserved so `sendEmail`
 * receives the same type a literal config would produce today.
 *
 * A recipient that doesn't resolve to a valid email throws a non-retriable
 * `ExecutorError` — a bad address won't fix itself on retry, and re-sending is
 * pointless (the caller's error strategy still applies).
 */
function resolveRecipients(
  to: string | string[],
  ctx: Readonly<ExecutionContext>,
  stepId: string
): string | string[] {
  const resolveOne = (raw: string): string => {
    const resolved = interpolatePrompt(raw, ctx, stepId).trim();
    if (!z.string().email().safeParse(resolved).success) {
      throw new ExecutorError(
        stepId,
        'INVALID_RECIPIENT',
        `Notification recipient "${raw}" resolved to "${resolved}", which is not a valid email address`,
        undefined,
        false
      );
    }
    return resolved;
  };

  return Array.isArray(to) ? to.map(resolveOne) : resolveOne(to);
}

// ─── Executor ───────────────────────────────────────────────────────────────

async function executeNotification(
  step: WorkflowStep,
  ctx: Readonly<ExecutionContext>
): Promise<StepResult> {
  // Crash-safe re-run: if a prior attempt of this step already sent the
  // email/webhook and recorded its result, return the cached StepResult and
  // skip re-firing. The cache key is `${executionId}:${stepId}`. See
  // `lib/orchestration/engine/dispatch-cache.ts`.
  //
  // Posture symmetry with `recordDispatch`: a transient DB hiccup at lookup
  // time is treated as a cache miss (warn-and-continue), matching the
  // post-send recordDispatch failure handling.
  const cacheKey = buildIdempotencyKey({ executionId: ctx.executionId, stepId: step.id });
  let cached: StepResult | null = null;
  try {
    cached = await lookupDispatch<StepResult>(cacheKey);
  } catch (err) {
    logger.warn('Notification step: dispatch cache lookup failed; treating as miss', {
      stepId: step.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (cached !== null) {
    logger.info('Notification step: dispatch cache hit, skipping send', {
      stepId: step.id,
    });
    return cached;
  }

  const parsed = notificationConfigSchema.safeParse(step.config);
  if (!parsed.success) {
    throw new ExecutorError(
      step.id,
      'INVALID_CONFIG',
      `Invalid notification config: ${parsed.error.issues.map((i) => i.message).join('; ')}`
    );
  }

  const config = parsed.data;
  const body = interpolatePrompt(config.bodyTemplate, ctx, step.id);
  const workflowName = (ctx.variables.workflowName as string) ?? 'Workflow';

  let stepResult: StepResult;

  if (config.channel === 'email') {
    // Interpolate + validate the recipient(s) before any send. Throws a
    // non-retriable ExecutorError if a resolved address isn't a valid email.
    const to = resolveRecipients(config.to, ctx, step.id);
    try {
      const result = await sendEmail({
        to,
        subject: interpolatePrompt(config.subject, ctx, step.id),
        react: WorkflowNotification({ body, workflowName }),
      });

      if (result.status === 'failed') {
        throw new ExecutorError(
          step.id,
          'EMAIL_SEND_FAILED',
          `Email send failed: ${result.error}`,
          undefined,
          true
        );
      }

      logger.info('Notification step: email sent', {
        stepId: step.id,
        to,
        status: result.status,
      });

      stepResult = {
        output: { sent: true, channel: 'email', status: result.status },
        tokensUsed: 0,
        costUsd: 0,
      };
    } catch (err) {
      if (err instanceof ExecutorError) throw err;
      throw new ExecutorError(
        step.id,
        'EMAIL_DELIVERY_ERROR',
        `Email delivery error: ${err instanceof Error ? err.message : String(err)}`,
        err,
        true
      );
    }
  } else {
    // Webhook channel
    try {
      await dispatchWebhookEvent('workflow_notification', {
        webhookUrl: config.webhookUrl,
        body,
        workflowId: ctx.workflowId,
        workflowName,
        executionId: ctx.executionId,
        stepId: step.id,
      });

      logger.info('Notification step: webhook dispatched', {
        stepId: step.id,
        webhookUrl: config.webhookUrl,
      });

      stepResult = {
        output: { sent: true, channel: 'webhook', url: config.webhookUrl },
        tokensUsed: 0,
        costUsd: 0,
      };
    } catch (err) {
      throw new ExecutorError(
        step.id,
        'WEBHOOK_DISPATCH_ERROR',
        `Webhook dispatch error: ${err instanceof Error ? err.message : String(err)}`,
        err,
        true
      );
    }
  }

  // Opt-in: terminal-with-failure. When the workflow author marked this
  // step as a fail-branch tail (e.g. provider-audit's
  // `report_validation_failure`), populate `failWorkflow` so the engine
  // finalises the execution as FAILED with the interpolated body as the
  // visible reason. Without this, a tail-end notification leaves the
  // workflow marked COMPLETED — misleading for fail-branches.
  if (config.terminalStatus === 'failed') {
    stepResult = {
      ...stepResult,
      failWorkflow: deriveFailureReason(body),
    };
  }

  // Record the dispatch so a re-drive after a crash returns the cached result.
  // `recordDispatch` returns `false` on a P2002 race-loss; we discard the
  // boolean because the loser's run is cancelled by lease loss on the next
  // checkpoint write (PR 1 model). Other DB errors are non-fatal — the
  // notification already went out, so we log and continue. A re-drive that
  // misses the cache will re-send (no provider-side dedup for our generic
  // webhook path) — this is the documented trade-off of the cache miss window.
  try {
    await recordDispatch({
      executionId: ctx.executionId,
      stepId: step.id,
      result: stepResult,
    });
  } catch (err) {
    logger.warn('Notification step: failed to record dispatch; re-drive may re-send', {
      stepId: step.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return stepResult;
}

registerStepType('send_notification', executeNotification);
