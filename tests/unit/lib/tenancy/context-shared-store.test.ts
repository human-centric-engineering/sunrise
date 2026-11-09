/**
 * Tests: the request-scoped stores another module graph reads are one store per process (#1138)
 *
 * Next evaluates a module once per module graph: the route handlers in one, `instrumentation.ts`
 * in another. A `globalThis` singleton is built in whichever graph reaches it first, so the
 * capability dispatcher, built at boot, runs the instrumentation graph's code. With a module-level
 * `AsyncLocalStorage`, the org a route entered was in the route graph's store while the
 * dispatcher's queries read the instrumentation graph's, which was empty, and at `multi` they threw
 * "No tenant context".
 *
 * Here two evaluations of a module, with `vi.resetModules()` between them, stand in for two
 * graphs. A scope entered through one must be what the other reads, for each store such a
 * singleton reaches:
 *
 *   - the tenant context (`lib/tenancy/context.ts`), which scopes every query;
 *   - the subject context (`lib/auth/subject-context.ts`), which narrows owner-scoped reads. Split,
 *     the other graph answers `none`, and `none` is not narrowed;
 *   - the paid-call hold (`lib/orchestration/llm/spend-caps.ts`). Split, a capability's paid call
 *     misses the hold its turn set.
 *
 * Each case fails against a module-level store. The `globalThis` slots are put back after every
 * case, so each one creates its stores afresh.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/env', () => ({ env: { TENANCY_MODE: 'multi' } }));
vi.mock('@/lib/db/client', () => ({ prisma: {} }));
// No global cap is set, and at multi a call outside any org has no org cap, so only the hold can
// refuse a paid call here.
vi.mock('@/lib/orchestration/settings', () => ({
  getOrchestrationSettings: vi.fn(() => Promise.resolve({ globalMonthlyBudgetUsd: null })),
  invalidateOrchestrationSettingsCache: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ORG = 'cmorg00000000000000000orga';
const SLOTS = ['sunriseTenantContext', 'sunriseSubjectContext', 'sunrisePaidCallHold'] as const;

const NO_UNATTRIBUTED_READS = {
  conversation: false,
  dataset: false,
  execution: false,
  experiment: false,
  webhookDelivery: false,
  webhookSubscription: false,
} as const;

// Whatever a setup file or an earlier import put in a slot goes back after each case, so a module
// still holding that store is not left reading a different one from everything after it.
const bag = globalThis as Record<string, unknown>;
const before = new Map(SLOTS.map((slot) => [slot, bag[slot]]));
afterEach(() => {
  for (const slot of SLOTS) {
    if (before.get(slot) === undefined) delete bag[slot];
    else bag[slot] = before.get(slot);
  }
});

/** A fresh evaluation of a module, as another module graph would load it. */
async function fresh<T>(load: () => Promise<T>): Promise<T> {
  vi.resetModules();
  return load();
}

describe('the tenant context across two evaluations of its module', () => {
  const load = () => import('@/lib/tenancy/context');

  it('an org entered through one is the org the other reads', async () => {
    const route = await fresh(load);
    const instrumentation = await fresh(load);
    // The precondition the case rests on: two evaluations, not one cached module.
    expect(route.runAsOrg).not.toBe(instrumentation.runAsOrg);

    const seen = await route.runAsOrg(ORG, async () => instrumentation.getTenantContext());

    expect(seen).toMatchObject({ orgId: ORG });
  });

  it('the other does not throw "No tenant context" at multi inside that org (#1138)', async () => {
    const route = await fresh(load);
    const instrumentation = await fresh(load);

    const seen = await route.runAsOrg(ORG, async () => instrumentation.requireTenantContext());

    expect(seen.orgId).toBe(ORG);
  });

  it('a system scope entered through one is read by the other', async () => {
    const route = await fresh(load);
    const instrumentation = await fresh(load);

    const seen = await route.runAsSystem('shared-store test', async () =>
      instrumentation.getTenantContext()
    );

    expect(seen).toEqual({ orgId: null, source: 'system' });
  });

  it('a scope still ends with its callback, in both', async () => {
    const route = await fresh(load);
    const instrumentation = await fresh(load);

    const inside = await route.runAsOrg(ORG, async () => instrumentation.getTenantContext());

    // Non-null inside first, so the nulls below are not an empty store passing for free.
    expect(inside).toMatchObject({ orgId: ORG });
    expect(route.getTenantContext()).toBeNull();
    expect(instrumentation.getTenantContext()).toBeNull();
  });
});

describe('the subject context across two evaluations of its module', () => {
  const load = () => import('@/lib/auth/subject-context');

  it('a subject entered through one narrows reads in the other', async () => {
    const route = await fresh(load);
    const instrumentation = await fresh(load);
    expect(route.runAsSubject).not.toBe(instrumentation.runAsSubject);

    const scope = await route.runAsSubject(
      {
        principal: { userId: 'user-a', role: 'USER', credential: 'session' },
        resolveFilter: () => Promise.resolve({ userId: 'user-a' }),
        unattributedReads: NO_UNATTRIBUTED_READS,
      },
      async () => instrumentation.getSubjectReadScope()
    );

    expect(scope).toMatchObject({ kind: 'subject', filter: { userId: 'user-a' } });
  });
});

describe('the paid-call hold across two evaluations of its module', () => {
  const load = () => import('@/lib/orchestration/llm/spend-caps');

  it("a hold a turn set through one refuses a capability's paid call through the other", async () => {
    const turn = await fresh(load);
    const capability = await fresh(load);
    expect(turn.withPaidCallHold).not.toBe(capability.withPaidCallHold);

    async function* aTurnThatDispatches() {
      yield await capability.spendCapRefusal('openai', false);
    }
    const refusals = [];
    for await (const refusal of turn.withPaidCallHold({ cap: 'agent' }, aTurnThatDispatches())) {
      refusals.push(refusal);
    }

    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ cap: 'agent' });
  });

  it('the same paid call goes ahead with no hold set', async () => {
    const capability = await fresh(load);

    // The control for the case above: nothing but the hold refuses in this setup.
    await expect(capability.spendCapRefusal('openai', false)).resolves.toBeNull();
  });
});
