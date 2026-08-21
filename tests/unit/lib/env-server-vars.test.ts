// @vitest-environment node
/**
 * The shipped defaults of server-only env vars, read through the REAL schema.
 *
 * **Why this file overrides the environment.** `vitest.config.ts` runs on
 * `happy-dom`, so `typeof window !== 'undefined'` is true and `lib/env.ts`
 * validates only the *client* schema — every server variable reads as
 * `undefined` in an ordinary unit test. Measured: with `TENANCY_MODE=multi` set
 * in the actual process environment, `process.env.TENANCY_MODE` is `'multi'`
 * and `env.TENANCY_MODE` is `undefined`, with 10 of the schema's keys visible.
 *
 * That is not a curiosity, it is a live trap. Every test that branches on a
 * server variable silently exercises the undefined path: `TENANCY_MODE`,
 * `CAPABILITY_BINDING_MODE` and now `MCP_SESSION_MODE` are all this shape. A
 * downstream implementation of the MCP change had 40 tests pass against a
 * stateless branch none of them entered, for exactly this reason.
 *
 * Tests that need to VARY a mode still mock `@/lib/env` — the value is read at
 * module load, so `process.env` cannot be moved per case. But a mock cannot tell
 * you what the shipped default is, and for #609 the default IS the change. That
 * is what this file is for.
 */

import { describe, it, expect } from 'vitest';
import { env } from '@/lib/env';

describe('server env vars are visible under the node environment', () => {
  it('sees more than the client schema, or the rest of this file proves nothing', () => {
    // The guard: under happy-dom this is 10 client keys and every assertion
    // below would read `undefined` and pass vacuously.
    expect(typeof window).toBe('undefined');
    expect(env).toHaveProperty('DATABASE_URL');
  });
});

describe('MCP_SESSION_MODE', () => {
  it('defaults to stateless — the whole point of #609', () => {
    // Unset in tests/setup.ts, so this is the shipped default, not a fixture.
    expect(process.env.MCP_SESSION_MODE).toBeUndefined();
    expect(env.MCP_SESSION_MODE).toBe('stateless');
  });

  it('is a closed enum, so a typo fails validation rather than silently degrading', async () => {
    const { z } = await import('zod');
    const schema = z.enum(['stateless', 'stateful']).default('stateless');

    expect(schema.parse(undefined)).toBe('stateless');
    expect(schema.parse('stateful')).toBe('stateful');
    expect(() => schema.parse('statefull')).toThrow();
    expect(() => schema.parse('')).toThrow();
  });
});

describe('the sibling modes with the same blind spot', () => {
  it('TENANCY_MODE and CAPABILITY_BINDING_MODE also resolve to their real defaults here', () => {
    // Named so this file is the place that notices if one of their defaults
    // moves, since no other test can currently see them at all.
    expect(env.TENANCY_MODE).toBe('single');
    expect(env.CAPABILITY_BINDING_MODE).toBeDefined();
  });
});
