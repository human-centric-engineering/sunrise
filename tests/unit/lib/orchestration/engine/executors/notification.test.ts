/**
 * Tests for `lib/orchestration/engine/executors/notification.ts`
 *
 * The module registers its executor via `registerStepType` as a side effect.
 * We mock the registry, import the module to trigger registration, then
 * capture the executor in `beforeAll` — before `beforeEach` can clear mocks.
 *
 * @see lib/orchestration/engine/executors/notification.ts
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import type { WorkflowStep } from '@/types/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';

// ─── Mocks (declared before imports) ────────────────────────────────────────

vi.mock('@/lib/orchestration/engine/executor-registry', () => ({
  registerStepType: vi.fn(),
}));

vi.mock('@/lib/email/send', () => ({
  sendEmail: vi.fn(),
}));

vi.mock('@/lib/orchestration/webhooks/dispatcher', () => ({
  dispatchWebhookEvent: vi.fn(),
}));

vi.mock('@/lib/orchestration/engine/llm-runner', () => ({
  interpolatePrompt: vi.fn((template: string) => template),
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@/emails/workflow-notification', () => ({
  WorkflowNotification: vi.fn(() => null),
}));

vi.mock('@/lib/orchestration/engine/dispatch-cache', () => ({
  buildIdempotencyKey: vi.fn(({ executionId, stepId, turnIndex }) =>
    turnIndex !== undefined
      ? `${executionId}:${stepId}:turn=${turnIndex}`
      : `${executionId}:${stepId}`
  ),
  lookupDispatch: vi.fn().mockResolvedValue(null),
  recordDispatch: vi.fn().mockResolvedValue(true),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import '@/lib/orchestration/engine/executors/notification'; // triggers registerStepType
import { registerStepType } from '@/lib/orchestration/engine/executor-registry';
import { sendEmail } from '@/lib/email/send';
import { dispatchWebhookEvent } from '@/lib/orchestration/webhooks/dispatcher';
import { interpolatePrompt } from '@/lib/orchestration/engine/llm-runner';
// The REAL interpolator (this module is NOT mocked — the mock above is on
// `llm-runner`, which merely re-exports this). Used below to prove the executor
// against the actual `{{…}}` resolution semantics, not a stub that fakes them.
import { interpolatePrompt as realInterpolatePrompt } from '@/lib/orchestration/engine/interpolate-prompt';
import { ExecutorError } from '@/lib/orchestration/engine/errors';
import { lookupDispatch, recordDispatch } from '@/lib/orchestration/engine/dispatch-cache';
import { logger } from '@/lib/logging';

type StepExecutorFn = (
  step: WorkflowStep,
  ctx: Readonly<ExecutionContext>
) => Promise<{
  output: unknown;
  tokensUsed: number;
  costUsd: number;
  failWorkflow?: string;
}>;

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    executionId: 'exec-1',
    workflowId: 'wf-1',
    userId: 'user-1',
    inputData: {},
    stepOutputs: {},
    variables: { workflowName: 'Test Workflow' },
    totalTokensUsed: 0,
    totalCostUsd: 0,
    defaultErrorStrategy: 'fail',
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      withContext: vi.fn().mockReturnThis(),
    } as never,
    ...overrides,
  };
}

function makeEmailStep(configOverrides: Record<string, unknown> = {}): WorkflowStep {
  return {
    id: 'notify-1',
    name: 'Send Email',
    type: 'send_notification',
    config: {
      channel: 'email',
      to: 'user@example.com',
      subject: 'Workflow Complete',
      bodyTemplate: 'The workflow finished.',
      ...configOverrides,
    },
    nextSteps: [],
  };
}

function makeWebhookStep(configOverrides: Record<string, unknown> = {}): WorkflowStep {
  return {
    id: 'notify-2',
    name: 'Send Webhook',
    type: 'send_notification',
    config: {
      channel: 'webhook',
      webhookUrl: 'https://example.com/hook',
      bodyTemplate: 'The workflow finished.',
      ...configOverrides,
    },
    nextSteps: [],
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('executeNotification', () => {
  // Capture executor in beforeAll — runs BEFORE any beforeEach clears mock history
  let executor: StepExecutorFn;

  beforeAll(() => {
    const calls = vi.mocked(registerStepType).mock.calls;
    if (calls.length === 0)
      throw new Error('registerStepType was never called — import did not run');
    executor = calls[0][1];
  });

  beforeEach(() => {
    vi.mocked(sendEmail).mockReset();
    vi.mocked(dispatchWebhookEvent).mockReset();
    vi.mocked(interpolatePrompt).mockImplementation((template: string) => template);
    vi.mocked(sendEmail).mockResolvedValue({ status: 'sent', success: true });
    vi.mocked(dispatchWebhookEvent).mockResolvedValue(undefined);
  });

  // ── workflowName fallback ─────────────────────────────────────────────────

  it('uses "Workflow" fallback when workflowName is not in ctx.variables', async () => {
    const ctx = makeCtx({ variables: {} });

    // Should not throw — the fallback is used silently
    await expect(executor(makeEmailStep(), ctx)).resolves.toMatchObject({
      output: { sent: true, channel: 'email' },
    });
  });

  // ── Email channel ──────────────────────────────────────────────────────────

  describe('email channel', () => {
    it('calls sendEmail and returns { sent: true, channel: "email" }', async () => {
      const result = await executor(makeEmailStep(), makeCtx());

      expect(vi.mocked(sendEmail)).toHaveBeenCalledOnce();
      expect(result.output).toMatchObject({ sent: true, channel: 'email' });
      expect(result.tokensUsed).toBe(0);
      expect(result.costUsd).toBe(0);
    });

    it('passes correct to and subject to sendEmail', async () => {
      await executor(makeEmailStep({ to: 'admin@example.com', subject: 'Done' }), makeCtx());

      expect(vi.mocked(sendEmail)).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'admin@example.com', subject: 'Done' })
      );
    });

    it('handles an array of email recipients', async () => {
      const to = ['a@example.com', 'b@example.com'];

      await executor(makeEmailStep({ to }), makeCtx());

      expect(vi.mocked(sendEmail)).toHaveBeenCalledWith(expect.objectContaining({ to }));
    });

    // ── Templated recipient (#379) ────────────────────────────────────────────
    // The `to` field is interpolated per run like subject/body, then the
    // resolved value is validated as an email. Lets a per-user scheduled
    // workflow template the recipient (`to: '{{input.userEmail}}'`).
    describe('templated `to` (#379)', () => {
      it('interpolates a templated recipient and sends to the resolved address', async () => {
        vi.mocked(interpolatePrompt).mockImplementation((template: string) =>
          template === '{{input.userEmail}}' ? 'brief@example.com' : template
        );

        await executor(makeEmailStep({ to: '{{input.userEmail}}' }), makeCtx());

        expect(vi.mocked(sendEmail)).toHaveBeenCalledWith(
          expect.objectContaining({ to: 'brief@example.com' })
        );
      });

      it('interpolates each recipient in a templated array, preserving the array shape', async () => {
        vi.mocked(interpolatePrompt).mockImplementation((template: string) => {
          if (template === '{{input.a}}') return 'a@example.com';
          if (template === '{{input.b}}') return 'b@example.com';
          return template;
        });

        await executor(makeEmailStep({ to: ['{{input.a}}', '{{input.b}}'] }), makeCtx());

        expect(vi.mocked(sendEmail)).toHaveBeenCalledWith(
          expect.objectContaining({ to: ['a@example.com', 'b@example.com'] })
        );
      });

      it('trims surrounding whitespace from a resolved recipient', async () => {
        vi.mocked(interpolatePrompt).mockImplementation((template: string) =>
          template === '{{input.userEmail}}' ? '  spaced@example.com  ' : template
        );

        await executor(makeEmailStep({ to: '{{input.userEmail}}' }), makeCtx());

        expect(vi.mocked(sendEmail)).toHaveBeenCalledWith(
          expect.objectContaining({ to: 'spaced@example.com' })
        );
      });

      it('throws ExecutorError(INVALID_RECIPIENT, non-retriable) when a template resolves to a non-email, and does not send', async () => {
        // A missing template variable expands to '' — not a valid email. This
        // must fail before any send, and non-retriably (a bad address won't fix
        // itself on retry).
        vi.mocked(interpolatePrompt).mockImplementation((template: string) =>
          template === '{{input.userEmail}}' ? '' : template
        );

        await expect(
          executor(makeEmailStep({ to: '{{input.userEmail}}' }), makeCtx())
        ).rejects.toMatchObject({
          name: 'ExecutorError',
          code: 'INVALID_RECIPIENT',
          retriable: false,
        });

        expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
      });

      it('throws INVALID_RECIPIENT when one recipient in a templated array is invalid', async () => {
        vi.mocked(interpolatePrompt).mockImplementation((template: string) => {
          if (template === '{{input.a}}') return 'a@example.com';
          if (template === '{{input.b}}') return 'nope';
          return template;
        });

        await expect(
          executor(makeEmailStep({ to: ['{{input.a}}', '{{input.b}}'] }), makeCtx())
        ).rejects.toMatchObject({ name: 'ExecutorError', code: 'INVALID_RECIPIENT' });

        expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
      });

      // Guard the doc-vs-implementation contract with the REAL interpolator, not
      // the per-test stub. `interpolatePrompt` resolves a top-level `{{input.x}}`
      // key but has NO `{{trigger.*}}` namespace, so the documented example must
      // be `{{input.userEmail}}`. These two tests would fail if the docs (or a
      // fork) reverted to `{{trigger.userEmail}}`, which silently resolves to ''.
      describe('against the real interpolatePrompt', () => {
        beforeEach(() => {
          vi.mocked(interpolatePrompt).mockImplementation((template, ctx, prev) =>
            realInterpolatePrompt(template, ctx, prev)
          );
        });

        it('resolves a top-level {{input.userEmail}} to the run’s inputData value', async () => {
          await executor(
            makeEmailStep({ to: '{{input.userEmail}}' }),
            makeCtx({ inputData: { userEmail: 'brief@example.com' } })
          );

          expect(vi.mocked(sendEmail)).toHaveBeenCalledWith(
            expect.objectContaining({ to: 'brief@example.com' })
          );
        });

        it('rejects {{trigger.userEmail}} — no such namespace, so it resolves to "" and fails', async () => {
          // The real interpolator has no `trigger.` branch; the token expands to
          // '' and the runtime email check throws. This pins that the flagship
          // example uses `input.`, not the non-functional `trigger.` convention.
          await expect(
            executor(
              makeEmailStep({ to: '{{trigger.userEmail}}' }),
              makeCtx({ inputData: { userEmail: 'brief@example.com' } })
            )
          ).rejects.toMatchObject({ name: 'ExecutorError', code: 'INVALID_RECIPIENT' });

          expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
        });
      });
    });

    it('throws ExecutorError(EMAIL_SEND_FAILED, retriable) when sendEmail returns status "failed"', async () => {
      vi.mocked(sendEmail).mockResolvedValue({
        status: 'failed',
        success: false,
        error: 'SMTP unreachable',
      });

      await expect(executor(makeEmailStep(), makeCtx())).rejects.toMatchObject({
        name: 'ExecutorError',
        code: 'EMAIL_SEND_FAILED',
        retriable: true,
      });
    });

    it('throws ExecutorError(EMAIL_DELIVERY_ERROR, retriable) when sendEmail throws', async () => {
      vi.mocked(sendEmail).mockRejectedValue(new Error('Connection refused'));

      await expect(executor(makeEmailStep(), makeCtx())).rejects.toMatchObject({
        name: 'ExecutorError',
        code: 'EMAIL_DELIVERY_ERROR',
        retriable: true,
      });
    });

    it('throws ExecutorError(EMAIL_DELIVERY_ERROR) when sendEmail throws a non-Error value', async () => {
      vi.mocked(sendEmail).mockRejectedValue('SMTP error string');

      await expect(executor(makeEmailStep(), makeCtx())).rejects.toMatchObject({
        name: 'ExecutorError',
        code: 'EMAIL_DELIVERY_ERROR',
      });
    });

    it('re-throws ExecutorError from sendEmail without wrapping', async () => {
      const inner = new ExecutorError('notify-1', 'EMAIL_SEND_FAILED', 'already an executor error');
      vi.mocked(sendEmail).mockRejectedValue(inner);

      await expect(executor(makeEmailStep(), makeCtx())).rejects.toBe(inner);
    });
  });

  // ── Webhook channel ────────────────────────────────────────────────────────

  describe('webhook channel', () => {
    it('calls dispatchWebhookEvent and returns { sent: true, channel: "webhook" }', async () => {
      const result = await executor(makeWebhookStep(), makeCtx());

      expect(vi.mocked(dispatchWebhookEvent)).toHaveBeenCalledOnce();
      expect(result.output).toMatchObject({ sent: true, channel: 'webhook' });
    });

    it('passes workflowId, executionId, webhookUrl, and stepId to dispatchWebhookEvent', async () => {
      const ctx = makeCtx({ workflowId: 'wf-42', executionId: 'exec-99' });
      const step = makeWebhookStep({ webhookUrl: 'https://hooks.example.com/notify' });

      await executor(step, ctx);

      expect(vi.mocked(dispatchWebhookEvent)).toHaveBeenCalledWith(
        'workflow_notification',
        expect.objectContaining({
          webhookUrl: 'https://hooks.example.com/notify',
          workflowId: 'wf-42',
          executionId: 'exec-99',
          stepId: step.id,
        })
      );
    });

    it('throws ExecutorError(WEBHOOK_DISPATCH_ERROR, retriable) when dispatchWebhookEvent throws', async () => {
      vi.mocked(dispatchWebhookEvent).mockRejectedValue(new Error('Network timeout'));

      await expect(executor(makeWebhookStep(), makeCtx())).rejects.toMatchObject({
        name: 'ExecutorError',
        code: 'WEBHOOK_DISPATCH_ERROR',
        retriable: true,
      });
    });

    it('throws ExecutorError(WEBHOOK_DISPATCH_ERROR) when dispatchWebhookEvent throws a non-Error', async () => {
      vi.mocked(dispatchWebhookEvent).mockRejectedValue('connection refused');

      await expect(executor(makeWebhookStep(), makeCtx())).rejects.toMatchObject({
        name: 'ExecutorError',
        code: 'WEBHOOK_DISPATCH_ERROR',
      });
    });
  });

  // ── Invalid config ─────────────────────────────────────────────────────────

  describe('invalid config', () => {
    it('throws ExecutorError(INVALID_CONFIG) when email "to" is missing', async () => {
      await expect(executor(makeEmailStep({ to: undefined }), makeCtx())).rejects.toMatchObject({
        name: 'ExecutorError',
        code: 'INVALID_CONFIG',
      });

      expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
    });

    it('throws ExecutorError(INVALID_CONFIG) when email "to" is not a valid email', async () => {
      await expect(
        executor(makeEmailStep({ to: 'not-an-email' }), makeCtx())
      ).rejects.toMatchObject({ name: 'ExecutorError', code: 'INVALID_CONFIG' });
    });

    it('throws ExecutorError(INVALID_CONFIG) when email "subject" is missing', async () => {
      await expect(
        executor(makeEmailStep({ subject: undefined }), makeCtx())
      ).rejects.toMatchObject({ name: 'ExecutorError', code: 'INVALID_CONFIG' });
    });

    it('throws ExecutorError(INVALID_CONFIG) when webhook "webhookUrl" is missing', async () => {
      await expect(
        executor(makeWebhookStep({ webhookUrl: undefined }), makeCtx())
      ).rejects.toMatchObject({ name: 'ExecutorError', code: 'INVALID_CONFIG' });

      expect(vi.mocked(dispatchWebhookEvent)).not.toHaveBeenCalled();
    });

    it('throws ExecutorError(INVALID_CONFIG) when channel is unknown', async () => {
      const step = makeEmailStep({ channel: 'sms' });

      await expect(executor(step, makeCtx())).rejects.toMatchObject({
        name: 'ExecutorError',
        code: 'INVALID_CONFIG',
      });
    });
  });

  // ── Dispatch cache integration ─────────────────────────────────────────────

  describe('dispatch cache integration', () => {
    // The outer beforeEach resets sendEmail/dispatchWebhookEvent but not the
    // dispatch-cache mocks. Reset them here so call-count assertions are clean.
    beforeEach(() => {
      vi.mocked(lookupDispatch).mockReset();
      vi.mocked(lookupDispatch).mockResolvedValue(null); // default: cache miss
      vi.mocked(recordDispatch).mockReset();
      vi.mocked(recordDispatch).mockResolvedValue(true); // default: insert succeeded
    });

    it('cache hit (email path): returns cached result without calling sendEmail', async () => {
      // Arrange: prime the cache with an email-shaped result
      const cached = {
        output: { sent: true, channel: 'email', status: 'queued' },
        tokensUsed: 0,
        costUsd: 0,
      };
      vi.mocked(lookupDispatch).mockResolvedValueOnce(cached);

      // Act
      const result = await executor(makeEmailStep(), makeCtx());

      // Assert: short-circuit — sendEmail never fires and no new record is written
      expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
      expect(vi.mocked(recordDispatch)).not.toHaveBeenCalled();
      // The return value is the cached object, not a freshly constructed one
      expect(result).toEqual(cached);
    });

    it('cache hit (webhook path): returns cached result without calling dispatchWebhookEvent', async () => {
      // Arrange: prime the cache with a webhook-shaped result
      const cached = {
        output: { sent: true, channel: 'webhook', url: 'https://example.com/hook' },
        tokensUsed: 0,
        costUsd: 0,
      };
      vi.mocked(lookupDispatch).mockResolvedValueOnce(cached);

      // Act
      const result = await executor(makeWebhookStep(), makeCtx());

      // Assert: short-circuit — dispatchWebhookEvent never fires and no new record is written
      expect(vi.mocked(dispatchWebhookEvent)).not.toHaveBeenCalled();
      expect(vi.mocked(recordDispatch)).not.toHaveBeenCalled();
      expect(result).toEqual(cached);
    });

    it('cache hit logs info with stepId', async () => {
      // Arrange
      const stepId = 'notify-1';
      const cached = {
        output: { sent: true, channel: 'email', status: 'sent' },
        tokensUsed: 0,
        costUsd: 0,
      };
      vi.mocked(lookupDispatch).mockResolvedValueOnce(cached);

      // Act
      await executor(makeEmailStep(), makeCtx());

      // Assert: the source logs the cache-hit message with the step's id
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        'Notification step: dispatch cache hit, skipping send',
        { stepId }
      );
      // Assert: side effects are NOT triggered on a cache hit — a regression where
      // the logger fires AND the email/record side effects ALSO run would slip past
      // the logger assertion alone.
      expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
      expect(vi.mocked(recordDispatch)).not.toHaveBeenCalled();
    });

    it('cache miss (email path): calls recordDispatch with the email-shaped StepResult', async () => {
      // Arrange: cache miss is the default (null), sendEmail returns 'sent'
      const ctx = makeCtx({ executionId: 'exec-1' });
      const step = makeEmailStep(); // stepId: 'notify-1'
      vi.mocked(sendEmail).mockResolvedValue({ status: 'sent', success: true });

      // Act
      await executor(step, ctx);

      // Assert: recordDispatch called with the exact shape the source builds.
      // T2 fix: idempotencyKey is derived inside recordDispatch from
      // executionId/stepId/turnIndex; callers no longer pass it.
      expect(vi.mocked(recordDispatch)).toHaveBeenCalledWith({
        executionId: 'exec-1',
        stepId: 'notify-1',
        result: {
          output: { sent: true, channel: 'email', status: 'sent' },
          tokensUsed: 0,
          costUsd: 0,
        },
      });
    });

    it('cache miss (webhook path): calls recordDispatch with the webhook-shaped StepResult', async () => {
      // Arrange: cache miss is the default (null), dispatchWebhookEvent resolves
      const ctx = makeCtx({ executionId: 'exec-2' });
      const step = makeWebhookStep({ webhookUrl: 'https://example.com/hook' }); // stepId: 'notify-2'

      // Act
      await executor(step, ctx);

      // Assert: recordDispatch called with the webhook-shaped result the source builds.
      // T2 fix: no idempotencyKey field — derived inside recordDispatch.
      expect(vi.mocked(recordDispatch)).toHaveBeenCalledWith({
        executionId: 'exec-2',
        stepId: 'notify-2',
        result: {
          output: { sent: true, channel: 'webhook', url: 'https://example.com/hook' },
          tokensUsed: 0,
          costUsd: 0,
        },
      });
    });

    it('recordDispatch race-loss (returns false): step still returns StepResult; sendEmail called exactly once; no logger.warn', async () => {
      // Arrange: cache miss then recordDispatch loses the unique-key race (returns false)
      vi.mocked(recordDispatch).mockResolvedValueOnce(false);

      // Act
      const result = await executor(makeEmailStep(), makeCtx());

      // Assert: notification was sent exactly once (no double-fire)
      expect(vi.mocked(sendEmail)).toHaveBeenCalledOnce();
      // Assert: step returns the result the source computed (not suppressed)
      expect(result.output).toMatchObject({ sent: true, channel: 'email' });
      // Assert: false is the documented non-error race outcome; no warning logged
      expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
    });

    it('recordDispatch throws non-P2002: logger.warn called with message and stepId; step still returns StepResult', async () => {
      // Arrange: cache miss then recordDispatch throws a non-race DB error
      const dbError = new Error('connection lost');
      vi.mocked(recordDispatch).mockRejectedValueOnce(dbError);

      // Act — should NOT throw even though recordDispatch threw
      const result = await executor(makeEmailStep(), makeCtx());

      // Assert: source logs the non-fatal warning with the documented message and stepId
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'Notification step: failed to record dispatch; re-drive may re-send',
        { stepId: 'notify-1', error: 'connection lost' }
      );
      // Assert: step still returns the result (notification already sent)
      expect(result.output).toMatchObject({ sent: true, channel: 'email' });
    });
  });

  describe('terminalStatus: failed', () => {
    // Authored fail-branch tail steps opt into terminating the workflow
    // as FAILED with the interpolated body as the visible reason.
    // Without `terminalStatus: 'failed'` set, the same step would leave
    // the execution marked COMPLETED — the bug that motivated this
    // feature on the provider-model-audit template.

    it('returns failWorkflow populated with the interpolated body for email', async () => {
      const result = await executor(
        makeEmailStep({
          bodyTemplate: 'Validation failed: bad capabilities array',
          terminalStatus: 'failed',
        }),
        makeCtx()
      );

      expect(result.failWorkflow).toBe('Validation failed: bad capabilities array');
      // Side effect (email) still fires — terminalStatus is about
      // status routing, not about gating the notification itself.
      expect(vi.mocked(sendEmail)).toHaveBeenCalledOnce();
    });

    it('returns failWorkflow populated for webhook channel too', async () => {
      const result = await executor(
        makeWebhookStep({
          bodyTemplate: 'pipeline aborted',
          terminalStatus: 'failed',
        }),
        makeCtx()
      );

      expect(result.failWorkflow).toBe('pipeline aborted');
    });

    it('truncates the failure reason to keep errorMessage bounded', async () => {
      // The reason flows into the execution row's `errorMessage` column
      // and the `workflow_failed` event payload. A multi-paragraph email
      // body is too much for both — the executor caps at 2000 chars.
      const longBody = 'x'.repeat(3000);
      const result = await executor(
        makeEmailStep({ bodyTemplate: longBody, terminalStatus: 'failed' }),
        makeCtx()
      );

      expect(result.failWorkflow).toBeDefined();
      expect(result.failWorkflow!.length).toBeLessThanOrEqual(2000);
      expect(result.failWorkflow!.endsWith('…')).toBe(true);
    });

    it('does not populate failWorkflow when terminalStatus is unset', async () => {
      // Back-compat: the default behaviour is unchanged. Existing
      // notification steps don't opt in and don't get failWorkflow.
      const result = await executor(makeEmailStep(), makeCtx());

      expect(result.failWorkflow).toBeUndefined();
    });

    it('does not populate failWorkflow when terminalStatus is "completed"', async () => {
      // The explicit `'completed'` value is also a no-op for failWorkflow
      // — it reserves the field for future "force completion despite
      // downstream guards" use cases without changing today's behaviour.
      const result = await executor(makeEmailStep({ terminalStatus: 'completed' }), makeCtx());

      expect(result.failWorkflow).toBeUndefined();
    });
  });
});
