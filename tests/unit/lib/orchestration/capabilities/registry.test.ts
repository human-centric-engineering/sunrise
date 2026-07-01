/**
 * Tests for the capability registry: idempotent built-in registration,
 * `getCapabilityDefinitions` filtering, and the app capability registration
 * seam (fork-readiness: `registerAppCapability` / `registerAppCapabilities`).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import type { BaseCapability as BaseCapabilityType } from '@/lib/orchestration/capabilities/base-capability';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiCapability: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    aiAgentCapability: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { prisma } = await import('@/lib/db/client');
const { capabilityDispatcher } = await import('@/lib/orchestration/capabilities/dispatcher');
const {
  registerBuiltInCapabilities,
  getCapabilityDefinitions,
  registerAppCapability,
  registerAppCapabilities,
  __resetRegistrationForTests,
} = await import('@/lib/orchestration/capabilities/registry');
const { BaseCapability } = await import('@/lib/orchestration/capabilities/base-capability');

// ─── Test doubles: minimal real BaseCapability subclasses ────────────────────
//
// Used across the app-capability seam tests below. We extend the real
// BaseCapability (not a mock) so `register()` runs its real PII guard and the
// dispatcher's handler map wires up exactly as it would in production.
//
// Each test that needs its own slug derives one from `makeAppCap(slugSuffix)`
// so registrations from different tests don't cross-pollute the module-level
// dispatcher.handlers map (clearCache() does NOT clear handlers).

/** Narrow interface for asserting last-wins replacement by `tag`. */
interface TaggedCapability {
  slug: string;
  tag: string;
}

/**
 * Build a minimal non-PII app capability test double.
 * `tag` is a distinguishing field — two instances with the same slug but
 * different tags let us assert last-wins replacement via `getHandler(slug)`.
 */
function makeAppCap(slugSuffix: string, tag = 'default'): BaseCapabilityType {
  const slug = `test_app_cap_${slugSuffix}`;
  class TestAppCapability extends BaseCapability {
    override readonly slug = slug;
    readonly tag = tag;
    override readonly functionDefinition = {
      name: slug,
      description: 'test capability',
      parameters: { type: 'object', properties: {} } as Record<string, unknown>,
    };
    protected override readonly schema = z.object({});

    override async execute(): Promise<{ success: true; data: Record<string, never> }> {
      return { success: true, data: {} };
    }
  }
  return new TestAppCapability();
}

/**
 * Build a PII-declaring app capability that also overrides `redactProvenance`.
 * Used by the test that proves the real PII guard runs through the flush.
 */
function makeAppCapWithPii(slugSuffix: string): BaseCapabilityType {
  const slug = `test_app_cap_pii_${slugSuffix}`;
  class PiiAppCapability extends BaseCapability {
    override readonly slug = slug;
    override readonly functionDefinition = {
      name: slug,
      description: 'pii capability',
      parameters: { type: 'object', properties: {} } as Record<string, unknown>,
    };
    protected override readonly schema = z.object({});
    override readonly processesPii = true;

    // Satisfies the register() guard — must override or registration throws.
    override redactProvenance(): { args: string; resultPreview: string } {
      return { args: '[REDACTED]', resultPreview: '[REDACTED]' };
    }

    override async execute(): Promise<{ success: true; data: Record<string, never> }> {
      return { success: true, data: {} };
    }
  }
  return new PiiAppCapability();
}

/**
 * Build a PII-declaring capability that does NOT override `redactProvenance`.
 * Registering this must throw — proving the real dispatcher guard fires.
 */
function makeAppCapPiiNoRedact(slugSuffix: string): BaseCapabilityType {
  const slug = `test_app_cap_pii_noredact_${slugSuffix}`;
  class PiiNoRedactCapability extends BaseCapability {
    override readonly slug = slug;
    override readonly functionDefinition = {
      name: slug,
      description: 'bad pii capability',
      parameters: { type: 'object', properties: {} } as Record<string, unknown>,
    };
    protected override readonly schema = z.object({});
    override readonly processesPii = true;

    override async execute(): Promise<{ success: true; data: Record<string, never> }> {
      return { success: true, data: {} };
    }
  }
  return new PiiNoRedactCapability();
}

beforeEach(() => {
  vi.clearAllMocks();
  capabilityDispatcher.clearCache();
  __resetRegistrationForTests();
  // Reinstall the default empty resolution (cleared by clearAllMocks).
  (prisma.aiCapability.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
});

describe('registerBuiltInCapabilities', () => {
  it('registers every built-in on first call', () => {
    registerBuiltInCapabilities();
    expect(capabilityDispatcher.has('search_knowledge_base')).toBe(true);
    expect(capabilityDispatcher.has('get_pattern_detail')).toBe(true);
    expect(capabilityDispatcher.has('estimate_workflow_cost')).toBe(true);
    expect(capabilityDispatcher.has('read_user_memory')).toBe(true);
    expect(capabilityDispatcher.has('write_user_memory')).toBe(true);
    expect(capabilityDispatcher.has('escalate_to_human')).toBe(true);
    expect(capabilityDispatcher.has('apply_audit_changes')).toBe(true);
    expect(capabilityDispatcher.has('add_provider_models')).toBe(true);
    expect(capabilityDispatcher.has('deactivate_provider_models')).toBe(true);
    expect(capabilityDispatcher.has('call_external_api')).toBe(true);
    expect(capabilityDispatcher.has('run_workflow')).toBe(true);
    expect(capabilityDispatcher.has('upload_to_storage')).toBe(true);
    expect(capabilityDispatcher.has('send_message_to_channel')).toBe(true);
  });

  it('is idempotent (second call is a no-op)', () => {
    const spy = vi.spyOn(capabilityDispatcher, 'register');
    registerBuiltInCapabilities();
    registerBuiltInCapabilities();
    expect(spy).toHaveBeenCalledTimes(13); // only from the first call (was 12 before #24)
    spy.mockRestore();
  });
});

describe('getCapabilityDefinitions', () => {
  it('returns only definitions enabled for the agent and registered in memory', async () => {
    (prisma.aiAgentCapability.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'aac-1',
        agentId: 'agent-1',
        capabilityId: 'cap-1',
        isEnabled: true,
        customRateLimit: null,
        capability: {
          id: 'cap-1',
          slug: 'search_knowledge_base',
          name: 'Search Knowledge',
          category: 'knowledge',
          isActive: true,
          requiresApproval: false,
          rateLimit: null,
          functionDefinition: {
            name: 'search_knowledge_base',
            description: 'Search',
            parameters: { type: 'object', properties: {} },
          },
        },
      },
      {
        id: 'aac-2',
        agentId: 'agent-1',
        capabilityId: 'cap-2',
        isEnabled: true,
        customRateLimit: null,
        capability: {
          id: 'cap-2',
          slug: 'not_implemented',
          name: 'Unimplemented',
          category: 'other',
          isActive: true,
          requiresApproval: false,
          rateLimit: null,
          functionDefinition: {
            name: 'not_implemented',
            description: 'Nope',
            parameters: {},
          },
        },
      },
    ]);

    const defs = await getCapabilityDefinitions('agent-1');
    expect(defs).toHaveLength(1);
    expect(defs[0]?.name).toBe('search_knowledge_base');
  });

  it('returns an empty list when the agent has no pivot rows', async () => {
    (prisma.aiAgentCapability.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const defs = await getCapabilityDefinitions('agent-empty');
    expect(defs).toEqual([]);
  });

  it('skips rows where the capability relation is null', async () => {
    (prisma.aiAgentCapability.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'aac-null',
        agentId: 'agent-1',
        capabilityId: 'cap-gone',
        isEnabled: true,
        customRateLimit: null,
        capability: null, // edge case — deleted between query plan and execution
      },
    ]);

    const defs = await getCapabilityDefinitions('agent-1');
    expect(defs).toEqual([]);
  });

  it('warns and skips capabilities with malformed functionDefinition JSON', async () => {
    const { logger } = await import('@/lib/logging');

    (prisma.aiAgentCapability.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'aac-bad',
        agentId: 'agent-1',
        capabilityId: 'cap-bad',
        isEnabled: true,
        customRateLimit: null,
        capability: {
          id: 'cap-bad',
          slug: 'search_knowledge_base',
          name: 'Bad Def',
          category: 'knowledge',
          isActive: true,
          requiresApproval: false,
          rateLimit: null,
          functionDefinition: { description: 'Missing name field' }, // invalid — `name` is required
        },
      },
    ]);

    const defs = await getCapabilityDefinitions('agent-1');
    expect(defs).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('malformed functionDefinition'),
      expect.objectContaining({ slug: 'search_knowledge_base' })
    );
  });

  it('matches on capability slug, not function definition name', async () => {
    // Capability slug matches a registered handler, but the function definition
    // name is different — should still be included because we check slug.
    (prisma.aiAgentCapability.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'aac-3',
        agentId: 'agent-1',
        capabilityId: 'cap-3',
        isEnabled: true,
        customRateLimit: null,
        capability: {
          id: 'cap-3',
          slug: 'search_knowledge_base', // matches registered handler
          name: 'Custom KB Search',
          category: 'knowledge',
          isActive: true,
          requiresApproval: false,
          rateLimit: null,
          functionDefinition: {
            name: 'custom_kb_search', // different from slug
            description: 'Search with custom name',
            parameters: { type: 'object', properties: {} },
          },
        },
      },
    ]);

    const defs = await getCapabilityDefinitions('agent-1');
    expect(defs).toHaveLength(1);
    expect(defs[0]?.name).toBe('custom_kb_search');
  });
});

// ─── App capability registration seam (Seam 3 — fork-readiness) ──────────────
//
// Each test uses a unique slug suffix to avoid polluting the module-level
// dispatcher.handlers map, which clearCache() does NOT reset.

describe('registerAppCapability + registerAppCapabilities', () => {
  it('app cap registered before registerBuiltInCapabilities() is present after the call, and built-ins are still present (additive)', () => {
    // Arrange: register an app capability before wiring the built-ins.
    const cap = makeAppCap('additive');
    registerAppCapability(cap);

    // Act: wire built-ins — this should also flush app caps.
    registerBuiltInCapabilities();

    // Assert — app cap landed in the dispatcher …
    expect(capabilityDispatcher.has(cap.slug)).toBe(true);
    // … and the built-ins are still there (we didn't replace, we added).
    expect(capabilityDispatcher.has('search_knowledge_base')).toBe(true);
    expect(capabilityDispatcher.has('run_workflow')).toBe(true);
  });

  it('registerAppCapabilities() called directly registers app caps in the dispatcher', () => {
    // Arrange: register a cap; do NOT call registerBuiltInCapabilities().
    const cap = makeAppCap('direct');
    registerAppCapability(cap);

    // Cap must NOT be in the dispatcher yet (flush hasn't run).
    expect(capabilityDispatcher.has(cap.slug)).toBe(false);

    // Act: flush only app caps — without touching built-in registration.
    registerAppCapabilities();

    // Assert — app cap landed in the dispatcher via the direct flush path.
    // (Note: the handlers map is never cleared between tests, so we can only
    // verify our specific app cap appeared — not make broad negative claims
    // about built-ins which may have been registered by prior tests in this file.)
    expect(capabilityDispatcher.has(cap.slug)).toBe(true);
  });

  it('re-registering the same slug replaces the prior instance (last-wins)', () => {
    // Arrange: same slug, two different instances distinguishable by `tag`.
    const slug = 'lastwin';
    const first = makeAppCap(slug, 'first');
    const second = makeAppCap(slug, 'second');

    registerAppCapability(first);
    registerAppCapabilities();

    // After first flush the handler is `first`.
    const handlerAfterFirst = capabilityDispatcher.getHandler(first.slug) as
      TaggedCapability | undefined;
    expect(handlerAfterFirst?.tag).toBe('first');

    // Act: re-register with a newer instance — must reset the appRegistered flag.
    registerAppCapability(second);
    registerAppCapabilities(); // second flush

    // Assert — the handler is now `second`, not `first`.
    const handlerAfterSecond = capabilityDispatcher.getHandler(second.slug) as
      TaggedCapability | undefined;
    expect(handlerAfterSecond?.tag).toBe('second');
  });

  it('a cap registered AFTER the first flush is picked up on the next registerBuiltInCapabilities() call', () => {
    // Prove the appRegistered flag reset matters.

    // First registration + flush.
    const capFirst = makeAppCap('late_a');
    registerAppCapability(capFirst);
    registerBuiltInCapabilities();
    expect(capabilityDispatcher.has(capFirst.slug)).toBe(true);

    // Late registration — happens AFTER the first flush.
    const capLate = makeAppCap('late_b');
    // At this point capLate is NOT yet in the dispatcher.
    expect(capabilityDispatcher.has(capLate.slug)).toBe(false);

    registerAppCapability(capLate);
    // Still not there until we flush again.
    expect(capabilityDispatcher.has(capLate.slug)).toBe(false);

    // Act: second registerBuiltInCapabilities() — built-ins are idempotent (no-op),
    // but appRegistered was reset so app caps DO re-flush.
    registerBuiltInCapabilities();

    // Assert — the late-registered cap is now present.
    expect(capabilityDispatcher.has(capLate.slug)).toBe(true);
  });

  it('registerAppCapabilities() is idempotent — two calls after one registration make exactly one register() call on the dispatcher', () => {
    // Arrange
    const cap = makeAppCap('idempotent');
    registerAppCapability(cap);

    const spy = vi.spyOn(capabilityDispatcher, 'register');

    // Act: flush twice.
    registerAppCapabilities();
    registerAppCapabilities();

    // Assert — the dispatcher.register was called exactly once for our cap
    // (the second flush short-circuits because appRegistered is still true).
    const callsForOurCap = spy.mock.calls.filter(([c]) => c.slug === cap.slug);
    expect(callsForOurCap).toHaveLength(1);

    spy.mockRestore();
  });

  it('no app caps registered → registerAppCapabilities() makes zero register() calls', () => {
    // Arrange — no registerAppCapability() calls; registry is empty.
    const spy = vi.spyOn(capabilityDispatcher, 'register');

    // Act
    registerAppCapabilities();

    // Assert — nothing was registered.
    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
  });

  it('PII guard fires through the flush — a processesPii=true cap with no redactProvenance override causes registerAppCapabilities() to throw', () => {
    // This proves the flush calls the REAL dispatcher.register(), not a stub.
    // The guard in dispatcher.register() throws when processesPii=true but
    // the subclass does not override redactProvenance().
    const badCap = makeAppCapPiiNoRedact('guard');
    registerAppCapability(badCap);

    // Act + Assert — flushing must propagate the register() guard throw.
    expect(() => registerAppCapabilities()).toThrow(/processesPii=true.*redactProvenance/);

    // A well-behaved PII cap (with redactProvenance overridden) should NOT throw.
    __resetRegistrationForTests(); // reset so we start clean
    const goodPiiCap = makeAppCapWithPii('guard_ok');
    registerAppCapability(goodPiiCap);
    expect(() => registerAppCapabilities()).not.toThrow();
    expect(capabilityDispatcher.has(goodPiiCap.slug)).toBe(true);
  });

  // Note: the "is idempotent (13 calls)" built-in test above already proves the
  // app-cap flush adds zero register() calls when no app caps are registered —
  // registerAppCapabilities() runs inside registerBuiltInCapabilities(), so that
  // existing assertion would fail if the flush erroneously called register().
  // No separate regression test is added here to avoid a duplicate hardcoded count.
});

// ─── Barrel re-export surface ─────────────────────────────────────────────────

describe('@/lib/orchestration/capabilities barrel', () => {
  it('re-exports registerAppCapability and registerAppCapabilities as functions', async () => {
    // Verify the public barrel surface — callers should be able to import
    // these without touching the internal registry module directly.
    const barrel = await import('@/lib/orchestration/capabilities');
    expect(typeof barrel.registerAppCapability).toBe('function');
    expect(typeof barrel.registerAppCapabilities).toBe('function');
  });
});
