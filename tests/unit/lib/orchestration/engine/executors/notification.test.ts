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

// Only the network call is mocked: `HttpError` stays real, so the executor's
// retry mapping runs against the class the fetch guard actually throws.
vi.mock('@/lib/orchestration/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orchestration/http')>()),
  executeHttpRequest: vi.fn(),
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

// The send runs in a transaction holding erasure's lock (t-841). The real
// `findErasedSubjects` runs against this fake client, so the matching (the
// normalised address, the receipt hash, verified-only) is the code's own.
const tx = vi.hoisted(() => ({
  $executeRaw: vi.fn(),
  aiWorkflowExecution: { findUnique: vi.fn() },
  dataErasureReceipt: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
}));

/** When the run under test started: its copy of `to` is from then (t-886). */
const RUN_STARTED_AT = new Date('2026-10-22T09:00:00Z');
vi.mock('@/lib/db/client', () => ({
  prisma: {
    $transaction: vi.fn((run: (client: typeof tx) => Promise<unknown>) => run(tx)),
  },
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import '@/lib/orchestration/engine/executors/notification'; // triggers registerStepType
import { registerStepType } from '@/lib/orchestration/engine/executor-registry';
import { sendEmail } from '@/lib/email/send';
import { executeHttpRequest, HttpError } from '@/lib/orchestration/http';
import { interpolatePrompt } from '@/lib/orchestration/engine/llm-runner';
// The REAL interpolator (this module is NOT mocked — the mock above is on
// `llm-runner`, which merely re-exports this). Used below to prove the executor
// against the actual `{{…}}` resolution semantics, not a stub that fakes them.
import { interpolatePrompt as realInterpolatePrompt } from '@/lib/orchestration/engine/interpolate-prompt';
import { ExecutorError } from '@/lib/orchestration/engine/errors';
import { lookupDispatch, recordDispatch } from '@/lib/orchestration/engine/dispatch-cache';
import { logger } from '@/lib/logging';
import { prisma } from '@/lib/db/client';
import {
  COPY_CLOCK_SKEW_MS,
  subjectEmailHash,
  SUBJECT_LOCK_WAIT_MS,
} from '@/lib/privacy/erased-subjects';
import { EMAIL_SEND_TIMEOUT_MS } from '@/lib/orchestration/engine/executors/notification';

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
    vi.mocked(executeHttpRequest).mockReset();
    vi.mocked(interpolatePrompt).mockImplementation((template: string) => template);
    vi.mocked(sendEmail).mockResolvedValue({ status: 'sent', success: true });
    vi.mocked(executeHttpRequest).mockResolvedValue({ status: 200, body: 'ok', latencyMs: 5 });
    tx.$executeRaw.mockReset().mockResolvedValue(1);
    tx.dataErasureReceipt.findMany.mockReset().mockResolvedValue([]);
    tx.user.findMany.mockReset().mockResolvedValue([]);
    tx.aiWorkflowExecution.findUnique
      .mockReset()
      .mockResolvedValue({ startedAt: RUN_STARTED_AT, createdAt: new Date(0) });
  });

  /** Erasure receipts for `addresses`, as erasure writes them for a verified address. */
  function erased(...addresses: string[]): void {
    tx.dataErasureReceipt.findMany.mockResolvedValue(
      addresses.map((address) => ({
        subjectUserId: `gone-${address}`,
        subjectEmailHash: subjectEmailHash(address),
        metadata: { addressVerified: true },
      }))
    );
  }

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

      expect(result.output).not.toHaveProperty('recipientsLeftOut');
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

  // ── Erased recipients (t-841) ──────────────────────────────────────────────
  // A run holds its definition from the moment it starts, so a person erased
  // while it runs is still in the step's `to`.

  describe('erased recipients (t-841)', () => {
    it('does not email a recipient erased since the run started', async () => {
      erased('gone@example.com');

      const result = await executor(
        makeEmailStep({ to: ['Gone@Example.com', 'kept@example.com'] }),
        makeCtx()
      );

      expect(result.output).toMatchObject({ sent: true, recipientsLeftOut: 1 });
      expect(vi.mocked(sendEmail)).toHaveBeenCalledOnce();
      expect(vi.mocked(sendEmail)).toHaveBeenCalledWith(
        expect.objectContaining({ to: ['kept@example.com'] })
      );
      // Counted, never named.
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'Notification step: left out recipients whose data was erased',
        { stepId: 'notify-1', leftOut: 1 }
      );
    });

    it('counts only erasures since the run started, so an address re-entered before it is emailed', async () => {
      // §122 t-886: someone erased before the run started is not in what it
      // read, so a `to` naming them was written after the erasure, on purpose.
      await executor(makeEmailStep({ to: 'back@example.com' }), makeCtx());

      expect(tx.aiWorkflowExecution.findUnique).toHaveBeenCalledWith({
        where: { id: 'exec-1' },
        select: { startedAt: true, createdAt: true },
      });
      const [args] = tx.dataErasureReceipt.findMany.mock.calls[0] as [
        { where: { erasedAt?: { gte: Date } } },
      ];
      expect(args.where.erasedAt).toEqual({
        gte: new Date(RUN_STARTED_AT.getTime() - COPY_CLOCK_SKEW_MS),
      });
    });

    it('checks a recipient from an earlier step against every erasure ever: its source is never scrubbed', async () => {
      // Owner ruling 2026-10-22 (t-886): a knowledge document, a conversation
      // or an outside system still holds the address erasure removed elsewhere.
      vi.mocked(interpolatePrompt).mockImplementation((template: string) => {
        if (template === '{{lookup.output.email}}') return 'Old@Example.com';
        if (template === '{{input.contact}}') return 'kept@example.com';
        return template;
      });
      // Nobody erased since the run started; one person erased long before.
      tx.dataErasureReceipt.findMany.mockImplementation(
        async (args: { where: { erasedAt?: unknown } }) =>
          args.where.erasedAt
            ? []
            : [
                {
                  subjectUserId: 'gone',
                  subjectEmailHash: subjectEmailHash('old@example.com'),
                  metadata: { addressVerified: true },
                },
              ]
      );

      const result = await executor(
        makeEmailStep({ to: ['{{lookup.output.email}}', '{{input.contact}}'] }),
        makeCtx()
      );

      expect(vi.mocked(sendEmail)).toHaveBeenCalledWith(
        expect.objectContaining({ to: ['kept@example.com'] })
      );
      expect(result.output).toMatchObject({ recipientsLeftOut: 1 });
      // The all-time question asked only about the step-output address.
      const allTime = tx.dataErasureReceipt.findMany.mock.calls
        .map(([args]) => args as { where: { erasedAt?: unknown; OR: unknown } })
        .filter((args) => !args.where.erasedAt);
      expect(allTime).toEqual([
        expect.objectContaining({
          where: { OR: [{ subjectEmailHash: { in: [subjectEmailHash('old@example.com')] } }] },
        }),
      ]);
    });

    it('CONTROL — an older erasure does not stop a literal or input recipient', async () => {
      vi.mocked(interpolatePrompt).mockImplementation((template: string) =>
        template === '{{input.contact}}' ? 'old@example.com' : template
      );
      tx.dataErasureReceipt.findMany.mockImplementation(
        async (args: { where: { erasedAt?: unknown } }) =>
          args.where.erasedAt
            ? []
            : [
                {
                  subjectUserId: 'gone',
                  subjectEmailHash: subjectEmailHash('old@example.com'),
                  metadata: { addressVerified: true },
                },
              ]
      );

      await executor(makeEmailStep({ to: ['{{input.contact}}', 'Old@Example.com'] }), makeCtx());

      expect(vi.mocked(sendEmail)).toHaveBeenCalledWith(
        expect.objectContaining({ to: ['old@example.com', 'Old@Example.com'] })
      );
    });

    it('anchors a run not yet started on when it was created', async () => {
      const createdAt = new Date('2026-10-22T08:00:00Z');
      tx.aiWorkflowExecution.findUnique.mockResolvedValue({ startedAt: null, createdAt });

      await executor(makeEmailStep({ to: 'someone@example.com' }), makeCtx());

      const [args] = tx.dataErasureReceipt.findMany.mock.calls[0] as [
        { where: { erasedAt?: { gte: Date } } },
      ];
      expect(args.where.erasedAt).toEqual({
        gte: new Date(createdAt.getTime() - COPY_CLOCK_SKEW_MS),
      });
    });

    it('counts every erasure when the run cannot be found: the stricter reading', async () => {
      tx.aiWorkflowExecution.findUnique.mockResolvedValue(null);

      await executor(makeEmailStep({ to: 'someone@example.com' }), makeCtx());

      const [args] = tx.dataErasureReceipt.findMany.mock.calls[0] as [
        { where: { erasedAt?: unknown } },
      ];
      expect(args.where.erasedAt).toBeUndefined();
    });

    it('fails, not retried, when every recipient was erased, and sends nothing', async () => {
      erased('gone@example.com');

      const err = await executor(makeEmailStep({ to: 'gone@example.com' }), makeCtx()).catch(
        (e: unknown) => e
      );

      expect(err).toBeInstanceOf(ExecutorError);
      expect(err).toMatchObject({ code: 'RECIPIENT_ERASED', retriable: false });
      expect((err as Error).message).not.toContain('gone@example.com');
      expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
      expect(vi.mocked(recordDispatch)).not.toHaveBeenCalled();
    });

    it('keeps a single recipient a string when it is not erased', async () => {
      erased('someone-else@example.com');

      await executor(makeEmailStep({ to: 'user@example.com' }), makeCtx());

      expect(vi.mocked(sendEmail)).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'user@example.com' })
      );
    });

    it('emails an address whose erasure never matched it as verified', async () => {
      tx.dataErasureReceipt.findMany.mockResolvedValue([
        {
          subjectUserId: 'gone-1',
          subjectEmailHash: subjectEmailHash('user@example.com'),
          metadata: {},
        },
      ]);

      await executor(makeEmailStep({ to: 'user@example.com' }), makeCtx());

      expect(vi.mocked(sendEmail)).toHaveBeenCalledOnce();
    });

    it('takes the lock and sends inside one transaction, so an erasure waits for the send', async () => {
      const order: string[] = [];
      tx.$executeRaw.mockImplementation(async (strings: TemplateStringsArray) => {
        order.push(strings.join('?').includes('pg_advisory_xact_lock') ? 'lock' : 'bound');
        return 1;
      });
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (
        run: (client: typeof tx) => Promise<unknown>
      ) => {
        const result = await run(tx);
        order.push('commit');
        return result;
      }) as never);
      vi.mocked(sendEmail).mockImplementationOnce(async () => {
        order.push('send');
        return { status: 'sent', success: true };
      });

      await executor(makeEmailStep(), makeCtx());

      expect(order).toEqual(['bound', 'lock', 'send', 'commit']);
      // The transaction outlasts a full lock wait plus the bounded send.
      expect(vi.mocked(prisma.$transaction).mock.calls[0][1]).toEqual({
        timeout: expect.any(Number),
        // Waits past Prisma's 2 s default for a connection to come free.
        maxWait: 10_000,
      });
      const { timeout } = vi.mocked(prisma.$transaction).mock.calls[0][1] as { timeout: number };
      expect(timeout).toBeGreaterThan(SUBJECT_LOCK_WAIT_MS + EMAIL_SEND_TIMEOUT_MS);
    });

    it('sends with an abort signal and an idempotency key that names the recipients', async () => {
      await executor(makeEmailStep({ to: ['a@example.com', 'b@example.com'] }), makeCtx());
      const first = vi.mocked(sendEmail).mock.calls[0][0];

      erased('b@example.com');
      await executor(makeEmailStep({ to: ['a@example.com', 'b@example.com'] }), makeCtx());
      const second = vi.mocked(sendEmail).mock.calls[1][0];

      expect(first.signal).toBeInstanceOf(AbortSignal);
      expect(first.idempotencyKey).toMatch(/^workflow-notification\/[0-9a-f]{32}$/);
      // A different list is a different request, so a different key.
      expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    });

    it('takes the lock shared, so sends to one address do not queue on each other', async () => {
      const statements: string[] = [];
      tx.$executeRaw.mockImplementation(async (strings: TemplateStringsArray) => {
        statements.push(strings.join('?'));
        return 1;
      });

      await executor(makeEmailStep(), makeCtx());

      expect(statements.some((q) => q.includes('pg_advisory_xact_lock_shared('))).toBe(true);
      expect(statements.some((q) => /pg_advisory_xact_lock\(/.test(q))).toBe(false);
    });

    it('sends nothing once the step is past its own timeoutMs, and waits no longer than it', async () => {
      vi.useFakeTimers();
      try {
        const lockWaits: string[] = [];
        tx.$executeRaw.mockImplementation(
          async (strings: TemplateStringsArray, ...values: unknown[]) => {
            if (strings.join('?').includes('lock_timeout')) lockWaits.push(String(values[0]));
            return 1;
          }
        );
        // The lock wait outlasts the step's 5 s timeout.
        tx.dataErasureReceipt.findMany.mockImplementation(async () => {
          vi.advanceTimersByTime(6_000);
          return [];
        });

        const err = await executor(makeEmailStep({ timeoutMs: 5_000 }), makeCtx()).catch(
          (e: unknown) => e
        );

        expect(lockWaits).toEqual(['5000ms']);
        expect(err).toMatchObject({ code: 'STEP_TIMED_OUT', retriable: false });
        expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps the key within Resend's 256 characters for a long step id", async () => {
      await executor({ ...makeEmailStep(), id: 'x'.repeat(400) }, makeCtx());

      expect(vi.mocked(sendEmail).mock.calls[0][0].idempotencyKey?.length).toBeLessThanOrEqual(256);
    });

    it('changes the key when the rendered email changes, so an edited retry is not refused', async () => {
      await executor(makeEmailStep({ bodyTemplate: 'First wording' }), makeCtx());
      await executor(makeEmailStep({ bodyTemplate: 'First wording' }), makeCtx());
      await executor(makeEmailStep({ bodyTemplate: 'Edited wording' }), makeCtx());
      const [a, b, c] = vi.mocked(sendEmail).mock.calls.map(([o]) => o.idempotencyKey);

      expect(a).toBe(b); // a retry of the same send keeps it
      expect(c).not.toBe(a);
    });

    it('sends nothing when the run was cancelled while the step waited for the lock', async () => {
      const controller = new AbortController();
      // The run is cancelled during the lock wait, before the send.
      tx.dataErasureReceipt.findMany.mockImplementation(async () => {
        controller.abort();
        return [];
      });

      const err = await executor(makeEmailStep(), makeCtx({ signal: controller.signal })).catch(
        (e: unknown) => e
      );

      expect(err).toMatchObject({ code: 'EXECUTION_ABORTED', retriable: false });
      expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
    });

    it('does not retry a send the run was cancelled during', async () => {
      const controller = new AbortController();
      vi.mocked(sendEmail).mockImplementationOnce(async () => {
        controller.abort();
        return { status: 'failed', success: false, error: 'aborted' };
      });

      const err = await executor(makeEmailStep(), makeCtx({ signal: controller.signal })).catch(
        (e: unknown) => e
      );

      expect(err).toMatchObject({ code: 'EXECUTION_ABORTED', retriable: false });
    });

    it('opens no transaction for a retry of a cancelled run', async () => {
      const controller = new AbortController();
      controller.abort();

      const err = await executor(makeEmailStep(), makeCtx({ signal: controller.signal })).catch(
        (e: unknown) => e
      );

      expect(err).toMatchObject({ code: 'EXECUTION_ABORTED' });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("ends the send at the step's deadline, not 15 s after it", async () => {
      vi.useFakeTimers();
      try {
        let signal: AbortSignal | undefined;
        vi.mocked(sendEmail).mockImplementationOnce((options) => {
          signal = options.signal;
          return new Promise(() => undefined);
        });

        const pending = executor(makeEmailStep({ timeoutMs: 2_000 }), makeCtx()).catch(
          (e: unknown) => e
        );
        await vi.advanceTimersByTimeAsync(2_000);
        await pending;

        expect(signal?.aborted).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('logs how many it emailed, never the addresses', async () => {
      await executor(makeEmailStep({ to: ['a@example.com', 'b@example.com'] }), makeCtx());

      expect(vi.mocked(logger.info)).toHaveBeenCalledWith('Notification step: email sent', {
        stepId: 'notify-1',
        recipients: 2,
        status: 'sent',
      });
      expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain('a@example.com');
    });

    it('gives up on a send that does not settle, aborting it, as a retriable failure', async () => {
      vi.useFakeTimers();
      try {
        let signal: AbortSignal | undefined;
        vi.mocked(sendEmail).mockImplementationOnce((options) => {
          signal = options.signal;
          return new Promise(() => undefined);
        });

        const pending = executor(makeEmailStep(), makeCtx()).catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(EMAIL_SEND_TIMEOUT_MS);
        const err = await pending;

        expect(signal?.aborted).toBe(true);
        expect(err).toMatchObject({ code: 'EMAIL_DELIVERY_ERROR', retriable: true });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── Webhook channel ────────────────────────────────────────────────────────

  describe('webhook channel', () => {
    it("POSTs the body to the step's own webhookUrl through the guarded fetch (t-794)", async () => {
      const ctx = makeCtx({ workflowId: 'wf-42', executionId: 'exec-99' });
      const step = makeWebhookStep({
        webhookUrl: 'https://hooks.example.com/notify',
        bodyTemplate: 'Build broke',
      });

      const result = await executor(step, ctx);

      expect(vi.mocked(executeHttpRequest)).toHaveBeenCalledOnce();
      const [req] = vi.mocked(executeHttpRequest).mock.calls[0];
      expect(req).toMatchObject({
        url: 'https://hooks.example.com/notify',
        method: 'POST',
        // The dispatch cache key, so a receiver that honours it dedups a re-drive.
        idempotency: { key: 'exec-99:notify-2' },
      });
      expect(JSON.parse(req.body as string)).toEqual({
        text: 'Build broke',
        workflowId: 'wf-42',
        workflowName: 'Test Workflow',
        executionId: 'exec-99',
        stepId: 'notify-2',
      });
      expect(result.output).toEqual({
        sent: true,
        channel: 'webhook',
        url: 'https://hooks.example.com/notify',
        status: 200,
      });
    });

    it("forwards the run's abort signal to the request", async () => {
      const controller = new AbortController();

      await executor(makeWebhookStep(), makeCtx({ signal: controller.signal }));

      expect(vi.mocked(executeHttpRequest).mock.calls[0][0].signal).toBe(controller.signal);
    });

    it('keeps a credential in the webhook URL out of the log line, but not out of the request or step output (#953)', async () => {
      const secret = 'AbCdEfGhIjKlMnOpQrStUvWx';
      const step = makeWebhookStep({
        webhookUrl: `https://hooks.slack.com/services/T0000/B0000/${secret}?token=qs-secret`,
      });

      const result = await executor(step, makeCtx());

      // The request has to reach the real URL, credential and all.
      expect(vi.mocked(executeHttpRequest).mock.calls[0][0].url).toBe(step.config.webhookUrl);
      // `output` is merged into the context (`{{steps.<id>.output.url}}`) and
      // rehydrated from the trace on resume, so it keeps the working URL.
      expect(result.output).toMatchObject({ url: step.config.webhookUrl });
      expect(logger.info).toHaveBeenCalledWith(
        'Notification step: webhook sent',
        expect.objectContaining({
          webhookUrl: 'https://hooks.slack.com/services/T0000/B0000/[param]',
        })
      );
      const logged = JSON.stringify(vi.mocked(logger.info).mock.calls);
      expect(logged).not.toContain(secret);
      expect(logged).not.toContain('qs-secret');
    });

    it("does not report sent: true when the request fails, and keeps the guard's retriable flag", async () => {
      vi.mocked(executeHttpRequest).mockRejectedValue(
        new HttpError('http_error_retriable', 'HTTP 503: unavailable', true, undefined, 503)
      );

      await expect(executor(makeWebhookStep(), makeCtx())).rejects.toMatchObject({
        name: 'ExecutorError',
        code: 'WEBHOOK_DISPATCH_ERROR',
        retriable: true,
      });
      expect(vi.mocked(recordDispatch)).not.toHaveBeenCalled();
    });

    it('fails without retry when the host is refused by the allowlist', async () => {
      vi.mocked(executeHttpRequest).mockRejectedValue(
        new HttpError(
          'host_not_allowed',
          'Host not in ORCHESTRATION_ALLOWED_HOSTS allowlist',
          false
        )
      );

      await expect(executor(makeWebhookStep(), makeCtx())).rejects.toMatchObject({
        name: 'ExecutorError',
        code: 'WEBHOOK_DISPATCH_ERROR',
        retriable: false,
        message: expect.stringContaining('ORCHESTRATION_ALLOWED_HOSTS'),
      });
    });

    it('does not retry a timeout or dropped connection: the receiver may have posted it', async () => {
      for (const code of ['request_timeout', 'request_failed'] as const) {
        vi.mocked(executeHttpRequest).mockRejectedValueOnce(new HttpError(code, 'gone', false));

        await expect(executor(makeWebhookStep(), makeCtx())).rejects.toMatchObject({
          code: 'WEBHOOK_DISPATCH_ERROR',
          retriable: false,
        });
      }
    });

    it('reads only a small reply, and counts a 2xx with a reply too large to read as sent', async () => {
      vi.mocked(executeHttpRequest).mockRejectedValue(
        new HttpError('response_too_large', 'Response exceeded 65536 bytes', false)
      );

      const result = await executor(makeWebhookStep(), makeCtx());

      expect(vi.mocked(executeHttpRequest).mock.calls[0][0].maxResponseBytes).toBe(64 * 1024);
      expect(result.output).toEqual({
        sent: true,
        channel: 'webhook',
        url: 'https://example.com/hook',
      });
      // Recorded, so a re-drive does not send it again.
      expect(vi.mocked(recordDispatch)).toHaveBeenCalledOnce();
    });

    it('fails without retry on a 4xx the receiver rejected', async () => {
      vi.mocked(executeHttpRequest).mockRejectedValue(
        new HttpError('http_error', 'HTTP 404: no_service', false, undefined, 404)
      );

      await expect(executor(makeWebhookStep(), makeCtx())).rejects.toMatchObject({
        code: 'WEBHOOK_DISPATCH_ERROR',
        retriable: false,
      });
    });

    it('treats a non-HttpError throw as retriable', async () => {
      vi.mocked(executeHttpRequest).mockRejectedValue('connection refused');

      await expect(executor(makeWebhookStep(), makeCtx())).rejects.toMatchObject({
        name: 'ExecutorError',
        code: 'WEBHOOK_DISPATCH_ERROR',
        retriable: true,
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

      expect(vi.mocked(executeHttpRequest)).not.toHaveBeenCalled();
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
    // The outer beforeEach resets sendEmail/executeHttpRequest but not the
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

    it('cache hit (webhook path): returns cached result without calling executeHttpRequest', async () => {
      // Arrange: prime the cache with a webhook-shaped result
      const cached = {
        output: { sent: true, channel: 'webhook', url: 'https://example.com/hook', status: 200 },
        tokensUsed: 0,
        costUsd: 0,
      };
      vi.mocked(lookupDispatch).mockResolvedValueOnce(cached);

      // Act
      const result = await executor(makeWebhookStep(), makeCtx());

      // Assert: short-circuit — executeHttpRequest never fires and no new record is written
      expect(vi.mocked(executeHttpRequest)).not.toHaveBeenCalled();
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
      // Arrange: cache miss is the default (null), executeHttpRequest resolves
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
          output: { sent: true, channel: 'webhook', url: 'https://example.com/hook', status: 200 },
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
