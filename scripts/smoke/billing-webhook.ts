/**
 * Smoke: the billing webhook, checkout and erasure against a real database
 * (§139 t-1094).
 *
 *   npm run smoke:billing-webhook
 *   STRIPE_MOCK_URL=http://localhost:12111 npm run smoke:billing-webhook   # and the Stripe adapter
 *
 * What the unit tests cannot show, because they mock Prisma:
 *
 *   • **A replay changes nothing on a real Postgres.** The ledger's unique
 *     key and `ON CONFLICT DO NOTHING` (Prisma's `skipDuplicates`) leave the
 *     transaction usable, and the second delivery writes neither the record
 *     nor the org row.
 *   • **A failure after the ledger insert rolls the insert back**, so the
 *     retry applies the change rather than reading as a replay.
 *   • **Two deliveries at once** run one after the other under the org's
 *     advisory lock, and the org ends on the provider's state.
 *   • **Deliveries out of order** end on the provider's state, with the
 *     fallback plan's settings on the real org row.
 *   • The ledger rows are written in the org's scope (RLS on in CI), are in
 *     the org export, and **erasure cancels the subscription at the provider
 *     before** the org's rows, ledger included, cascade away.
 *
 * The provider is one this script registers, modelled on Stripe's documented
 * behaviour as the spike's is: it holds each subscription's current state and
 * signs each delivery with an HMAC. With `STRIPE_MOCK_URL` set, a last section
 * drives the real Stripe adapter against `stripe-mock`: every request it
 * sends is valid against Stripe's OpenAPI spec, and a signed event verifies
 * and maps. stripe-mock keeps no state, so it cannot show convergence.
 *
 * Runs at `TENANCY_MODE=multi` with `BILLING_PROVIDER=smoke` (the npm script
 * sets both). Skips clean when no database is reachable. Self-cleaning: the
 * org it makes is removed on the way out, and a failed cleanup fails the run.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import '@/prisma/load-env';
import { prisma } from '@/lib/db/client';
import { startCheckout } from '@/lib/billing/checkout';
import { billingProvider } from '@/lib/billing/config';
import { registerPlan, setFallbackPlan } from '@/lib/billing/plans';
import {
  BillingSignatureError,
  registerBillingProvider,
  type BillingEvent,
  type BillingProvider,
  type ProviderSubscription,
} from '@/lib/billing/provider';
import { handleBillingWebhook } from '@/lib/billing/webhook';
import { eraseOrg } from '@/lib/privacy/erase-org';
import { ORG_DATA_SOURCES } from '@/lib/privacy/org-sources';
import { isMultiTenant, runAsOrg, runAsSystem } from '@/lib/tenancy/context';
import { registerEntitlementSwitch } from '@/lib/tenancy/entitlements';

const stamp = Date.now().toString(36);
const SECRET = 'smoke-billing-webhook-secret';
const PROVIDER = 'smoke';

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ✓ ${msg}`);
    return;
  }
  failures += 1;
  console.log(`  ✗ ${msg}`);
}

async function dbReachable(): Promise<boolean> {
  try {
    await runAsSystem('smoke: reachability', () => prisma.$queryRaw`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}

// ─── A provider modelled on Stripe ──────────────────────────────────────────

const remote = new Map<string, ProviderSubscription>();
const cancelled: string[] = [];
let failNextFetch = false;
let seq = 0;

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('hex');
}

const smokeProvider: BillingProvider = {
  key: PROVIDER,
  createCheckout: (input) =>
    Promise.resolve({
      url: 'https://checkout.smoke/s',
      customerRef: input.customerRef ?? `cus_${stamp}`,
    }),
  openPortal: () => Promise.resolve({ url: 'https://portal.smoke/p' }),
  parseWebhook: ({ rawBody, headers }) => {
    const given = Buffer.from(headers.get('x-smoke-signature') ?? '', 'hex');
    const expected = Buffer.from(sign(rawBody), 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return Promise.reject(new BillingSignatureError());
    }
    return Promise.resolve(JSON.parse(rawBody) as BillingEvent);
  },
  fetchSubscription: (ref) => {
    if (failNextFetch) {
      failNextFetch = false;
      return Promise.reject(new Error('smoke: the provider went away mid-delivery'));
    }
    return Promise.resolve(remote.get(ref) ?? null);
  },
  listLiveSubscriptions: (customerRef) =>
    Promise.resolve([...remote.values()].filter((s) => s.customerRef === customerRef && s.live)),
  findCustomerRefs: (orgId) =>
    Promise.resolve([
      ...new Set([...remote.values()].filter((s) => s.orgId === orgId).map((s) => s.customerRef)),
    ]),
  reportUsage: () => Promise.resolve(),
  cancelSubscription: (ref) => {
    const current = remote.get(ref);
    if (current?.live) {
      remote.set(ref, { ...current, status: 'ended', providerStatus: 'canceled', live: false });
      cancelled.push(ref);
    }
    return Promise.resolve();
  },
};

function hold(orgId: string, ref: string, overrides: Partial<ProviderSubscription> = {}): void {
  remote.set(ref, {
    ref,
    customerRef: `cus_${stamp}`,
    status: 'active',
    providerStatus: 'active',
    priceLookupKeys: [`smoke_pro_${stamp}`],
    periodStart: new Date('2026-11-01T00:00:00Z'),
    periodEnd: new Date('2026-12-01T00:00:00Z'),
    cancelAtPeriodEnd: false,
    endedAt: null,
    live: true,
    orgId,
    ...overrides,
  });
}

function deliver(
  event: { subscriptionRef: string; id?: string; type?: string },
  signature?: string
) {
  const body = JSON.stringify({
    id: event.id ?? `evt_${stamp}_${++seq}`,
    kind: 'subscription_changed',
    providerType: event.type ?? 'customer.subscription.updated',
    customerRef: `cus_${stamp}`,
    subscriptionRef: event.subscriptionRef,
  } satisfies BillingEvent);
  return handleBillingWebhook({
    providerKey: PROVIDER,
    rawBody: body,
    headers: new Headers({ 'x-smoke-signature': signature ?? sign(body) }),
  });
}

async function state(orgId: string) {
  const [org, record, ledger] = await Promise.all([
    prisma.org.findUniqueOrThrow({
      where: { id: orgId },
      select: { settings: true, updatedAt: true },
    }),
    runAsOrg(orgId, () => prisma.orgBillingSubscription.findUnique({ where: { orgId } })),
    runAsOrg(orgId, () =>
      prisma.billingWebhookEvent.findMany({ where: { orgId }, orderBy: { receivedAt: 'asc' } })
    ),
  ]);
  const settings = org.settings as { entitlements?: { on?: string[] } } | null;
  return { org, record, ledger, on: settings?.entitlements?.on ?? [] };
}

// ─── The real Stripe adapter against stripe-mock ────────────────────────────

async function stripeMockSection(url: string): Promise<void> {
  console.log(`\nThe Stripe adapter against stripe-mock (${url})`);
  const { default: Stripe } = await import('stripe');
  const { createStripeProvider } = await import('@/lib/billing/providers/stripe');
  const target = new URL(url);
  const adapter = createStripeProvider({
    secretKey: 'sk_test_smoke',
    webhookSecret: 'whsec_smoke',
    api: {
      host: target.hostname,
      port: Number(target.port || 80),
      protocol: target.protocol === 'https:' ? 'https' : 'http',
    },
  });
  const run = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      check(true, `${name}: a request stripe-mock accepts`);
    } catch (error) {
      check(false, `${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  await run('checkout (price by lookup key, customer, session)', () =>
    adapter.createCheckout({
      orgId: 'org_smoke',
      orgName: 'Smoke',
      customerRef: null,
      priceLookupKey: 'pro_monthly',
      successUrl: 'https://app.test/s',
      cancelUrl: 'https://app.test/c',
    })
  );
  await run('portal', () =>
    adapter.openPortal({ customerRef: 'cus_1', returnUrl: 'https://app.test/r' })
  );
  await run('subscription, with its items', async () => {
    const sub = await adapter.fetchSubscription('sub_1');
    if (!sub || !(sub.periodStart instanceof Date)) throw new Error('did not map');
  });
  await run('live subscriptions of a customer', () => adapter.listLiveSubscriptions('cus_1'));
  await run('customer search by org', () => adapter.findCustomerRefs('org_smoke'));
  await run('meter event', () =>
    adapter.reportUsage({
      customerRef: 'cus_1',
      subscriptionRef: 'sub_1',
      providerMeter: 'smoke_meter',
      quantity: 3,
      periodStart: new Date(),
      periodEnd: new Date(),
      final: true,
      at: new Date(),
      identifier: `smoke_${stamp}`,
    })
  );
  await run('cancel with usage invoiced', () => adapter.cancelSubscription('sub_1'));

  const body = JSON.stringify({
    id: 'evt_smoke',
    object: 'event',
    type: 'customer.subscription.deleted',
    data: { object: { id: 'sub_1', object: 'subscription', customer: 'cus_1' } },
  });
  const header = new Stripe('sk_test_smoke').webhooks.generateTestHeaderString({
    payload: body,
    secret: 'whsec_smoke',
  });
  const event = await adapter.parseWebhook({
    rawBody: body,
    headers: new Headers({ 'stripe-signature': header }),
  });
  check(
    event.kind === 'subscription_changed' && event.subscriptionRef === 'sub_1',
    'a signed event verifies with the SDK and maps to a subscription change'
  );
  const forged = await adapter
    .parseWebhook({ rawBody: `${body} `, headers: new Headers({ 'stripe-signature': header }) })
    .then(() => false)
    .catch((error: unknown) => error instanceof BillingSignatureError);
  check(forged, 'a body changed after signing is refused');
}

// ─── The run ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!isMultiTenant()) {
    console.error('✗ smoke:billing-webhook needs TENANCY_MODE=multi: billing applies only there');
    process.exit(1);
  }
  if (process.env.BILLING_PROVIDER !== PROVIDER) {
    console.error(`✗ smoke:billing-webhook needs BILLING_PROVIDER=${PROVIDER}`);
    process.exit(1);
  }
  if (!(await dbReachable())) {
    console.log('– no database reachable; skipped');
    return;
  }

  // Registered here rather than through lib/app/*, which ships empty.
  registerEntitlementSwitch({ key: 'smoke_paid', label: 'Smoke paid area', description: '' });
  registerPlan({ key: 'smoke_free', label: 'Smoke Free', switches: { smoke_paid: false } });
  registerPlan({
    key: 'smoke_pro',
    label: 'Smoke Pro',
    switches: { smoke_paid: true },
    priceLookupKey: `smoke_pro_${stamp}`,
  });
  setFallbackPlan('smoke_free');
  registerBillingProvider({ key: PROVIDER, create: () => smokeProvider });
  check((await billingProvider())?.key === PROVIDER, 'billing is on with the smoke provider');

  let orgId: string | null = null;
  try {
    const org = await prisma.org.create({
      data: { slug: `smoke-billing-webhook-${stamp}`, name: 'Smoke billing webhook' },
      select: { id: true },
    });
    orgId = org.id;
    const id = orgId;

    console.log('\nCheckout');
    const checkout = await startCheckout(id, 'smoke_pro');
    let now = await state(id);
    check(checkout.url.startsWith('https://checkout.smoke/'), 'answers the provider’s URL');
    check(now.record?.customerRef === `cus_${stamp}`, 'stores the customer, in the org’s scope');
    check(!now.on.includes('smoke_paid'), 'and changes no setting: the webhook decides the plan');

    console.log('\nA forged delivery');
    hold(id, `sub_${stamp}`);
    const forged = await deliver({ subscriptionRef: `sub_${stamp}` }, '00'.repeat(32));
    now = await state(id);
    check(forged.status === 'bad_signature', 'is refused');
    check(now.ledger.length === 0 && now.record?.subscriptionRef === null, 'and wrote nothing');

    console.log('\nThe completed checkout');
    const first = await deliver({ id: `evt_${stamp}_first`, subscriptionRef: `sub_${stamp}` });
    now = await state(id);
    check(first.status === 'recorded' && first.outcome === 'applied', 'is applied');
    check(
      now.record?.planKey === 'smoke_pro' && now.record.status === 'ACTIVE',
      'the org is on the plan it bought'
    );
    check(now.on.includes('smoke_paid'), 'with the plan’s switch on the real org row');
    check(
      now.ledger.length === 1 && now.ledger[0]?.orgId === id,
      'one ledger row, stamped with the org'
    );

    console.log('\nThe same event again');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const replay = await deliver({ id: `evt_${stamp}_first`, subscriptionRef: `sub_${stamp}` });
    const after = await state(id);
    check(replay.status === 'replay', 'is a replay');
    check(after.ledger.length === 1, 'still one ledger row');
    check(
      after.org.updatedAt.getTime() === now.org.updatedAt.getTime() &&
        after.record?.updatedAt.getTime() === now.record?.updatedAt.getTime(),
      'neither the org row nor the record was written'
    );

    console.log('\nA failure after the ledger insert');
    hold(id, `sub_${stamp}`, { cancelAtPeriodEnd: true });
    failNextFetch = true;
    const crashed = await deliver({ id: `evt_${stamp}_crash`, subscriptionRef: `sub_${stamp}` })
      .then(() => false)
      .catch(() => true);
    now = await state(id);
    check(crashed, 'throws, so the route answers 500');
    check(now.ledger.length === 1, 'and the ledger insert was rolled back');
    const retried = await deliver({ id: `evt_${stamp}_crash`, subscriptionRef: `sub_${stamp}` });
    now = await state(id);
    check(retried.status === 'recorded', 'so the retry is not mistaken for a replay');
    check(now.record?.cancelAtPeriodEnd === true, 'and applies the change');

    console.log('\nTwo deliveries at once, and out of order');
    // At the provider: cancelled. The cancellation and a late update arrive together.
    hold(id, `sub_${stamp}`, { status: 'ended', providerStatus: 'canceled', live: false });
    const both = await Promise.all([
      deliver({ subscriptionRef: `sub_${stamp}`, type: 'customer.subscription.updated' }),
      deliver({ subscriptionRef: `sub_${stamp}`, type: 'customer.subscription.deleted' }),
    ]);
    now = await state(id);
    check(
      both.every((r) => r.status === 'recorded'),
      'both are recorded'
    );
    check(
      now.record?.status === 'ENDED' && now.record.planKey === 'smoke_free',
      'the org ends on the fallback plan'
    );
    check(!now.on.includes('smoke_paid'), 'with the paid switch off on the real row');
    check(now.ledger.length === 4, 'four ledger rows');

    console.log('\nResubscribing, then erasure');
    hold(id, `sub2_${stamp}`);
    await deliver({ subscriptionRef: `sub2_${stamp}` });
    now = await state(id);
    check(
      now.record?.subscriptionRef === `sub2_${stamp}` && now.on.includes('smoke_paid'),
      'a new subscription replaces the ended one'
    );
    const source = ORG_DATA_SOURCES.find((s) => s.model === 'BillingWebhookEvent');
    const exported = source ? await runAsOrg(id, () => source.fetch({ orgId: id })) : [];
    check(
      exported.length === now.ledger.length,
      'the org export’s source returns every ledger row'
    );

    const actor = await prisma.user.findFirst({ select: { id: true } });
    await eraseOrg({ orgId: id, actorUserId: actor?.id ?? 'smoke' });
    check(
      cancelled.includes(`sub2_${stamp}`),
      'erasure cancelled the live subscription at the provider'
    );
    const left = await runAsSystem('smoke: billing-webhook erasure check', async () => ({
      ledger: await prisma.billingWebhookEvent.count({ where: { orgId: id } }),
      record: await prisma.orgBillingSubscription.count({ where: { orgId: id } }),
    }));
    check(left.ledger === 0 && left.record === 0, 'and the org’s billing rows cascaded away');
    orgId = null;

    const late = await deliver({ subscriptionRef: `sub2_${stamp}` });
    check(late.status === 'no_org', 'a late event for the erased org is dropped');
  } finally {
    if (orgId) {
      const id = orgId;
      await runAsSystem('smoke: billing-webhook cleanup', () =>
        prisma.org.deleteMany({ where: { id } })
      ).catch((err: unknown) => {
        console.error('✗ cleanup failed — remove the smoke-billing-webhook org by hand', err);
        process.exitCode = 1;
      });
    }
  }

  const mock = process.env.STRIPE_MOCK_URL;
  if (mock) await stripeMockSection(mock);
  else console.log('\n– STRIPE_MOCK_URL not set; the Stripe adapter section was skipped');

  await prisma.$disconnect();
  if (failures > 0) {
    console.error(
      `\n✗ smoke:billing-webhook failed (${failures} check${failures === 1 ? '' : 's'})`
    );
    process.exitCode = 1;
  } else if (process.exitCode !== 1) {
    console.log('\n✓ smoke:billing-webhook passed');
  }
}

main().catch((err: unknown) => {
  console.error('\n✗ smoke:billing-webhook failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
