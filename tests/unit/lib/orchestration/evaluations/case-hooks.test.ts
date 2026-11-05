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
    expect(evalCaseHooksFor('score-assistant')?.setup).toBe(setup);
    expect(evalCaseHooksFor('other-agent')).toBeNull();
    expect(registeredEvalCaseHookAgents()).toEqual(['score-assistant']);
    expect(seam.init).toHaveBeenCalledTimes(1);
  });

  it('rolls every registration back when the seam throws part-way', () => {
    seam.init.mockImplementation(() => {
      registerEvalCaseHooks('first', { observe: () => 1 });
      throw new Error('fork bug');
    });

    expect(evalCaseHooksFor('first')).toBeNull();
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

    expect(evalCaseHooksFor('agent')?.observe).toBe(second);
    expect(logger.warn).toHaveBeenCalledWith(
      'registerEvalCaseHooks: replacing the hooks already registered',
      { agentSlug: 'agent' }
    );
  });
});

describe('parseEvalCaseContext', () => {
  it('reads no answer as no context, and keeps the four fields', () => {
    expect(parseEvalCaseContext(undefined)).toEqual({});
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
    expect(() => parseEvalCaseContext(null)).toThrow(/invalid context/);
    expect(() => parseEvalCaseContext('score')).toThrow(/invalid context/);
  });
});
