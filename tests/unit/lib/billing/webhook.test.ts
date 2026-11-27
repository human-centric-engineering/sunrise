/**
 * Unit Tests: the billing webhook (§139 t-1094)
 *
 * The real `handleBillingWebhook()` over an in-memory subscription table and
 * event ledger behind a mocked Prisma whose `$transaction` rolls back on a
 * throw, and a fake provider that holds each subscription's current state the
 * way Stripe does: an event names a subscription, and what is applied is
 * whatever the provider holds when it is fetched. `applyPlan()` is replaced by
 * a recorder whose answer is idempotent, since its own writes are t-1093's
 * tests.
 *
 * Pins the spec's rules: nothing is read before the signature verifies; a
 * replay changes nothing; deliveries in any order end on the provider's state;
 * a failure part-way commits nothing, so the retry applies it; the lapsed
 * rule (past due keeps the plan, cancelled or unpaid applies the fallback,
 * none turns the lapsed plan's switches off, incomplete applies nothing); and
 * when a subscription is adopted, replaced, or refused.
 *
 * The same on a real database, RLS on: `npm run smoke:billing-webhook`.
 *
 * @see lib/billing/webhook.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'multi' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({ logger: mockLogger }));

const mockForgetOrgCap = vi.hoisted(() => vi.fn());
vi.mock('@/lib/orchestration/llm/spend-caps', () => ({ forgetOrgCap: mockForgetOrgCap }));

const mockAudit = vi.hoisted(() => vi.fn());
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({ logAdminAction: mockAudit }));

// ─── Plans ──────────────────────────────────────────────────────────────────

interface Plan {
  key: string;
  label: string;
  description: string;
  switches: Record<string, boolean>;
  meterLimits: Record<string, number | null>;
  aiBudgetUsd: number | null | undefined;
  priceLookupKey: string | null;
}

const plans = vi.hoisted(() => ({
  list: [] as Plan[],
  fallback: null as string | null,
}));
vi.mock('@/lib/billing/plans', () => ({
  registeredPlans: () => plans.list,
  planOf: (key: string) => plans.list.find((p) => p.key === key),
  fallbackPlan: () => plans.list.find((p) => p.key === plans.fallback) ?? null,
}));

function plan(key: string, overrides: Partial<Plan> = {}): Plan {
  return {
    key,
    label: key,
    description: '',
    switches: {},
    meterLimits: {},
    aiBudgetUsd: undefined,
    priceLookupKey: null,
    ...overrides,
  };
}

// ─── The org's settings, as applyPlan would leave them ──────────────────────

const settings = vi.hoisted(() => new Map<string, Record<string, unknown>>());
const mockApplyPlan = vi.hoisted(() =>
  vi.fn(async (orgId: string, p: { switches: Record<string, boolean>; aiBudgetUsd?: unknown }) => {
    const before = settings.get(orgId) ?? {};
    const after = {
      ...before,
      switches: { ...((before.switches as object) ?? {}), ...p.switches },
      ...(p.aiBudgetUsd !== undefined ? { aiBudgetUsd: p.aiBudgetUsd } : {}),
    };
    const changed = JSON.stringify(before) !== JSON.stringify(after);
    if (changed) settings.set(orgId, after);
    return {
      changed,
      switches: changed ? { from: before.switches ?? null, to: after.switches } : null,
      meterLimits: null,
      aiBudgetUsd:
        changed && before.aiBudgetUsd !== after.aiBudgetUsd
          ? { from: (before.aiBudgetUsd as number) ?? null, to: after.aiBudgetUsd as number }
          : null,
    };
  })
);
vi.mock('@/lib/billing/apply-plan', () => ({ applyPlan: mockApplyPlan }));

// ─── The database ───────────────────────────────────────────────────────────

interface RecordRow {
  orgId: string;
  planKey: string | null;
  provider: string | null;
  customerRef: string | null;
  subscriptionRef: string | null;
  status: 'INCOMPLETE' | 'ACTIVE' | 'PAST_DUE' | 'ENDED';
  providerStatus: string | null;
  cancelAtPeriodEnd: boolean;
  periodStart: Date | null;
  periodEnd: Date | null;
  planAppliedAt: Date | null;
}
interface LedgerRow {
  provider: string;
  eventId: string;
  eventType: string;
  outcome: string;
  orgId: string;
}

const db = vi.hoisted(() => ({
  orgs: new Set<string>(),
  records: new Map<string, RecordRow>(),
  ledger: [] as LedgerRow[],
}));

const mockPrisma = vi.hoisted(() => {
  const pick = (row: Record<string, unknown>, select?: Record<string, boolean>) =>
    select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k] ?? null])) : { ...row };
  const client = {
    org: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        db.orgs.has(where.id) ? { id: where.id } : null
      ),
    },
    orgBillingSubscription: {
      findUnique: vi.fn(
        async ({
          where,
          select,
        }: {
          where: {
            orgId?: string;
            provider_customerRef?: { provider: string; customerRef: string };
          };
          select?: Record<string, boolean>;
        }) => {
          let row: RecordRow | undefined;
          if (where.orgId) row = db.records.get(where.orgId);
          else if (where.provider_customerRef) {
            const { provider, customerRef } = where.provider_customerRef;
            row = [...db.records.values()].find(
              (r) => r.provider === provider && r.customerRef === customerRef
            );
          }
          return row ? pick({ ...row }, select) : null;
        }
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { orgId: string };
          create: Partial<RecordRow>;
          update: Partial<RecordRow>;
        }) => {
          const existing = db.records.get(where.orgId);
          const row: RecordRow = existing
            ? { ...existing, ...update }
            : {
                orgId: where.orgId,
                planKey: null,
                provider: null,
                customerRef: null,
                subscriptionRef: null,
                status: 'ACTIVE',
                providerStatus: null,
                cancelAtPeriodEnd: false,
                periodStart: null,
                periodEnd: null,
                planAppliedAt: null,
                ...create,
              };
          db.records.set(where.orgId, row);
          return row;
        }
      ),
    },
    billingWebhookEvent: {
      createMany: vi.fn(async ({ data }: { data: LedgerRow[] }) => {
        let count = 0;
        for (const row of data) {
          // The unique key on (provider, eventId), ON CONFLICT DO NOTHING.
          if (db.ledger.some((r) => r.provider === row.provider && r.eventId === row.eventId)) {
            continue;
          }
          db.ledger.push({ ...row });
          count += 1;
        }
        return { count };
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { provider_eventId: { provider: string; eventId: string } };
          data: { outcome: string };
        }) => {
          const row = db.ledger.find(
            (r) =>
              r.provider === where.provider_eventId.provider &&
              r.eventId === where.provider_eventId.eventId
          );
          if (!row) throw new Error('no ledger row');
          row.outcome = data.outcome;
          return row;
        }
      ),
    },
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async (_strings: TemplateStringsArray, orgId: string) =>
      db.orgs.has(orgId) ? [{ id: orgId }] : []
    ),
    // All or nothing: a throw restores what was there before.
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const before = {
        records: new Map([...db.records].map(([k, v]) => [k, { ...v }])),
        ledger: db.ledger.map((r) => ({ ...r })),
        settings: new Map([...settings].map(([k, v]) => [k, structuredClone(v)])),
      };
      try {
        return await fn(client);
      } catch (error) {
        db.records = before.records;
        db.ledger = before.ledger;
        settings.clear();
        for (const [k, v] of before.settings) settings.set(k, v);
        throw error;
      }
    }),
  };
  return client;
});
vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));

// ─── The provider ───────────────────────────────────────────────────────────

import type { BillingEvent, BillingProvider, ProviderSubscription } from '@/lib/billing/provider';
import { BillingSignatureError } from '@/lib/billing/provider';

const remote = vi.hoisted(() => ({ subscriptions: new Map<string, unknown>() }));

function sub(ref: string, overrides: Partial<ProviderSubscription> = {}): ProviderSubscription {
  return {
    ref,
    customerRef: 'cus_a',
    status: 'active',
    providerStatus: 'active',
    priceLookupKeys: ['pro_monthly'],
    periodStart: new Date('2026-11-01T00:00:00Z'),
    periodEnd: new Date('2026-12-01T00:00:00Z'),
    cancelAtPeriodEnd: false,
    endedAt: null,
    live: true,
    orgId: 'org_a',
    ...overrides,
  };
}

/** Put the provider's current state for a subscription. */
function holds(subscription: ProviderSubscription): void {
  remote.subscriptions.set(subscription.ref, subscription);
}

const fake = vi.hoisted((): { provider: unknown } => ({ provider: null }));
function makeProvider(): BillingProvider {
  return {
    key: 'stripe',
    createCheckout: vi.fn(),
    openPortal: vi.fn(),
    parseWebhook: vi.fn(async ({ rawBody, headers }: { rawBody: string; headers: Headers }) => {
      if (headers.get('x-signature') !== 'good') throw new BillingSignatureError();
      return JSON.parse(rawBody) as BillingEvent;
    }),
    fetchSubscription: vi.fn(
      async (ref: string) => (remote.subscriptions.get(ref) as ProviderSubscription) ?? null
    ),
    listLiveSubscriptions: vi.fn(async (customerRef: string) =>
      [...remote.subscriptions.values()]
        .map((s) => s as ProviderSubscription)
        .filter((s) => s.customerRef === customerRef && s.live)
    ),
    findCustomerRefs: vi.fn(async () => []),
    reportUsage: vi.fn(),
    cancelSubscription: vi.fn(),
  };
}
vi.mock('@/lib/billing/config', () => ({ billingProvider: async () => fake.provider }));

import { handleBillingWebhook } from '@/lib/billing/webhook';

const ORG = 'org_a';
let provider: BillingProvider;
let eventSeq = 0;

function deliver(
  event: Partial<BillingEvent> & { subscriptionRef: string | null },
  options: { signature?: string; providerKey?: string } = {}
) {
  const full: BillingEvent = {
    id: event.id ?? `evt_${++eventSeq}`,
    kind: event.kind ?? 'subscription_changed',
    providerType: event.providerType ?? 'customer.subscription.updated',
    customerRef: event.customerRef === undefined ? 'cus_a' : event.customerRef,
    subscriptionRef: event.subscriptionRef,
  };
  return handleBillingWebhook({
    providerKey: options.providerKey ?? 'stripe',
    rawBody: JSON.stringify(full),
    headers: new Headers({ 'x-signature': options.signature ?? 'good' }),
  });
}

function stored(): RecordRow | undefined {
  return db.records.get(ORG);
}

/** The org has been through checkout: its customer is stored, no subscription yet. */
function linkCustomer(customerRef = 'cus_a'): void {
  db.records.set(ORG, {
    orgId: ORG,
    planKey: 'free',
    provider: 'stripe',
    customerRef,
    subscriptionRef: null,
    status: 'ACTIVE',
    providerStatus: null,
    cancelAtPeriodEnd: false,
    periodStart: null,
    periodEnd: null,
    planAppliedAt: new Date(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  db.orgs = new Set([ORG]);
  db.records = new Map();
  db.ledger = [];
  settings.clear();
  remote.subscriptions.clear();
  plans.list = [
    plan('free', { switches: { reports: false } }),
    plan('pro', { switches: { reports: true }, aiBudgetUsd: 100, priceLookupKey: 'pro_monthly' }),
    plan('team', { switches: { reports: true, sso: true }, priceLookupKey: 'team_monthly' }),
  ];
  plans.fallback = 'free';
  provider = makeProvider();
  fake.provider = provider;
});

describe('verify first', () => {
  it('refuses a bad signature before anything is read or written', async () => {
    holds(sub('sub_1'));
    linkCustomer();

    const result = await deliver({ subscriptionRef: 'sub_1' }, { signature: 'forged' });

    expect(result).toEqual({ status: 'bad_signature' });
    expect(mockPrisma.orgBillingSubscription.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.org.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(provider.fetchSubscription).not.toHaveBeenCalled();
    expect(db.ledger).toEqual([]);
  });

  it('answers billing off, reading nothing, when no provider is on or the URL names another', async () => {
    fake.provider = null;
    expect(await deliver({ subscriptionRef: 'sub_1' })).toEqual({ status: 'billing_off' });

    fake.provider = provider;
    expect(await deliver({ subscriptionRef: 'sub_1' }, { providerKey: 'paddle' })).toEqual({
      status: 'billing_off',
    });
    expect(provider.parseWebhook).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('answers an event type it does not act on without reading or writing', async () => {
    const result = await deliver({ kind: 'ignored', subscriptionRef: null, customerRef: null });
    expect(result).toMatchObject({ status: 'ignored' });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('finding the org', () => {
  it('finds it by the stored customer, and puts it on the plan it bought', async () => {
    linkCustomer();
    holds(sub('sub_1'));

    const result = await deliver({
      kind: 'checkout_completed',
      providerType: 'checkout.session.completed',
      subscriptionRef: 'sub_1',
    });

    expect(result).toEqual({
      status: 'recorded',
      eventId: expect.any(String),
      orgId: ORG,
      outcome: 'applied',
    });
    expect(stored()).toMatchObject({
      planKey: 'pro',
      subscriptionRef: 'sub_1',
      status: 'ACTIVE',
      providerStatus: 'active',
      periodEnd: new Date('2026-12-01T00:00:00Z'),
    });
    expect(stored()?.planAppliedAt).toBeInstanceOf(Date);
    expect(mockApplyPlan).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ key: 'pro' }),
      expect.anything()
    );
    expect(db.ledger).toEqual([
      expect.objectContaining({
        orgId: ORG,
        eventType: 'checkout.session.completed',
        outcome: 'applied',
      }),
    ]);
  });

  it('falls back to the org id in the subscription metadata, and links the customer', async () => {
    // A checkout whose local write of the customer reference never landed.
    holds(sub('sub_1', { customerRef: 'cus_new' }));

    const result = await deliver({ subscriptionRef: 'sub_1', customerRef: 'cus_new' });

    expect(result).toMatchObject({ status: 'recorded', orgId: ORG, outcome: 'applied' });
    expect(stored()).toMatchObject({
      provider: 'stripe',
      customerRef: 'cus_new',
      subscriptionRef: 'sub_1',
      planKey: 'pro',
    });
  });

  it('drops an event that names no org that exists, writing nothing', async () => {
    holds(sub('sub_1', { orgId: 'org_erased', customerRef: 'cus_gone' }));

    const result = await deliver({ subscriptionRef: 'sub_1', customerRef: 'cus_gone' });

    expect(result).toMatchObject({ status: 'no_org' });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(db.ledger).toEqual([]);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('drops an event whose metadata org id is not an id', async () => {
    holds(sub('sub_1', { orgId: "x' OR 1=1", customerRef: 'cus_x' }));
    const result = await deliver({ subscriptionRef: 'sub_1', customerRef: 'cus_x' });
    expect(result).toMatchObject({ status: 'no_org' });
    expect(mockPrisma.org.findUnique).not.toHaveBeenCalled();
  });
});

describe('replays', () => {
  it('records an event once: a replay changes nothing and writes no second audit row', async () => {
    linkCustomer();
    holds(sub('sub_1'));
    const event = { id: 'evt_same', subscriptionRef: 'sub_1' };

    const first = await deliver(event);
    const recordAfterFirst = structuredClone(stored());
    const second = await deliver(event);

    expect(first).toMatchObject({ status: 'recorded', outcome: 'applied' });
    expect(second).toEqual({ status: 'replay', eventId: 'evt_same', orgId: ORG });
    expect(stored()).toEqual(recordAfterFirst);
    expect(mockApplyPlan).toHaveBeenCalledTimes(1);
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(db.ledger).toHaveLength(1);
  });

  it('a new event about a state already applied is recorded as unchanged, with no audit row', async () => {
    linkCustomer();
    holds(sub('sub_1'));
    await deliver({ subscriptionRef: 'sub_1' });
    mockAudit.mockClear();

    const again = await deliver({ subscriptionRef: 'sub_1' });

    expect(again).toMatchObject({ status: 'recorded', outcome: 'unchanged' });
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

describe('order', () => {
  it('a late "active" after the cancellation still ends on the fallback plan', async () => {
    linkCustomer();
    holds(sub('sub_1'));
    await deliver({ subscriptionRef: 'sub_1' });
    // The provider cancels it; the cancellation arrives first, the older
    // update after it.
    holds(sub('sub_1', { status: 'ended', providerStatus: 'canceled', live: false }));

    await deliver({ subscriptionRef: 'sub_1', providerType: 'customer.subscription.deleted' });
    await deliver({ subscriptionRef: 'sub_1', providerType: 'customer.subscription.updated' });

    expect(stored()).toMatchObject({ status: 'ENDED', planKey: 'free' });
  });

  it('an upgrade and a cancellation in either order end on the provider’s state', async () => {
    for (const order of [
      ['upgrade', 'cancel'],
      ['cancel', 'upgrade'],
    ]) {
      db.records = new Map();
      db.ledger = [];
      settings.clear();
      linkCustomer();
      holds(sub('sub_1'));
      await deliver({ subscriptionRef: 'sub_1' });
      // Both happen at the provider before either event arrives.
      holds(
        sub('sub_1', {
          priceLookupKeys: ['team_monthly'],
          status: 'ended',
          providerStatus: 'canceled',
          live: false,
        })
      );
      for (const step of order) {
        await deliver({
          subscriptionRef: 'sub_1',
          providerType:
            step === 'cancel' ? 'customer.subscription.deleted' : 'customer.subscription.updated',
        });
      }
      expect(stored(), order.join(' then ')).toMatchObject({ status: 'ENDED', planKey: 'free' });
    }
  });

  it('a failure part-way commits nothing, so the retry is not mistaken for a replay', async () => {
    linkCustomer();
    holds(sub('sub_1'));
    mockApplyPlan.mockRejectedValueOnce(new Error('database went away'));

    await expect(deliver({ id: 'evt_crash', subscriptionRef: 'sub_1' })).rejects.toThrow(
      'database went away'
    );
    expect(db.ledger).toEqual([]);
    expect(stored()?.subscriptionRef).toBeNull();

    const retried = await deliver({ id: 'evt_crash', subscriptionRef: 'sub_1' });
    expect(retried).toMatchObject({ status: 'recorded', outcome: 'applied' });
    expect(stored()).toMatchObject({ planKey: 'pro', subscriptionRef: 'sub_1' });
  });

  it('fetches inside the lock, after the ledger row is in', async () => {
    linkCustomer();
    holds(sub('sub_1'));
    await deliver({ subscriptionRef: 'sub_1' });

    const lock = mockPrisma.$executeRaw.mock.invocationCallOrder[0];
    const ledger = mockPrisma.billingWebhookEvent.createMany.mock.invocationCallOrder[0];
    const fetches = vi.mocked(provider.fetchSubscription).mock.invocationCallOrder;
    expect(lock).toBeLessThan(ledger);
    expect(fetches.some((at) => at > ledger)).toBe(true);
  });
});

describe('lapsed subscriptions', () => {
  beforeEach(async () => {
    linkCustomer();
    holds(sub('sub_1'));
    await deliver({ subscriptionRef: 'sub_1' });
    mockApplyPlan.mockClear();
  });

  it('past due keeps the plan', async () => {
    holds(sub('sub_1', { status: 'past_due', providerStatus: 'past_due' }));
    await deliver({ kind: 'payment_failed', subscriptionRef: 'sub_1' });
    expect(stored()).toMatchObject({ status: 'PAST_DUE', planKey: 'pro' });
  });

  it.each(['canceled', 'unpaid'])('%s applies the fallback plan', async (providerStatus) => {
    holds(sub('sub_1', { status: 'ended', providerStatus, live: providerStatus === 'unpaid' }));
    await deliver({ subscriptionRef: 'sub_1' });
    expect(stored()).toMatchObject({ status: 'ENDED', planKey: 'free', providerStatus });
    expect(mockApplyPlan).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ key: 'free' }),
      expect.anything()
    );
    expect(settings.get(ORG)?.switches).toEqual({ reports: false });
  });

  it('with no fallback plan, turns off every switch the lapsed plan decided, and only those', async () => {
    plans.fallback = null;
    holds(sub('sub_1', { status: 'ended', providerStatus: 'canceled', live: false }));

    await deliver({ subscriptionRef: 'sub_1' });

    expect(stored()).toMatchObject({ status: 'ENDED', planKey: null });
    expect(mockApplyPlan).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({
        switches: { reports: false },
        meterLimits: {},
        aiBudgetUsd: undefined,
      }),
      expect.anything()
    );
  });

  it('cancelling at period end keeps the plan until the provider ends it', async () => {
    holds(sub('sub_1', { cancelAtPeriodEnd: true }));
    await deliver({ subscriptionRef: 'sub_1' });
    expect(stored()).toMatchObject({ status: 'ACTIVE', planKey: 'pro', cancelAtPeriodEnd: true });
  });

  it('forgets the cached AI budget after the commit when the budget changed', async () => {
    mockForgetOrgCap.mockClear();
    holds(sub('sub_1', { status: 'ended', providerStatus: 'canceled', live: false }));
    plans.list = plans.list.map((p) => (p.key === 'free' ? { ...p, aiBudgetUsd: 5 } : p));
    await deliver({ subscriptionRef: 'sub_1' });
    expect(mockForgetOrgCap).toHaveBeenCalledWith(ORG);
  });
});

describe('incomplete and unknown prices', () => {
  it('an incomplete first payment applies nothing: the org keeps what it had', async () => {
    linkCustomer();
    holds(sub('sub_1', { status: 'incomplete', providerStatus: 'incomplete' }));

    await deliver({ subscriptionRef: 'sub_1' });

    expect(stored()).toMatchObject({
      status: 'INCOMPLETE',
      planKey: 'free',
      subscriptionRef: 'sub_1',
    });
    expect(mockApplyPlan).not.toHaveBeenCalled();
  });

  it('a price no plan names records the status and leaves the plan, with a warning', async () => {
    linkCustomer();
    holds(sub('sub_1', { priceLookupKeys: ['made_in_dashboard'] }));

    await deliver({ subscriptionRef: 'sub_1' });

    expect(stored()).toMatchObject({ status: 'ACTIVE', planKey: 'free', subscriptionRef: 'sub_1' });
    expect(mockApplyPlan).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('names no plan'),
      expect.objectContaining({ priceLookupKeys: ['made_in_dashboard'] })
    );
  });
});

describe('the lapse happens once, and only after access', () => {
  it('an incomplete subscription that ends leaves the org as it was, a hand-assigned plan included', async () => {
    linkCustomer();
    db.records.set(ORG, { ...db.records.get(ORG)!, planKey: 'team' });
    holds(sub('sub_1', { status: 'incomplete', providerStatus: 'incomplete' }));
    await deliver({ subscriptionRef: 'sub_1' });

    holds(sub('sub_1', { status: 'ended', providerStatus: 'incomplete_expired', live: false }));
    await deliver({ subscriptionRef: 'sub_1' });

    expect(stored()).toMatchObject({ status: 'ENDED', planKey: 'team', providerLive: false });
    expect(mockApplyPlan).not.toHaveBeenCalled();
  });

  it('a later delivery about an ended subscription changes nothing more', async () => {
    linkCustomer();
    holds(sub('sub_1'));
    await deliver({ subscriptionRef: 'sub_1' });
    holds(sub('sub_1', { status: 'ended', providerStatus: 'canceled', live: false }));
    await deliver({ subscriptionRef: 'sub_1' });
    expect(stored()?.planKey).toBe('free');
    mockApplyPlan.mockClear();

    const again = await deliver({ subscriptionRef: 'sub_1' });

    expect(again).toMatchObject({ outcome: 'unchanged' });
    expect(mockApplyPlan).not.toHaveBeenCalled();
  });

  it('records that an unpaid subscription can still be charged, for erasure', async () => {
    linkCustomer();
    holds(sub('sub_1'));
    await deliver({ subscriptionRef: 'sub_1' });
    holds(sub('sub_1', { status: 'ended', providerStatus: 'unpaid', live: true }));

    await deliver({ subscriptionRef: 'sub_1' });

    expect(stored()).toMatchObject({ status: 'ENDED', providerLive: true });
  });
});

describe('one subscription per org', () => {
  it('when the stored one ends, adopts the customer’s other live subscription in the same delivery', async () => {
    linkCustomer();
    holds(sub('sub_old'));
    await deliver({ subscriptionRef: 'sub_old' });
    // The org resubscribed on team; the new one's event came first and was
    // refused while the old one was live.
    holds(sub('sub_new', { priceLookupKeys: ['team_monthly'] }));
    expect(await deliver({ subscriptionRef: 'sub_new' })).toMatchObject({ outcome: 'not_applied' });

    holds(sub('sub_old', { status: 'ended', providerStatus: 'canceled', live: false }));
    await deliver({ subscriptionRef: 'sub_old' });

    expect(stored()).toMatchObject({
      subscriptionRef: 'sub_new',
      status: 'ACTIVE',
      planKey: 'team',
    });
  });

  it('forgets the cached budget when the lapse changed it, even if the adopted plan does not', async () => {
    // pro ($100) lapses to free ($10), and team, adopted in the same
    // delivery, is $10 too: only the first write moved the budget.
    plans.list = plans.list.map((p) =>
      p.key === 'free' || p.key === 'team' ? { ...p, aiBudgetUsd: 10 } : p
    );
    linkCustomer();
    holds(sub('sub_old'));
    await deliver({ subscriptionRef: 'sub_old' });
    holds(sub('sub_new', { priceLookupKeys: ['team_monthly'] }));
    await deliver({ subscriptionRef: 'sub_new' });
    mockForgetOrgCap.mockClear();

    holds(sub('sub_old', { status: 'ended', providerStatus: 'canceled', live: false }));
    await deliver({ subscriptionRef: 'sub_old' });

    expect(stored()).toMatchObject({ subscriptionRef: 'sub_new', planKey: 'team' });
    expect(mockForgetOrgCap).toHaveBeenCalledWith(ORG);
  });

  it('a new live subscription replaces a stored one that has ended', async () => {
    linkCustomer();
    holds(sub('sub_old', { status: 'ended', providerStatus: 'canceled', live: false }));
    await deliver({ subscriptionRef: 'sub_old' });
    holds(sub('sub_new', { priceLookupKeys: ['team_monthly'] }));

    await deliver({ subscriptionRef: 'sub_new' });

    expect(stored()).toMatchObject({
      subscriptionRef: 'sub_new',
      planKey: 'team',
      status: 'ACTIVE',
    });
  });

  it('a late event for an old subscription that ended never replaces the live one', async () => {
    linkCustomer();
    holds(sub('sub_new'));
    await deliver({ subscriptionRef: 'sub_new' });
    holds(sub('sub_old', { status: 'ended', providerStatus: 'canceled', live: false }));

    const result = await deliver({ subscriptionRef: 'sub_old' });

    expect(result).toMatchObject({ outcome: 'unchanged' });
    expect(stored()).toMatchObject({ subscriptionRef: 'sub_new', planKey: 'pro' });
  });

  it('never moves an org linked to one customer onto another', async () => {
    linkCustomer('cus_a');
    holds(sub('sub_1', { customerRef: 'cus_other' }));

    const result = await deliver({ subscriptionRef: 'sub_1', customerRef: 'cus_a' });

    expect(result).toMatchObject({ outcome: 'not_applied' });
    expect(stored()).toMatchObject({
      customerRef: 'cus_a',
      subscriptionRef: null,
      planKey: 'free',
    });
    // Recorded, so a retry does not keep arriving as new.
    expect(db.ledger).toEqual([expect.objectContaining({ outcome: 'not_applied' })]);
  });

  it('refuses a subscription whose metadata names another org', async () => {
    linkCustomer();
    holds(sub('sub_1', { orgId: 'org_b' }));
    const result = await deliver({ subscriptionRef: 'sub_1' });
    expect(result).toMatchObject({ outcome: 'not_applied' });
    expect(stored()?.subscriptionRef).toBeNull();
  });

  it('records an event that names no subscription when the org has none', async () => {
    linkCustomer();
    const result = await deliver({ kind: 'payment_failed', subscriptionRef: null });
    expect(result).toMatchObject({ status: 'recorded', outcome: 'no_subscription' });
  });
});

describe('the audit row', () => {
  it('names the provider as the actor and what changed', async () => {
    linkCustomer();
    holds(sub('sub_1'));

    await deliver({ id: 'evt_audit', subscriptionRef: 'sub_1' });

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: null,
        action: 'org.billing.sync',
        entityId: ORG,
        actingOrgId: ORG,
        changes: expect.objectContaining({
          plan: { from: 'free', to: 'pro' },
          status: { from: 'ACTIVE', to: 'ACTIVE' },
        }),
        metadata: expect.objectContaining({ provider: 'stripe', eventId: 'evt_audit' }),
      })
    );
  });
});
