// @vitest-environment node
/**
 * The shipped defaults of server-only env vars, read through the REAL schema.
 *
 * **Why this file still pins the environment.** `vitest.config.ts` now defaults
 * to `node`, so this directive is belt-and-braces rather than the override it
 * originally was — but it stays, because the file's assertions are only
 * meaningful under node and a future default flip should break loudly here
 * rather than turn every assertion below vacuous.
 *
 * The trap it documents was real for the whole suite until the default changed.
 * Under `happy-dom`, `typeof window !== 'undefined'` is true and `lib/env.ts`
 * validates only the *client* schema — every server variable reads as
 * `undefined`. Measured: with `TENANCY_MODE=multi` set in the actual process
 * environment, `process.env.TENANCY_MODE` is `'multi'` and `env.TENANCY_MODE`
 * is `undefined`, with 10 of the schema's keys visible.
 *
 * That was not a curiosity, it was a live trap, and it is the reason the suite
 * default moved to `node`: every test that branches on a server variable
 * silently exercised the undefined path — `TENANCY_MODE`,
 * `CAPABILITY_BINDING_MODE` and `MCP_SESSION_MODE` are all this shape. A
 * downstream implementation of the MCP change had 40 tests pass against a
 * stateless branch none of them entered, for exactly this reason. 37 of the 47
 * test files importing `@/lib/env` now run under node and see the real schema;
 * the 10 that still opt into happy-dom are component tests, where the client
 * schema is the correct one.
 *
 * Tests that need to VARY a mode still mock `@/lib/env` — the value is read at
 * module load, so `process.env` cannot be moved per case. But a mock cannot tell
 * you what the shipped default is, and for #609 the default IS the change. That
 * is what this file is for.
 */

import { describe, it, expect, vi } from 'vitest';
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
  it('defaults to stateless — the whole point of #609', async () => {
    // Deleted and RE-IMPORTED rather than asserting `process.env` is already
    // unset. The first version asserted `toBeUndefined()`, which made the result
    // depend on the developer's shell: anyone with `MCP_SESSION_MODE` exported —
    // plausible while debugging this very feature — got a red bar on a test
    // whose subject (the schema default) was perfectly correct.
    //
    // Deleting before the import is what actually establishes the claim: with
    // the variable absent, the schema supplies `stateless`.
    const saved = process.env.MCP_SESSION_MODE;
    try {
      delete process.env.MCP_SESSION_MODE;
      vi.resetModules();
      const { env: reloaded } = await import('@/lib/env');
      expect(reloaded.MCP_SESSION_MODE).toBe('stateless');
    } finally {
      if (saved !== undefined) process.env.MCP_SESSION_MODE = saved;
      vi.resetModules();
    }
  });

  it('is a closed enum, so a typo fails validation rather than silently degrading', async () => {
    // Through the REAL module. The first version of this built its own
    // `z.enum([...])` locally and asserted on that — which tests zod, not
    // `lib/env.ts`: loosening the real schema to `z.string()` left it green.
    //
    // The consequence of that gap is exactly #609 reappearing.
    // `MCP_SESSION_MODE=statefull` would parse; `isStateless()` compares
    // `=== 'stateless'` so the STATEFUL path runs, and the serverless guard
    // compares `=== 'stateful'` so it never fires. Stateful sessions on Vercel
    // with the guard silently disarmed.
    const saved = process.env.MCP_SESSION_MODE;
    try {
      process.env.MCP_SESSION_MODE = 'statefull';
      vi.resetModules();
      await expect(import('@/lib/env')).rejects.toThrow(/Environment validation failed/);
    } finally {
      if (saved === undefined) delete process.env.MCP_SESSION_MODE;
      else process.env.MCP_SESSION_MODE = saved;
      vi.resetModules();
    }
  });

  it('accepts the two real values through the real module', async () => {
    // The counterpart, or the rejection above would pass against a schema that
    // rejects everything.
    for (const mode of ['stateless', 'stateful']) {
      const saved = process.env.MCP_SESSION_MODE;
      try {
        process.env.MCP_SESSION_MODE = mode;
        vi.resetModules();
        const { env: reloaded } = await import('@/lib/env');
        expect(reloaded.MCP_SESSION_MODE).toBe(mode);
      } finally {
        if (saved === undefined) delete process.env.MCP_SESSION_MODE;
        else process.env.MCP_SESSION_MODE = saved;
        vi.resetModules();
      }
    }
  });
});

describe('the sibling modes with the same blind spot', () => {
  it('TENANCY_MODE and CAPABILITY_BINDING_MODE also resolve to their real defaults here', () => {
    // Named so this file is the place that notices if one of their defaults
    // moves, since no other test can currently see them at all.
    expect(env.TENANCY_MODE).toBe('single');
    // `toBeDefined()` was here and pinned nothing — moving this default from
    // `permissive` to `strict` left the file green.
    expect(env.CAPABILITY_BINDING_MODE).toBe('permissive');
  });
});
