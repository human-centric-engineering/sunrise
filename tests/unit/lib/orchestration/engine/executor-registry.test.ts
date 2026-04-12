/**
 * Tests for the BE executor registry.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetRegistryForTests,
  getExecutor,
  getRegisteredTypes,
  registerStepType,
  type StepExecutor,
} from '@/lib/orchestration/engine/executor-registry';
import { KNOWN_STEP_TYPES } from '@/types/orchestration';

const makeStub = (name: string): StepExecutor =>
  vi.fn(async () => ({ output: name, tokensUsed: 0, costUsd: 0 }));

describe('executor-registry', () => {
  beforeEach(() => {
    __resetRegistryForTests();
  });

  afterEach(() => {
    __resetRegistryForTests();
  });

  it('registers and retrieves an executor', () => {
    const stub = makeStub('a');
    registerStepType('llm_call', stub);
    expect(getExecutor('llm_call')).toBe(stub);
  });

  it('overrides a previously registered executor', () => {
    registerStepType('llm_call', makeStub('first'));
    const second = makeStub('second');
    registerStepType('llm_call', second);
    expect(getExecutor('llm_call')).toBe(second);
  });

  it('throws when looking up an unregistered type', () => {
    expect(() => getExecutor('chain')).toThrow(/No executor registered/);
  });

  it('exposes the registered type set', () => {
    registerStepType('plan', makeStub('plan'));
    registerStepType('chain', makeStub('chain'));
    expect(new Set(getRegisteredTypes())).toEqual(new Set(['plan', 'chain']));
  });

  it('loading the executors barrel registers every KNOWN_STEP_TYPE', async () => {
    // Re-import the barrel so its side-effects fire against a clean registry.
    await import('@/lib/orchestration/engine/executors');
    const registered = new Set(getRegisteredTypes());
    for (const t of KNOWN_STEP_TYPES) {
      expect(registered.has(t)).toBe(true);
    }
  });
});
