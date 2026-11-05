/**
 * Tests: lib/orchestration/evaluations/case-hooks.ts — the per-agent eval case
 * hook registry (#879, t-987).
 *
 * The fork seam is mocked so each case decides what `initAppEvalCaseHooks()`
 * registers, and so a fork that fills the real seam leaves these answers alone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const seam = vi.hoisted(() => ({ init: vi.fn<() => void>() }));

vi.mock('@/lib/app/evaluations', () => ({
  initAppGraders: vi.fn(),
  initAppEvalCaseHooks: () => seam.init(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  __resetEvalCaseHooksForTests,
  evalCaseHooksFor,
  parseEvalCaseContext,
  registerEvalCaseHooks,
  registeredEvalCaseHookAgents,
} from '@/lib/orchestration/evaluations/case-hooks';
import { logger } from '@/lib/logging';

beforeEach(() => {
  __resetEvalCaseHooksForTests();
  seam.init.mockReset();
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.error).mockClear();
});

describe('the hook registry', () => {
  it('runs the fork seam once, before the first lookup, and finds what it registered', () => {
    const setup = vi.fn();
    seam.init.mockImplementation(() => registerEvalCaseHooks('score-assistant', { setup }));

    expect(seam.init).not.toHaveBeenCalled();
    void evalCaseHooksFor('score-assistant')?.setup?.({} as never);
    expect(setup).toHaveBeenCalledTimes(1);
    expect(evalCaseHooksFor('other-agent')).toBeNull();
    expect(registeredEvalCaseHookAgents()).toEqual(['score-assistant']);
    expect(seam.init).toHaveBeenCalledTimes(1);
  });

  it('rolls every registration back when the seam throws, and refuses lookups after', () => {
    seam.init.mockImplementation(() => {
      registerEvalCaseHooks('first', { observe: () => 1 });
      throw new Error('fork bug');
    });

    // Which agents it meant to hook is unknown, so no agent's case runs as if
    // it had none: a case scored without its setup would read stale state.
    expect(() => evalCaseHooksFor('first')).toThrow(
      "the fork's eval case hooks failed to load: fork bug"
    );
    expect(() => evalCaseHooksFor('any-agent')).toThrow(/failed to load/);
    expect(registeredEvalCaseHookAgents()).toEqual([]);
    expect(logger.error).toHaveBeenCalled();
  });

  it('refuses an empty slug, a hook that is not a function, and no hook at all', () => {
    expect(() => registerEvalCaseHooks('  ', { setup: () => undefined })).toThrow(/agentSlug/);
    expect(() =>
      registerEvalCaseHooks('a', { setup: 'reset' as unknown as () => undefined })
    ).toThrow(/setup is not a function/);
    expect(() => registerEvalCaseHooks('a', { observe: 42 as unknown as () => unknown })).toThrow(
      /observe is not a function/
    );
    expect(() => registerEvalCaseHooks('a', {})).toThrow(/setup, an observe, or both/);
  });

  it('replaces an agent’s hooks when registered again, and says so', () => {
    const first = vi.fn();
    const second = vi.fn();
    registerEvalCaseHooks('agent', { observe: first });
    registerEvalCaseHooks('agent', { observe: second });

    void evalCaseHooksFor('agent')?.observe?.({} as never);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'registerEvalCaseHooks: replacing the hooks already registered',
      { agentSlug: 'agent' }
    );
  });
});

describe('parseEvalCaseContext', () => {
  it('reads no answer as no context, and keeps the four fields', () => {
    expect(parseEvalCaseContext(undefined)).toEqual({});
    expect(parseEvalCaseContext(null)).toEqual({});
    const full = {
      contextType: 'score',
      contextId: 'doc-1',
      entityContext: { bars: 4 },
      scope: { module: 'scores' },
    };
    expect(parseEvalCaseContext(full)).toEqual(full);
  });

  it('refuses an unknown key, a wrong type and a non-object, naming the problem', () => {
    expect(() => parseEvalCaseContext({ conversationId: 'c1' })).toThrow(/invalid context/);
    expect(() => parseEvalCaseContext({ contextId: 7 })).toThrow(/contextId/);
    expect(() => parseEvalCaseContext({ scope: { module: 1 } })).toThrow(/scope/);
    // One without the other: the turn would run with no context and no error.
    expect(() => parseEvalCaseContext({ contextId: 'doc-1' })).toThrow(/go together/);
    expect(() => parseEvalCaseContext({ contextType: 'score' })).toThrow(/go together/);
    // The chat API's own limits.
    expect(() =>
      parseEvalCaseContext({ contextType: 'score', contextId: 'x'.repeat(101) })
    ).toThrow(/contextId/);
    expect(() => parseEvalCaseContext({ contextType: '', contextId: 'd' })).toThrow(/contextType/);
    // The manual-session flag: a batch case must never write that session's log.
    expect(() => parseEvalCaseContext({ contextType: 'evaluation', contextId: 's1' })).toThrow(
      /reserved for manual sessions/
    );
    expect(() => parseEvalCaseContext('score')).toThrow(/invalid context/);
  });
});
