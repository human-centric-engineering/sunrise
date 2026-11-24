/**
 * The lazy-init seams `tests/setup.ts` pins are actually pinned.
 *
 * Each pin replaces a `lib/app/*` scaffold's init with a no-op for every test
 * file, so a fork that fills the seam does not have its registrations run
 * inside core tests and fail them for reasons the fork cannot fix (#1125,
 * #1139, #1324). A pin that is missing, or that stops replacing the init, is
 * silent in Sunrise, where the real init is a no-op too: it shows up only in a
 * fork, as core tests failing. This asserts the replacement itself, which
 * Sunrise can see.
 *
 * Reads past the pins with `vi.importActual`, so it is listed as a reader of
 * each seam in `tests/unit/lib/app/defaults.test.ts`.
 *
 * FORK NOTE: filling any of these seams does not change what this measures.
 * It compares which function the suite sees with the real one, never what
 * your init registers, so it passes with your seams filled. It fails only if
 * a pin is removed from tests/setup.ts, which would let your registrations run
 * inside core tests: keep the pins, and add a row here if you pin a seam of
 * your own the same way.
 */

import { describe, expect, it, vi } from 'vitest';

const PINNED_INITS = [
  ['@/lib/app/admin-tier', 'initAppOrgTierAdminPages'],
  ['@/lib/app/user-created', 'initAppUserCreatedHooks'],
  ['@/lib/app/erasure', 'initAppErasureHooks'],
  ['@/lib/app/org-created', 'initAppOrgCreatedHooks'],
  ['@/lib/app/signup-org', 'initAppSignupOrgResolver'],
  ['@/lib/app/model-pins', 'initAppModelPins'],
  ['@/lib/app/entitlements', 'initAppEntitlements'],
] as const;

describe('tests/setup.ts seam pins', () => {
  it.each(PINNED_INITS)('%s has its %s replaced for every test file', async (seam, init) => {
    const seen: Record<string, unknown> = await import(seam);
    const real = await vi.importActual<Record<string, unknown>>(seam);

    expect(typeof real[init], `${seam} no longer exports ${init}`).toBe('function');
    expect(typeof seen[init]).toBe('function');
    expect(
      seen[init],
      `${seam}'s ${init} reaches core tests unpinned: a fork that fills it would have its ` +
        'registrations run inside the core suite. Pin it in tests/setup.ts.'
    ).not.toBe(real[init]);
  });
});
