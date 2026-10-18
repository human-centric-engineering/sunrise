/**
 * `send_notification` — Send email or webhook notifications from a workflow.
 *
 * Config:
 *   - `channel: 'email' | 'webhook'` — notification channel.
 *   - `to: string | string[]` — email recipients. Each may be a literal address
 *     or a `{{…}}` template resolved per run (e.g. `{{input.userEmail}}`); the
 *     resolved value is validated as an email at runtime. A recipient whose
 *     data was erased since the run started is left out when it sends; a step
 *     with none left fails (t-841, `sendToLiveRecipients`).
 *   - `subject?: string` — email subject (required for email channel).
 *   - `bodyTemplate: string` — message body with `{{input}}` interpolation.
 *   - `webhookUrl?: string` — target URL (required for webhook channel). The
 *     body is POSTed there as `{ text, workflowId, workflowName, executionId,
 *     stepId }` through the guarded outbound fetch, so its host must be in
 *     `ORCHESTRATION_ALLOWED_HOSTS`.
 *
 * Supports `{{input}}` / `{{input.<key>}}` and `{{<stepId>.output}}` template
 * variables in `to`, `subject`, and `bodyTemplate`.
 */

import { createHash } from 'node:crypto';
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
import { executeHttpRequest, HttpError } from '@/lib/orchestration/http';
import { logger } from '@/lib/logging';
import { withTimeout } from '@/lib/utils/with-timeout';
import { loggableUrl } from '@/lib/logging/redact-path';
import { WorkflowNotification } from '@/emails/workflow-notification';
import { notificationToSchema } from '@/lib/validations/orchestration';
import { prisma } from '@/lib/db/client';
import { normaliseAddress } from '@/lib/orchestration/webhooks/destination';
import {
  boundLockWaits,
  findErasedSubjects,
  SUBJECT_LOCK_WAIT_MS,
} from '@/lib/privacy/erased-subjects';

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

/**
 * How long an email send may take. The erasure lock is held until it settles
 * (`sendToLiveRecipients`), so it has to end; the same bound the email
 * delivery channel uses (`DISPATCH_TIMEOUT_MS.email`, t-808).
 */
export const EMAIL_SEND_TIMEOUT_MS = 15_000;

/**
 * The transaction a send runs in: a wait for the recipients' locks, then the
 * send, with room to commit.
 */
const SEND_TRANSACTION_TIMEOUT_MS = SUBJECT_LOCK_WAIT_MS + EMAIL_SEND_TIMEOUT_MS + 10_000;

/** A webhook receiver's reply is read only for its status. */
const WEBHOOK_RESPONSE_MAX_BYTES = 64 * 1024;

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

/**
 * Send to the recipients who have not been erased (t-841).
 *
 * A run holds its definition and input in memory from the moment it starts, so
 * a person erased while it runs is still named by the step's `to`. So, in one
 * transaction: take erasure's lock for each recipient, leave out anyone with an
 * erasure receipt, and send — holding the locks until the send has settled.
 * Whichever of this and an erasure takes the lock first finishes before the
 * other reads: either the receipt is seen and the person is left out, or the
 * email went before the erasure committed. Erasure only tries the lock, and
 * waits outside its own transaction when it is busy (t-840).
 *
 * The send is bounded, so the locks are let go; a send that timed out may have
 * been accepted, so it carries an idempotency key and a retry of the step is
 * not delivered twice. A step whose every recipient was erased fails, not
 * retried, as one whose `to` erasure emptied does.
 */
async function sendToLiveRecipients(
  to: string | string[],
  send: (to: string | string[], signal: AbortSignal, idempotencyKey: string) => Promise<SendResult>,
  ctx: Readonly<ExecutionContext>,
  stepId: string,
  { content, deadline }: { content: string; deadline: number | null }
): Promise<{ result: SendResult; to: string | string[]; leftOut: number }> {
  const list = Array.isArray(to) ? to : [to];
  // A retry of a cancelled run's step does not open a transaction to wait in
  // (review round 3).
  if (ctx.signal?.aborted) throw aborted(stepId);
  // A step with its own `timeoutMs` waits for the locks no longer than that:
  // the engine gives up on it then, without aborting it (review round 2).
  const lockWaitMs =
    deadline === null
      ? SUBJECT_LOCK_WAIT_MS
      : Math.max(1, Math.min(SUBJECT_LOCK_WAIT_MS, deadline - Date.now()));
  return prisma.$transaction(
    async (tx) => {
      await boundLockWaits(tx, lockWaitMs);
      // Shared: sends to the same address need not wait for each other, only
      // for an erasure, which takes the lock exclusively (review round 2).
      const erased = await findErasedSubjects(tx, { addresses: list }, { shared: true });
      const gone = new Set(erased.addresses);
      const kept = list.filter((address) => !gone.has(normaliseAddress(address)));
      if (kept.length === 0) {
        throw new ExecutorError(
          stepId,
          'RECIPIENT_ERASED',
          'Every recipient of this notification belongs to a person whose data was erased',
          undefined,
          false
        );
      }
      if (kept.length < list.length) {
        // Never the address: it is what was erased.
        logger.warn('Notification step: left out recipients whose data was erased', {
          stepId,
          leftOut: list.length - kept.length,
        });
      }
      // The lock wait above watches neither the run's signal nor the step's
      // timeout. A run cancelled while it waited sends nothing (review round 1),
      // and nor does a step the engine has already timed out (round 2).
      if (deadline !== null && Date.now() >= deadline) {
        throw new ExecutorError(
          stepId,
          'STEP_TIMED_OUT',
          'The step timed out before the send',
          undefined,
          false
        );
      }
      if (ctx.signal?.aborted) throw aborted(stepId);
      const sendTo = Array.isArray(to) ? kept : kept[0];
      const result = await withTimeout(
        // No later than the step's deadline either (review round 3).
        deadline === null
          ? EMAIL_SEND_TIMEOUT_MS
          : Math.max(1, Math.min(EMAIL_SEND_TIMEOUT_MS, deadline - Date.now())),
        'Email send',
        (signal) =>
          send(sendTo, signal, emailIdempotencyKey(ctx.executionId, stepId, kept, content)),
        ctx.signal
      );
      return { result, to: sendTo, leftOut: list.length - kept.length };
    },
    // maxWait: a connection may be slow to come free while other sends hold
    // theirs; past Prisma's 2 s default that would fail the send (round 1).
    { timeout: SEND_TRANSACTION_TIMEOUT_MS, maxWait: 10_000 }
  );
}

type SendResult = Awaited<ReturnType<typeof sendEmail>>;

/** The run was cancelled: not retried, since a retry would be cancelled too. */
function aborted(stepId: string): ExecutorError {
  return new ExecutorError(
    stepId,
    'EXECUTION_ABORTED',
    'The run was cancelled before the send',
    undefined,
    false
  );
}

/**
 * Resend's idempotency key for this step's send: a hash of the run, the step,
 * the recipients and the rendered subject and body. Resend refuses a reused
 * key whose request differs, so anything that changes the request changes the
 * key — a list someone was erased from between tries, or a retry-step after
 * the template was edited (review round 2) — while a retry of the same send
 * keeps it. Hashed, so a long step id cannot push it past Resend's 256
 * characters.
 */
function emailIdempotencyKey(
  executionId: string,
  stepId: string,
  to: string[],
  content: string
): string {
  const hash = createHash('sha256')
    .update(
      JSON.stringify([executionId, stepId, to.map((address) => normaliseAddress(address)), content])
    )
    .digest('hex');
  return `workflow-notification/${hash.slice(0, 32)}`;
}

// ─── Executor ───────────────────────────────────────────────────────────────

async function executeNotification(
  step: WorkflowStep,
  ctx: Readonly<ExecutionContext>
): Promise<StepResult> {
  // The engine abandons a step at its `timeoutMs` without aborting it. Taken
  // first, so it is no later than the engine's own timer (review round 3).
  const deadline =
    typeof step.config.timeoutMs === 'number' ? Date.now() + step.config.timeoutMs : null;

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
    const resolved = resolveRecipients(config.to, ctx, step.id);
    const subject = interpolatePrompt(config.subject, ctx, step.id);
    try {
      const { result, to, leftOut } = await sendToLiveRecipients(
        resolved,
        (sendTo, signal, idempotencyKey) =>
          sendEmail({
            to: sendTo,
            subject,
            react: WorkflowNotification({ body, workflowName }),
            signal,
            idempotencyKey,
          }),
        ctx,
        step.id,
        { content: `${subject}\n${body}`, deadline }
      );

      // A send the run's cancel aborted reports failed: not a send to retry.
      if (result.status === 'failed' && ctx.signal?.aborted) throw aborted(step.id);
      if (result.status === 'failed') {
        throw new ExecutorError(
          step.id,
          'EMAIL_SEND_FAILED',
          `Email send failed: ${result.error}`,
          undefined,
          true
        );
      }

      // A count, not the addresses: the application log is beyond erasure
      // (review round 1; `sendEmail` logs them under a redacted key).
      logger.info('Notification step: email sent', {
        stepId: step.id,
        recipients: Array.isArray(to) ? to.length : 1,
        status: result.status,
      });

      stepResult = {
        output: {
          sent: true,
          channel: 'email',
          status: result.status,
          // How many were left out as erased, so the trace shows why; never who.
          ...(leftOut > 0 ? { recipientsLeftOut: leftOut } : {}),
        },
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
    // Webhook channel: POST the body to the step's own URL (t-794). It goes
    // through the guarded outbound fetch, so the host must be in the
    // allowlist, a customer org's call is pinned to a checked address, and a
    // redirect is refused. `text` is the field Slack and Teams incoming
    // webhooks read; the rest lets a generic receiver tell runs apart.
    try {
      const response = await executeHttpRequest({
        url: config.webhookUrl,
        method: 'POST',
        body: JSON.stringify({
          text: body,
          workflowId: ctx.workflowId,
          workflowName,
          executionId: ctx.executionId,
          stepId: step.id,
        }),
        // The dispatch cache key, so a receiver that honours the header
        // dedups a re-drive that missed the cache.
        idempotency: { key: cacheKey },
        // Only the status is used; a large reply is not worth reading.
        maxResponseBytes: WEBHOOK_RESPONSE_MAX_BYTES,
        signal: ctx.signal,
        logContext: { stepId: step.id },
      });

      // A webhook URL can carry its credential (path, query or userinfo), so
      // the log line gets the reduced form (#953). `output.url` keeps the
      // working URL: later steps read it as `{{steps.<id>.output.url}}`, and a
      // resumed run rehydrates it from the persisted trace.
      logger.info('Notification step: webhook sent', {
        stepId: step.id,
        webhookUrl: loggableUrl(config.webhookUrl),
        status: response.status,
      });

      stepResult = {
        output: { sent: true, channel: 'webhook', url: config.webhookUrl, status: response.status },
        tokensUsed: 0,
        costUsd: 0,
      };
    } catch (err) {
      // A body too large to read comes after a 2xx: the receiver took it.
      if (err instanceof HttpError && err.code === 'response_too_large') {
        logger.info('Notification step: webhook sent; reply too large to read', {
          stepId: step.id,
          webhookUrl: loggableUrl(config.webhookUrl),
        });
        stepResult = {
          output: { sent: true, channel: 'webhook', url: config.webhookUrl },
          tokensUsed: 0,
          costUsd: 0,
        };
      } else if (err instanceof HttpError) {
        // The fetch guard's verdict: a 5xx may succeed on retry. A refused
        // host or a 4xx won't, and a timeout is not retried because the
        // receiver may already have posted it: Slack and Teams incoming
        // webhooks ignore the Idempotency-Key.
        throw new ExecutorError(
          step.id,
          'WEBHOOK_DISPATCH_ERROR',
          `Webhook send failed: ${err.message}`,
          err,
          err.retriable
        );
      } else {
        throw new ExecutorError(
          step.id,
          'WEBHOOK_DISPATCH_ERROR',
          `Webhook send failed: ${err instanceof Error ? err.message : String(err)}`,
          err,
          true
        );
      }
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
  // misses the cache will re-send, unless the receiver honours the webhook's
  // `Idempotency-Key` — the documented trade-off of the cache miss window.
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
