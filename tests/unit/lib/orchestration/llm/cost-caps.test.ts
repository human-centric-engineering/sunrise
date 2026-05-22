/**
 * Tests for the per-execution / per-turn cost-cap resolvers.
 *
 * The resolvers are pure (no DB / IO); these tests exhaust the resolution
 * matrix — caller > workflow > settings for the execution variant, agent
 * > settings for the turn variant — and the defensive `> 0 && finite`
 * filter that keeps a stale DB value from silently becoming a hard
 * "block everything" cap.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveMaxCostPerExecution,
  resolveMaxCostPerTurn,
} from '@/lib/orchestration/llm/cost-caps';

describe('resolveMaxCostPerExecution', () => {
  it('returns undefined when no layer sets a value', () => {
    expect(
      resolveMaxCostPerExecution({
        callerOverride: null,
        workflowDefault: null,
        settingsDefault: null,
      })
    ).toBeUndefined();
    expect(
      resolveMaxCostPerExecution({
        callerOverride: undefined,
        workflowDefault: undefined,
        settingsDefault: undefined,
      })
    ).toBeUndefined();
  });

  it('uses the caller override when set (even if workflow + settings also set)', () => {
    expect(
      resolveMaxCostPerExecution({
        callerOverride: 0.5,
        workflowDefault: 10,
        settingsDefault: 100,
      })
    ).toBe(0.5);
  });

  it('falls back to workflow default when caller is null', () => {
    expect(
      resolveMaxCostPerExecution({
        callerOverride: null,
        workflowDefault: 5,
        settingsDefault: 100,
      })
    ).toBe(5);
  });

  it('falls back to settings default when caller + workflow are null', () => {
    expect(
      resolveMaxCostPerExecution({
        callerOverride: null,
        workflowDefault: null,
        settingsDefault: 25,
      })
    ).toBe(25);
  });

  it('treats undefined and null identically', () => {
    expect(
      resolveMaxCostPerExecution({
        callerOverride: undefined,
        workflowDefault: 7,
        settingsDefault: undefined,
      })
    ).toBe(7);
  });

  it('skips a non-positive value (0, negative, NaN, Infinity) and tries the next layer', () => {
    // A stale DB row carrying 0 should not silently block every execution;
    // we skip and try the next layer.
    expect(
      resolveMaxCostPerExecution({
        callerOverride: 0,
        workflowDefault: 5,
        settingsDefault: 100,
      })
    ).toBe(5);
    expect(
      resolveMaxCostPerExecution({
        callerOverride: -1,
        workflowDefault: 5,
        settingsDefault: 100,
      })
    ).toBe(5);
    expect(
      resolveMaxCostPerExecution({
        callerOverride: Number.NaN,
        workflowDefault: 5,
        settingsDefault: 100,
      })
    ).toBe(5);
    expect(
      resolveMaxCostPerExecution({
        callerOverride: Number.POSITIVE_INFINITY,
        workflowDefault: 5,
        settingsDefault: 100,
      })
    ).toBe(5);
  });

  it('returns undefined when every layer is non-positive', () => {
    expect(
      resolveMaxCostPerExecution({
        callerOverride: 0,
        workflowDefault: -2,
        settingsDefault: Number.NaN,
      })
    ).toBeUndefined();
  });
});

describe('resolveMaxCostPerTurn', () => {
  it('returns undefined when neither layer is set', () => {
    expect(resolveMaxCostPerTurn({ agentDefault: null, settingsDefault: null })).toBeUndefined();
  });

  it('uses the agent value when set', () => {
    expect(resolveMaxCostPerTurn({ agentDefault: 0.05, settingsDefault: 1 })).toBe(0.05);
  });

  it('falls back to settings default when the agent value is null', () => {
    expect(resolveMaxCostPerTurn({ agentDefault: null, settingsDefault: 0.5 })).toBe(0.5);
  });

  it('skips a non-positive agent value and falls through to settings', () => {
    expect(resolveMaxCostPerTurn({ agentDefault: 0, settingsDefault: 0.5 })).toBe(0.5);
    expect(resolveMaxCostPerTurn({ agentDefault: -1, settingsDefault: 0.5 })).toBe(0.5);
  });
});
