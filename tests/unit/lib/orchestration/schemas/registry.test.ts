import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';

import {
  getSchema,
  hasSchema,
  listSchemaNames,
  registerSchema,
  resetSchemaRegistry,
  unregisterSchema,
} from '@/lib/orchestration/schemas/registry';

/**
 * Schema-registry contract tests. The registry is a global Map keyed
 * by string slug, so we reset it between tests to prevent registration
 * order from creating spooky-action-at-a-distance failures.
 */

describe('schema registry', () => {
  beforeEach(() => {
    resetSchemaRegistry();
  });

  it('round-trips a registered schema', () => {
    const schema = z.object({ x: z.string() });
    registerSchema('demo', schema);
    expect(getSchema('demo')).toBe(schema);
    expect(hasSchema('demo')).toBe(true);
  });

  it('returns undefined for unregistered names', () => {
    expect(getSchema('missing')).toBeUndefined();
    expect(hasSchema('missing')).toBe(false);
  });

  it('throws on duplicate registration — catches import-order swap bugs', () => {
    registerSchema('demo', z.string());
    // Re-registering would silently swap the schema out from under
    // live executors. Throw instead so test runs surface the bug.
    expect(() => registerSchema('demo', z.number())).toThrow(/already registered/);
  });

  it('rejects empty names — guards against accidental registration with a falsy slug', () => {
    expect(() => registerSchema('', z.string())).toThrow(/non-empty string/);
  });

  it('listSchemaNames returns a sorted snapshot', () => {
    registerSchema('charlie', z.string());
    registerSchema('alpha', z.string());
    registerSchema('bravo', z.string());
    expect(listSchemaNames()).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('unregisterSchema removes the entry and returns true; false when absent', () => {
    registerSchema('demo', z.string());
    expect(unregisterSchema('demo')).toBe(true);
    expect(hasSchema('demo')).toBe(false);
    // Second unregister is a no-op signalled by the return value.
    expect(unregisterSchema('demo')).toBe(false);
  });

  it('resetSchemaRegistry clears everything', () => {
    registerSchema('one', z.string());
    registerSchema('two', z.string());
    resetSchemaRegistry();
    expect(listSchemaNames()).toEqual([]);
  });
});
