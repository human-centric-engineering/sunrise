/**
 * Tests: lib/app/ bootstrap files ship as no-op defaults
 *
 * The auto-wired bootstrap hooks (`lib/app/rate-limit.ts`, `lib/app/capabilities.ts`,
 * `lib/app/admin-nav.ts`) must register NOTHING out of the box — the template
 * ships them empty and forks fill them in. The wiring tests
 * (`bootstrap-wiring.test.ts`, `admin-nav-wiring.test.tsx`) replace these hooks
 * with registering versions; this file exercises the REAL defaults to lock in
 * the no-op contract (a stray default registration would silently apply to
 * every install).
 *
 * @see lib/app/rate-limit.ts · lib/app/capabilities.ts · lib/app/admin-nav.ts
 */

import { describe, it, expect, afterEach } from 'vitest';
import { registerAppRateLimits } from '@/lib/app/rate-limit';
import { initAppCapabilities } from '@/lib/app/capabilities';
import { initAppNav } from '@/lib/app/admin-nav';
import { getEffectiveRateLimitPolicy, RATE_LIMIT_POLICY } from '@/lib/security/rate-limit-policy';
import {
  getRegisteredNavSections,
  __resetNavRegistryForTests,
} from '@/lib/admin-nav/registry';

afterEach(() => {
  __resetNavRegistryForTests();
});

describe('lib/app/ bootstrap defaults are no-ops', () => {
  it('registerAppRateLimits registers no tiers or rules by default', () => {
    // Act — run the real (empty) hook
    registerAppRateLimits();

    // Assert — no app rules → the effective policy is the base policy by identity
    expect(getEffectiveRateLimitPolicy()).toBe(RATE_LIMIT_POLICY);
  });

  it('initAppCapabilities is a no-op by default', () => {
    // The real default does nothing and returns void; forks add
    // registerAppCapability() calls. (Behavioural reach into the dispatcher is
    // covered by bootstrap-wiring.test.ts.)
    expect(initAppCapabilities()).toBeUndefined();
  });

  it('initAppNav registers no admin nav sections by default', () => {
    // Arrange — clean registry
    __resetNavRegistryForTests();

    // Act — run the real (empty) hook
    initAppNav();

    // Assert — nothing registered
    expect(getRegisteredNavSections()).toHaveLength(0);
  });
});
