/**
 * Tests for the guard-floor seam — per-turn minimum modes for the inline
 * input / output / citation guards. A floor only ever RAISES a guard.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/app/guard-floor-contributors', () => ({
  initAppGuardFloorContributors: vi.fn(),
}));

const { logger } = await import('@/lib/logging');
const { initAppGuardFloorContributors } = await import('@/lib/app/guard-floor-contributors');
const {
  registerGuardFloorContributor,
  collectGuardFloors,
  applyGuardFloor,
  __resetGuardFloorContributorsForTests,
} = await import('@/lib/orchestration/chat/guard-floor');

const loggerError = logger.error as ReturnType<typeof vi.fn>;
const initMock = initAppGuardFloorContributors as ReturnType<typeof vi.fn>;

const req = { contextType: 'module', contextId: 'm1', agentId: 'agent-1' };

beforeEach(() => {
  vi.clearAllMocks();
  __resetGuardFloorContributorsForTests();
});

describe('applyGuardFloor', () => {
  it('returns the resolved mode unchanged when there is no floor for the guard', () => {
    expect(applyGuardFloor('input', 'log_only', {})).toBe('log_only');
    expect(applyGuardFloor('output', 'warn_and_continue', { input: 'block' })).toBe(
      'warn_and_continue'
    );
  });

  it('raises the resolved mode to a stricter floor', () => {
    expect(applyGuardFloor('input', 'log_only', { input: 'block' })).toBe('block');
    expect(applyGuardFloor('output', 'none', { output: 'warn_and_continue' })).toBe(
      'warn_and_continue'
    );
  });

  it('does NOT lower the resolved mode when the floor is weaker', () => {
    expect(applyGuardFloor('input', 'block', { input: 'log_only' })).toBe('block');
    expect(applyGuardFloor('citation', 'warn_and_continue', { citation: 'none' })).toBe(
      'warn_and_continue'
    );
  });

  it('treats an unrecognised resolved mode as least strict, so a floor still raises it', () => {
    expect(applyGuardFloor('input', 'garbage', { input: 'warn_and_continue' })).toBe(
      'warn_and_continue'
    );
  });
});

describe('collectGuardFloors', () => {
  it('returns {} with an empty registry (no behaviour change)', async () => {
    expect(await collectGuardFloors(req)).toEqual({});
  });

  it('returns a single contributor’s floors', async () => {
    registerGuardFloorContributor('policy', () => ({ output: 'warn_and_continue' }));
    expect(await collectGuardFloors(req)).toEqual({ output: 'warn_and_continue' });
  });

  it('passes the turn identity to the contributor', async () => {
    const contributor = vi.fn(() => ({ input: 'block' as const }));
    registerGuardFloorContributor('policy', contributor);
    await collectGuardFloors(req);
    expect(contributor).toHaveBeenCalledWith(req);
  });

  it('merges multiple contributors to the strictest per guard', async () => {
    registerGuardFloorContributor('a', () => ({ input: 'log_only', output: 'block' }));
    registerGuardFloorContributor('b', () => ({ input: 'block', citation: 'warn_and_continue' }));

    expect(await collectGuardFloors(req)).toEqual({
      input: 'block', // b beats a
      output: 'block',
      citation: 'warn_and_continue',
    });
  });

  it('awaits async contributors', async () => {
    registerGuardFloorContributor('async', async () => ({ input: 'block' }));
    expect(await collectGuardFloors(req)).toEqual({ input: 'block' });
  });

  it('ignores a contributor that throws — never fails the turn', async () => {
    registerGuardFloorContributor('boom', () => {
      throw new Error('policy bug');
    });
    registerGuardFloorContributor('ok', () => ({ output: 'block' }));

    expect(await collectGuardFloors(req)).toEqual({ output: 'block' });
    expect(loggerError).toHaveBeenCalledWith(
      'guard-floor: contributor threw — ignoring',
      expect.objectContaining({ contributorKey: 'boom', agentId: 'agent-1' })
    );
  });

  it('ignores an async contributor that rejects', async () => {
    registerGuardFloorContributor('reject', async () => {
      throw new Error('async policy bug');
    });
    expect(await collectGuardFloors(req)).toEqual({});
    expect(loggerError).toHaveBeenCalled();
  });

  it('ignores a malformed mode value returned by a contributor', async () => {
    registerGuardFloorContributor('bad', () => ({
      // A fork can't inject a bogus mode — unknown values are dropped.
      input: 'super_block' as unknown as 'block',
      output: 'block',
    }));
    expect(await collectGuardFloors(req)).toEqual({ output: 'block' });
  });

  it('re-registering a key replaces the prior contributor (idempotent by key)', async () => {
    registerGuardFloorContributor('policy', () => ({ input: 'block' }));
    registerGuardFloorContributor('policy', () => ({ input: 'log_only' }));
    expect(await collectGuardFloors(req)).toEqual({ input: 'log_only' });
  });

  it('runs the fork init exactly once across collections', async () => {
    registerGuardFloorContributor('policy', () => ({ input: 'block' }));
    await collectGuardFloors(req);
    await collectGuardFloors(req);
    expect(initMock).toHaveBeenCalledTimes(1);
  });

  it('catches a throwing fork init — degrades without failing the turn and does not retry', async () => {
    initMock.mockImplementationOnce(() => {
      throw new Error('init boom');
    });

    expect(await collectGuardFloors(req)).toEqual({});
    expect(loggerError).toHaveBeenCalledWith(
      'guard-floor: initAppGuardFloorContributors threw — app guard-floor contributors disabled',
      expect.objectContaining({ error: 'init boom' })
    );

    await collectGuardFloors(req);
    expect(initMock).toHaveBeenCalledTimes(1);
  });
});
