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
import { ExecutorError } from '@/lib/orchestration/engine/errors';
import { lookupDispatch, recordDispatch } from '@/lib/orchestration/engine/dispatch-cache';
import { logger } from '@/lib/logging';

type StepExecutorFn = (
  step: WorkflowStep,
  ctx: Readonly<ExecutionContext>
) => Promise<{ output: unknown; tokensUsed: number; costUsd: number }>;

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
    executor = calls[0][1] as StepExecutorFn;
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
});
