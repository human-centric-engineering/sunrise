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
 * silently exercised the undefined path — `TENANCY_MODE` and
 * `CAPABILITY_BINDING_MODE` are both this shape, and so was `MCP_SESSION_MODE`
 * until §39 t-718 removed it. A downstream implementation of the MCP change had
 * 40 tests pass against a stateless branch none of them entered, for exactly
 * this reason.
 *
 * **79** test files reference `@/lib/env` and **5** of them opt into a DOM,
 * measured 2026-09-24. `.context/testing/environments.md` carries the command
 * that produces those two numbers — it is not repeated here, because writing the
 * directive token in prose inside a TEST file is the trap
 * `tests/unit/vitest-environment-directives.test.ts` exists to catch: vitest
 * matches the first occurrence anywhere in the file, comments included, so a
 * quoted example can silently move the whole file to another environment. An
 * earlier version of this very docblock did exactly that and CI caught it.
 * Re-derive the figure rather than trusting it: it has already drifted twice,
 * reading 37/47 in one place and 44/47 in two others, all written when the suite
 * was smaller.
 *
 * Tests that need to VARY a mode still mock `@/lib/env` — the value is read at
 * module load, so `process.env` cannot be moved per case. But a mock cannot tell
 * you what the SHIPPED DEFAULT is, and for a mode whose default is the whole
 * behaviour, the default is the thing worth asserting. That is what this file is
 * for.
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
