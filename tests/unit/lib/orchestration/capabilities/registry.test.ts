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

/**
 * FORK NOTE — this stub is what keeps the count below yours to ignore.
 *
 * `registerBuiltInCapabilities()` calls `initAppCapabilities()` (registry.ts),
 * the fork-owned `lib/app/capabilities.ts` scaffold CUSTOMIZATION.md §4 tells
 * every fork to fill. Without this stub the spy counts core's registrations
 * PLUS the fork's, and the failure reads "expected register to be called 13
 * times, but got 27" under a test named *is idempotent* — asserting the
 * opposite of what happened, and sending the reader after a double-registration
 * bug in wiring that is behaving perfectly (#525).
 *
 * Stubbing it does not lose coverage: that the registry calls the seam at all
 * is asserted below, and its behavioural reach into the dispatcher is covered
 * by tests/unit/lib/app/bootstrap-wiring.test.ts against the real module.
 */
vi.mock('@/lib/app/capabilities', () => ({ initAppCapabilities: vi.fn() }));

const { prisma } = await import('@/lib/db/client');
const { logger } = await import('@/lib/logging');
const { capabilityDispatcher } = await import('@/lib/orchestration/capabilities/dispatcher');
const {
  registerBuiltInCapabilities,
  getCapabilityDefinitions,
  registerAppCapability,
  registerAppCapabilities,
  __resetRegistrationForTests,
  __resetDivergenceWarningsForTests,
} = await import('@/lib/orchestration/capabilities/registry');
const { BaseCapability } = await import('@/lib/orchestration/capabilities/base-capability');
const { initAppCapabilities } = await import('@/lib/app/capabilities');

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
  // The divergence warning is memoised for the life of the process, so without
  // this a case that warns would silence the next one and the order of these
  // tests would start to matter.
  __resetDivergenceWarningsForTests();
  // Reinstall the default empty resolution (cleared by clearAllMocks).
  (prisma.aiCapability.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  // `clearAllMocks` clears CALLS but not implementations, so a case that makes
  // the fork seam throw would otherwise throw in every case after it.
  vi.mocked(initAppCapabilities).mockReset();
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
    // 13 built-ins, from the first call only. The app seam is stubbed at the
    // top of this file, so this counts core and nothing else.
    expect(spy).toHaveBeenCalledTimes(13);
    spy.mockRestore();
  });

  it('runs a THROWING app capability seam exactly once, not on every dispatch', () => {
    // The latch used to be set AFTER the call, so this file's own comment
    // ("guarded so it isn't re-run on every dispatch") was false on exactly the
    // path that mattered — measured at 2 calls for 2 dispatches, i.e. forever.
    vi.mocked(initAppCapabilities).mockImplementation(() => {
      throw new Error('fork boom');
    });

    expect(() => registerBuiltInCapabilities()).toThrow();
    expect(() => registerBuiltInCapabilities()).toThrow();
    expect(() => registerBuiltInCapabilities()).toThrow();

    expect(initAppCapabilities).toHaveBeenCalledTimes(1);
  });

  it('keeps failing loudly after a throwing init, rather than degrading silently', () => {
    // Deliberately NOT changed to match the other ten seams, and deliberately
    // not left to fail only once. An init throw means the fork's ENTIRE
    // capability set is rolled back — 28 tools for hce-hub, not one — so an
    // agent would answer from its own weights with nothing marking the gap.
    // Whether that should stay loud is a product decision the follow-up issue
    // makes with per-item attribution in hand; until then this is the behaviour
    // that already shipped.
    vi.mocked(initAppCapabilities).mockImplementation(() => {
      throw new Error('fork boom');
    });

    expect(() => registerBuiltInCapabilities()).toThrow(/initAppCapabilities/);
    expect(() => registerBuiltInCapabilities()).toThrow(/fork boom/);
  });

  it('rolls back a PARTIAL init so nothing half-registered can reach the dispatcher', () => {
    const orphan = makeAppCap('partial_init_orphan');
    vi.mocked(initAppCapabilities).mockImplementation(() => {
      registerAppCapability(orphan);
      throw new Error('fork boom on the second');
    });

    expect(() => registerBuiltInCapabilities()).toThrow();
    expect(capabilityDispatcher.has(orphan.slug)).toBe(false);

    // `registerAppCapabilities()` is exported, so the pending map is reachable
    // independently of the throwing path. Rollback is what makes that safe —
    // without it this flushes a capability the log says is disabled.
    registerAppCapabilities();
    expect(capabilityDispatcher.has(orphan.slug)).toBe(false);
  });

  it('still runs the app capability seam, exactly once', () => {
    // The count above is only meaningful while the seam is stubbed, and a stub
    // that outlived its wiring would hide the seam being dropped from
    // registry.ts entirely. So assert the call rather than only its absence
    // from the tally.
    registerBuiltInCapabilities();
    registerBuiltInCapabilities();
    expect(initAppCapabilities).toHaveBeenCalledTimes(1);
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

  it('matches on capability slug, and advertises the slug rather than a divergent name', async () => {
    // Inclusion is decided by slug — that part was always right, and is what
    // this test was originally written for. What it also used to pin was the
    // divergent `functionDefinition.name` being passed through to the model,
    // which is the #509 hole: dispatch resolves the emitted name AS a slug, so
    // a row advertising `custom_kb_search` while carrying
    // `slug: 'search_knowledge_base'` was checked by the #476 guard under one
    // identity and executed under another. The advertised name is now the slug.
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
    expect(defs[0]?.name).toBe('search_knowledge_base');
    // The rest of the stored definition is untouched — only the name is
    // overridden, so a divergent row keeps working rather than being dropped.
    expect(defs[0]?.description).toBe('Search with custom name');
    expect(logger.warn).toHaveBeenCalledWith(
      'Capability functionDefinition.name differs from slug; advertising the slug',
      expect.objectContaining({
        slug: 'search_knowledge_base',
        functionDefinitionName: 'custom_kb_search',
        firstObservedOnAgentId: 'agent-1',
      })
    );
  });

  it('warns about a divergent row once, not on every turn', async () => {
    // A divergent row keeps working indefinitely by design, and this function
    // runs once per chat turn and once per agent_call step — so an
    // un-memoised warning is one log line per request, forever.
    (prisma.aiAgentCapability.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'aac-dup',
        agentId: 'agent-1',
        capabilityId: 'cap-dup',
        isEnabled: true,
        customRateLimit: null,
        capability: {
          id: 'cap-dup',
          slug: 'search_knowledge_base',
          name: 'Custom KB Search',
          category: 'knowledge',
          isActive: true,
          requiresApproval: false,
          rateLimit: null,
          functionDefinition: {
            name: 'custom_kb_search',
            description: 'Search with custom name',
            parameters: { type: 'object', properties: {} },
          },
        },
      },
    ]);

    const { logger } = await import('@/lib/logging');

    await getCapabilityDefinitions('agent-1');
    await getCapabilityDefinitions('agent-1');
    await getCapabilityDefinitions('agent-2');

    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
  });

  it('drops a capability whose slug cannot be an LLM tool name', async () => {
    // A namespaced fork slug from the documented `register(cap, { slug })`
    // seam. Because the slug is now the advertised name, passing it through
    // would have the provider reject the ENTIRE request over a bad tool-name
    // charset — killing the conversation, not just the call. It was never
    // reachable from chat anyway (dispatch resolves the emitted name as a
    // slug, and no valid name can match this row); MCP is its surface.
    const appCap = makeAppCap('namespaced');
    registerAppCapability(appCap, { slug: 'billing:lookup_order' });
    registerBuiltInCapabilities();

    (prisma.aiAgentCapability.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'aac-ns',
        agentId: 'agent-1',
        capabilityId: 'cap-ns',
        isEnabled: true,
        customRateLimit: null,
        capability: {
          id: 'cap-ns',
          slug: 'billing:lookup_order',
          name: 'Lookup Order',
          category: 'billing',
          isActive: true,
          requiresApproval: false,
          rateLimit: null,
          functionDefinition: {
            name: 'lookup_order',
            description: 'Look up an order',
            parameters: { type: 'object', properties: {} },
          },
        },
      },
    ]);

    const { logger } = await import('@/lib/logging');
    const defs = await getCapabilityDefinitions('agent-1');

    expect(defs).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      'Capability slug is not a valid LLM tool name; not advertising it',
      expect.objectContaining({ slug: 'billing:lookup_order' })
    );
  });

  it('leaves a non-divergent definition alone, and says nothing about it', async () => {
    // The overwhelmingly common case: name and slug already agree. No warning,
    // and the definition reaches the model unchanged.
    (prisma.aiAgentCapability.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'aac-4',
        agentId: 'agent-1',
        capabilityId: 'cap-4',
        isEnabled: true,
        customRateLimit: null,
        capability: {
          id: 'cap-4',
          slug: 'search_knowledge_base',
          name: 'Search Knowledge Base',
          category: 'knowledge',
          isActive: true,
          requiresApproval: false,
          rateLimit: null,
          functionDefinition: {
            name: 'search_knowledge_base',
            description: 'Search the knowledge base',
            parameters: { type: 'object', properties: {} },
          },
        },
      },
    ]);

    const { logger } = await import('@/lib/logging');
    const defs = await getCapabilityDefinitions('agent-1');

    expect(defs[0]?.name).toBe('search_knowledge_base');
    expect(logger.warn).not.toHaveBeenCalled(); // test-review:accept no_arg_called — a warning here would fire on every turn of every healthy agent
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

  it('PII guard fires through the flush — but is ISOLATED to the capability that failed it', () => {
    // This proves the flush calls the REAL dispatcher.register(), not a stub:
    // the guard in dispatcher.register() throws when processesPii=true but the
    // subclass does not override redactProvenance().
    //
    // It used to propagate, and that is the defect (#633). This guard exists to
    // catch a FORK AUTHORING mistake, and it fires mid-loop — so one bad
    // capability at position 12 of hce-hub's 28 left 11 in the dispatcher, 16
    // never registered, and every dispatch path throwing. The fork's other 27
    // tools are not implicated by one of them being misdeclared.
    const before = makeAppCap('flush_isolation_before');
    const bad = makeAppCapPiiNoRedact('flush_isolation');
    const after = makeAppCap('flush_isolation_after');
    registerAppCapability(before);
    registerAppCapability(bad);
    registerAppCapability(after);

    expect(() => registerAppCapabilities()).not.toThrow();

    // The one that failed its guard is absent; the ones on either side of it
    // are live. Registration order matters here — `after` is the one a
    // propagating throw skipped entirely.
    expect(capabilityDispatcher.has(before.slug)).toBe(true);
    expect(capabilityDispatcher.has(bad.slug)).toBe(false);
    expect(capabilityDispatcher.has(after.slug)).toBe(true);

    // Named, so a fork author can fix it without bisecting their init.
    expect(logger.error).toHaveBeenCalledWith(
      'capabilities: an app capability failed to register — skipping it',
      expect.objectContaining({
        slug: bad.slug,
        error: expect.stringMatching(/processesPii=true.*redactProvenance/s),
      })
    );

    // A well-behaved PII cap (with redactProvenance overridden) still registers.
    __resetRegistrationForTests();
    const goodPiiCap = makeAppCapWithPii('guard_ok');
    registerAppCapability(goodPiiCap);
    expect(() => registerAppCapabilities()).not.toThrow();
    expect(capabilityDispatcher.has(goodPiiCap.slug)).toBe(true);
  });

  it('does not re-run the flush loop on every dispatch after skipping a failure', () => {
    // The skip must still complete the flush, or `appRegistered` stays false and
    // the whole loop — including the failing register() and its log line — runs
    // again on every single dispatch.
    registerAppCapability(makeAppCapPiiNoRedact('flush_latch'));

    registerAppCapabilities();
    registerAppCapabilities();
    registerAppCapabilities();

    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  // Note: the "is idempotent (13 calls)" built-in test above already proves the
  // app-cap flush adds zero register() calls when no app caps are registered —
  // registerAppCapabilities() runs inside registerBuiltInCapabilities(), so that
  // existing assertion would fail if the flush erroneously called register().
  // No separate regression test is added here to avoid a duplicate hardcoded count.

  it('forwards register options (slug override) to the dispatcher (#398)', () => {
    // A fork can mount one class under a namespaced slug; the flush must pass
    // `options` through so the handler lands under the override key, not the
    // capability's own slug.
    const cap = makeAppCap('opt_base');
    registerAppCapability(cap, { slug: 'ns:opt' });
    registerAppCapabilities();

    expect(capabilityDispatcher.has('ns:opt')).toBe(true);
    // The capability's own slug was NOT used as the key.
    expect(capabilityDispatcher.has(cap.slug)).toBe(false);
  });

  it('forwards a register guard to the dispatcher (#398)', () => {
    // Spy on the real dispatcher.register to assert the guard option is passed
    // through verbatim (the guard behaviour itself is covered in dispatcher.test).
    const cap = makeAppCap('opt_guard');
    const guard = vi.fn().mockResolvedValue({ allow: true });
    const spy = vi.spyOn(capabilityDispatcher, 'register');

    registerAppCapability(cap, { guard });
    registerAppCapabilities();

    const call = spy.mock.calls.find(([c]) => c.slug === cap.slug);
    expect(call?.[1]).toEqual({ guard });
    spy.mockRestore();
  });

  it('keys the app map on the override slug — two mounts of one class both survive (#398)', () => {
    // Same class, two override slugs → both must flush (keying on the override
    // slug, not the shared capability.slug, or one would clobber the other).
    const cap = makeAppCap('opt_shared');
    registerAppCapability(cap, { slug: 'ns:a' });
    registerAppCapability(cap, { slug: 'ns:b' });
    registerAppCapabilities();

    expect(capabilityDispatcher.has('ns:a')).toBe(true);
    expect(capabilityDispatcher.has('ns:b')).toBe(true);
  });
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
