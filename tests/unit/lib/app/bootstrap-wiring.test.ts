/**
 * Tests: lib/app/ bootstrap auto-wiring (server-side realms)
 *
 * The `lib/app/` extension files ship as no-op defaults; their value is that a
 * CORE consumer imports and invokes each one in the right runtime, so a fork's
 * registrations take effect with zero wiring. These tests prove the wiring is
 * live by swapping a `lib/app/` file for one that registers a known artifact
 * and asserting it reaches the registry the consumer feeds:
 *
 * - rate-limit: `rate-limit-middleware.ts` calls `registerAppRateLimits()` at
 *   module load (middleware realm) → the rule/tier land in the effective policy.
 * - capabilities: `registerBuiltInCapabilities()` calls `initAppCapabilities()`
 *   once (server route-handler realm) → the capability reaches the dispatcher.
 *
 * (The nav wire — client realm — is covered in `admin-nav-wiring.test.tsx`.)
 *
 * @see lib/app/rate-limit.ts · lib/app/capabilities.ts
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

// The middleware imports auth + logging; the capability registry imports prisma
// + logging. Stub the external boundaries so importing the consumers is cheap.
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiCapability: { findMany: vi.fn().mockResolvedValue([]) },
    aiAgentCapability: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

afterEach(() => {
  vi.doUnmock('@/lib/app/rate-limit');
  vi.doUnmock('@/lib/app/capabilities');
  vi.resetModules();
});

describe('rate-limit auto-wire (lib/app/rate-limit.ts → middleware realm)', () => {
  it('runs registerAppRateLimits at middleware load; the app tier + rule take effect', async () => {
    // Arrange — the app hook registers a namespace-scoped tier + rule
    vi.resetModules();
    vi.doMock('@/lib/app/rate-limit', async () => {
      const rl = await vi.importActual<typeof import('@/lib/security/rate-limit')>(
        '@/lib/security/rate-limit'
      );
      const policy = await vi.importActual<typeof import('@/lib/security/rate-limit-policy')>(
        '@/lib/security/rate-limit-policy'
      );
      return {
        registerAppRateLimits: (): void => {
          rl.registerRateLimitTier(
            'wiretest',
            rl.createRateLimiter({ interval: 60_000, maxRequests: 3 })
          );
          policy.registerRateLimitRule({
            match: /^\/api\/v1\/wiretest\//,
            tier: 'wiretest',
            key: 'ip',
          });
        },
      };
    });

    // Act — importing the middleware triggers its top-level registerAppRateLimits() call
    await import('@/lib/security/rate-limit-middleware');
    const { getEffectiveRateLimitPolicy } = await import('@/lib/security/rate-limit-policy');
    const { resolveRateLimitTier } = await import('@/lib/security/rate-limit');

    // Assert — the rule is spliced into the effective policy ahead of the catch-all,
    // and the app tier resolves. If the middleware didn't auto-call the hook, neither holds.
    const eff = getEffectiveRateLimitPolicy();
    const appRule = eff.find(
      (r) => r.match instanceof RegExp && r.match.test('/api/v1/wiretest/x')
    );
    expect(appRule, 'app rule should be in the effective policy').toBeDefined();
    expect(appRule?.tier).toBe('wiretest');
    expect(eff[eff.length - 1].key, 'catch-all stays last').toBe('session-user');
    expect(resolveRateLimitTier('wiretest')).toBeDefined();
  });

  it('default lib/app/rate-limit is a no-op (effective policy is the base policy by identity)', async () => {
    // Arrange — no doMock: the real (empty) registerAppRateLimits runs
    vi.resetModules();

    // Act
    await import('@/lib/security/rate-limit-middleware');
    const { getEffectiveRateLimitPolicy, RATE_LIMIT_POLICY } =
      await import('@/lib/security/rate-limit-policy');

    // Assert — no app rules registered → identity return (no allocation, no extra rule)
    expect(getEffectiveRateLimitPolicy()).toBe(RATE_LIMIT_POLICY);
  });

  it('aborts boot when an app rule references an unregistered tier (finding #6 integrity check)', async () => {
    // Without the integrity check, a typo in `tier` (rule names 'billling',
    // limiter registered as 'billing') would type-check fine and then silently
    // fail open at request time — `resolveRateLimitTier` returns undefined, the
    // middleware logs a warning and applies NO rate limit. The check at the
    // end of the auto-wire block converts that runtime hole into a fail-fast
    // boot error naming the offending rule and tier.
    vi.resetModules();
    vi.doMock('@/lib/app/rate-limit', async () => {
      const policy = await vi.importActual<typeof import('@/lib/security/rate-limit-policy')>(
        '@/lib/security/rate-limit-policy'
      );
      return {
        registerAppRateLimits: (): void => {
          // Register a rule whose tier is NEVER registered as a limiter.
          policy.registerRateLimitRule({
            match: /^\/api\/v1\/billing\//,
            tier: 'billling', // typo on purpose
            key: 'ip',
          });
        },
      };
    });

    // Act + Assert — boot throws, naming the unresolved tier
    await expect(import('@/lib/security/rate-limit-middleware')).rejects.toThrow(
      /unknown tier.*billling/i
    );
  });

  it('accepts the boot when every app rule references a tier that resolves', async () => {
    // Positive control for the integrity check: when the tier IS registered,
    // boot succeeds. Pairs with the negative test above so a regression in
    // the integrity check (always-throw / never-throw) shows up.
    vi.resetModules();
    vi.doMock('@/lib/app/rate-limit', async () => {
      const rl = await vi.importActual<typeof import('@/lib/security/rate-limit')>(
        '@/lib/security/rate-limit'
      );
      const policy = await vi.importActual<typeof import('@/lib/security/rate-limit-policy')>(
        '@/lib/security/rate-limit-policy'
      );
      return {
        registerAppRateLimits: (): void => {
          rl.registerRateLimitTier(
            'integrity-cap',
            rl.createRateLimiter({ interval: 60_000, maxRequests: 5 })
          );
          policy.registerRateLimitRule({
            match: /^\/api\/v1\/integrity\//,
            tier: 'integrity-cap',
            key: 'ip',
          });
        },
      };
    });

    // Should NOT throw — the rule's tier resolves cleanly.
    await expect(import('@/lib/security/rate-limit-middleware')).resolves.toBeDefined();
  });

  it('annotates and re-throws when registerAppRateLimits throws at module load', async () => {
    // Without the try/catch, a misconfigured registration in lib/app/rate-limit.ts
    // (e.g. a matcher that shadows a protected path) propagates out of the
    // middleware module → `proxy.ts` fails to load → every request 500s with
    // a generic stack that does NOT name lib/app/rate-limit.ts. The wrap MUST
    // (a) log a structured pointer to that file, AND (b) re-throw — swallowing
    // would let the misconfiguration ship silently, defeating fail-fast.
    vi.resetModules();
    const errorSpy = vi.fn();
    vi.doMock('@/lib/logging', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: errorSpy, debug: vi.fn() },
    }));
    vi.doMock('@/lib/app/rate-limit', () => ({
      registerAppRateLimits: (): void => {
        throw new Error('boom — simulated fork misconfiguration');
      },
    }));

    // Act + Assert — importing the middleware re-throws
    await expect(import('@/lib/security/rate-limit-middleware')).rejects.toThrow(
      /boom — simulated fork misconfiguration/
    );
    // ...and the diagnostic log named the offending file before re-throwing.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message, context] = errorSpy.mock.calls[0];
    expect(message).toMatch(/lib\/app\/rate-limit\.ts/);
    expect((context as { error: string }).error).toMatch(/simulated fork misconfiguration/);
    expect((context as { hint?: string }).hint).toMatch(/lib\/app\/rate-limit\.ts/);
  });
});

describe('capability auto-wire (lib/app/capabilities.ts → server realm)', () => {
  it('registerBuiltInCapabilities runs initAppCapabilities; the capability reaches the dispatcher', async () => {
    // Arrange — the app hook registers a real BaseCapability subclass
    vi.resetModules();
    vi.doMock('@/lib/app/capabilities', async () => {
      const reg = await vi.importActual<typeof import('@/lib/orchestration/capabilities/registry')>(
        '@/lib/orchestration/capabilities/registry'
      );
      const { BaseCapability } = await vi.importActual<
        typeof import('@/lib/orchestration/capabilities/base-capability')
      >('@/lib/orchestration/capabilities/base-capability');
      const { z } = await vi.importActual<typeof import('zod')>('zod');
      class WireCap extends BaseCapability {
        override readonly slug = 'wire_test_cap';
        override readonly functionDefinition = {
          name: 'wire_test_cap',
          description: 'test',
          parameters: { type: 'object', properties: {} } as Record<string, unknown>,
        };
        protected override readonly schema = z.object({});
        override async execute(): Promise<{ success: true; data: Record<string, never> }> {
          return { success: true, data: {} };
        }
      }
      return { initAppCapabilities: (): void => reg.registerAppCapability(new WireCap()) };
    });

    const { registerBuiltInCapabilities, __resetRegistrationForTests } =
      await import('@/lib/orchestration/capabilities/registry');
    const { capabilityDispatcher } = await import('@/lib/orchestration/capabilities/dispatcher');
    __resetRegistrationForTests();

    // Act — the lazy registration path the chat handler / agent-call executor hit
    registerBuiltInCapabilities();

    // Assert — the app capability is live in the dispatcher (proves the auto-call ran)
    expect(capabilityDispatcher.has('wire_test_cap')).toBe(true);
  });

  it('initAppCapabilities runs once across repeated registerBuiltInCapabilities calls', async () => {
    // Arrange — spy hook; the guard must not re-run it on every dispatch
    vi.resetModules();
    const initSpy = vi.fn();
    vi.doMock('@/lib/app/capabilities', () => ({ initAppCapabilities: initSpy }));
    const { registerBuiltInCapabilities, __resetRegistrationForTests } =
      await import('@/lib/orchestration/capabilities/registry');
    __resetRegistrationForTests();

    // Act — two passes (e.g. two chat dispatches)
    registerBuiltInCapabilities();
    registerBuiltInCapabilities();

    // Assert — auto-init is guarded to one run
    expect(initSpy).toHaveBeenCalledTimes(1);
  });
});
