/**
 * Tests for the guard-events seam — post-detection, fire-and-forget observation
 * of an inline guard firing. Emission must never delay or break the turn.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/app/guard-event-contributors', () => ({
  initAppGuardEventContributors: vi.fn(),
}));

const { logger } = await import('@/lib/logging');
const { initAppGuardEventContributors } = await import('@/lib/app/guard-event-contributors');
const { registerGuardEventContributor, emitGuardEvent, __resetGuardEventContributorsForTests } =
  await import('@/lib/orchestration/chat/guard-events');

const loggerError = logger.error as ReturnType<typeof vi.fn>;
const initMock = initAppGuardEventContributors as ReturnType<typeof vi.fn>;

const ctx = {
  contextType: 'facilitation',
  contextId: 'role-1',
  agentId: 'agent-1',
  userId: 'user-1',
  conversationId: 'conv-1',
};

/** Flush the microtask + macrotask queues so fire-and-forget contributors run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  __resetGuardEventContributorsForTests();
});

describe('emitGuardEvent', () => {
  it('is a no-op with an empty registry (returns void, does not throw)', () => {
    expect(() => emitGuardEvent(ctx, 'input', 'block')).not.toThrow();
  });

  it('delivers (context, event) to a registered contributor', async () => {
    const observer = vi.fn();
    registerGuardEventContributor('obs', observer);

    emitGuardEvent(ctx, 'output', 'warn_and_continue');
    await flush();

    expect(observer).toHaveBeenCalledWith(ctx, {
      guard: 'output',
      outcome: 'warn_and_continue',
    });
  });

  it('is fire-and-forget — the contributor runs AFTER emit returns', async () => {
    let ran = false;
    registerGuardEventContributor('obs', () => {
      ran = true;
    });

    emitGuardEvent(ctx, 'input', 'block');
    // Deferred to a microtask: not yet run synchronously.
    expect(ran).toBe(false);

    await flush();
    expect(ran).toBe(true);
  });

  it('normalises an unrecognised mode to outcome "none"', async () => {
    const observer = vi.fn();
    registerGuardEventContributor('obs', observer);

    emitGuardEvent(ctx, 'citation', 'bogus_mode');
    await flush();

    expect(observer).toHaveBeenCalledWith(ctx, { guard: 'citation', outcome: 'none' });
  });

  it('passes every valid mode through as the outcome', async () => {
    const observer = vi.fn();
    registerGuardEventContributor('obs', observer);

    for (const mode of ['none', 'log_only', 'warn_and_continue', 'block'] as const) {
      emitGuardEvent(ctx, 'input', mode);
    }
    await flush();

    const outcomes = observer.mock.calls.map((c) => (c[1] as { outcome: string }).outcome);
    expect(outcomes).toEqual(['none', 'log_only', 'warn_and_continue', 'block']);
  });

  it('delivers to every registered contributor', async () => {
    const a = vi.fn();
    const b = vi.fn();
    registerGuardEventContributor('a', a);
    registerGuardEventContributor('b', b);

    emitGuardEvent(ctx, 'input', 'block');
    await flush();

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('swallows a synchronous throw and still runs the other contributors', async () => {
    const good = vi.fn();
    registerGuardEventContributor('boom', () => {
      throw new Error('observer bug');
    });
    registerGuardEventContributor('good', good);

    emitGuardEvent(ctx, 'input', 'block');
    await flush();

    expect(good).toHaveBeenCalledTimes(1);
    expect(loggerError).toHaveBeenCalledWith(
      'guard-events: contributor threw — ignoring',
      expect.objectContaining({ contributorKey: 'boom', agentId: 'agent-1', guard: 'input' })
    );
  });

  it('swallows an async rejection', async () => {
    registerGuardEventContributor('reject', async () => {
      throw new Error('async observer bug');
    });

    emitGuardEvent(ctx, 'input', 'block');
    await flush();

    expect(loggerError).toHaveBeenCalledWith(
      'guard-events: contributor threw — ignoring',
      expect.objectContaining({ contributorKey: 'reject' })
    );
  });

  it('re-registering a key replaces the prior contributor (idempotent by key)', async () => {
    const first = vi.fn();
    const second = vi.fn();
    registerGuardEventContributor('obs', first);
    registerGuardEventContributor('obs', second);

    emitGuardEvent(ctx, 'input', 'block');
    await flush();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('runs the fork init exactly once across emits', async () => {
    registerGuardEventContributor('obs', vi.fn());
    emitGuardEvent(ctx, 'input', 'block');
    emitGuardEvent(ctx, 'output', 'block');
    await flush();
    expect(initMock).toHaveBeenCalledTimes(1);
  });

  it('catches a throwing fork init — degrades without failing, does not retry', async () => {
    initMock.mockImplementationOnce(() => {
      throw new Error('init boom');
    });

    expect(() => emitGuardEvent(ctx, 'input', 'block')).not.toThrow();
    expect(loggerError).toHaveBeenCalledWith(
      'guard-events: initAppGuardEventContributors threw — app guard-event contributors disabled',
      expect.objectContaining({ error: 'init boom' })
    );

    emitGuardEvent(ctx, 'output', 'block');
    expect(initMock).toHaveBeenCalledTimes(1);
  });
});
