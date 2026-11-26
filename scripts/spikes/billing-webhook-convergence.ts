/**
 * Billing spike (§139 t-1092): do replayed and reordered webhooks converge?
 *
 * Kept, not thrown away: the adapter task (t-1094) and the usage task (t-1097)
 * build against the rules it checks, and re-running it is cheaper than
 * re-deriving why each rule is there. The binding answer is
 * `.context/billing/billing.md`; this script is the evidence behind it.
 *
 * Dependency-free on purpose (Node's `crypto` and `fetch` only). Installing
 * the `stripe` package is t-1094's change, and a spike should not add a
 * runtime dependency to every fork's lockfile.
 *
 *   # parts B to F, offline
 *   npx tsx scripts/spikes/billing-webhook-convergence.ts
 *
 *   # also part A: the requests the adapter will send, checked by stripe-mock
 *   go install github.com/stripe/stripe-mock@latest   # or: docker run -p 12111:12111 stripe/stripe-mock
 *   stripe-mock &                                      # listens on :12111
 *   STRIPE_MOCK_URL=http://localhost:12111 npx tsx scripts/spikes/billing-webhook-convergence.ts
 *
 * **What stripe-mock can and cannot show.** It validates each request against
 * Stripe's OpenAPI spec and answers with fixed fixtures. It keeps no state
 * (cancelling a subscription still answers `active`) and sends no webhooks.
 * So convergence (parts C to F) runs against a provider modelled here, whose
 * events behave the way Stripe documents: delivered at least once, in no
 * guaranteed order, each carrying a snapshot of the object when it was
 * created. Part A checks only that the adapter's requests are well formed.
 *
 *   A  the adapter's requests, against stripe-mock (skipped without it)
 *   B  signature verification over the raw body
 *   C  replay and reorder: three ways of applying events
 *   D  two deliveries at once: fetch outside or inside a per-org lock
 *   E  a crash between recording the event and applying it
 *   F  usage: one report per (org, meter, period), and `sum` vs `last`
 *
 * Exits 1 if any expectation fails.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

let failures = 0;
function expect(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
}

// ─── A: the adapter's requests, against stripe-mock ──────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function partA(): Promise<void> {
  console.log('\nA  The adapter’s requests, against stripe-mock');
  const base = process.env.STRIPE_MOCK_URL;
  if (!base) {
    console.log('  skipped: set STRIPE_MOCK_URL (e.g. http://localhost:12111)');
    return;
  }
  // Sent because the adapter pins it. stripe-mock ignores the header and
  // serves the OpenAPI spec it was built with, so the period check below is
  // only as current as the build: use one released after 2025-03-31.
  const baseHeaders: Record<string, string> = {
    Authorization: 'Bearer sk_test_123',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Stripe-Version': '2025-03-31.basil',
  };
  let requestCount = 0;
  async function call(method: string, path: string, form?: Record<string, string>) {
    const body = form ? new URLSearchParams(form).toString() : undefined;
    // One idempotency key per mutating request. Stripe refuses a key reused
    // with different parameters; stripe-mock does not check, so a shared key
    // would pass here and fail live. GETs are idempotent and send none.
    requestCount += 1;
    const headers =
      method === 'GET'
        ? baseHeaders
        : { ...baseHeaders, 'Idempotency-Key': `spike-${Date.now()}-${requestCount}` };
    const res = await fetch(`${base}${path}`, { method, headers, body });
    const parsed: unknown = await res.json();
    return { status: res.status, json: isRecord(parsed) ? parsed : {} };
  }

  // Plans name a price by lookup key, which is the same in test and live mode;
  // price ids are not.
  const prices = await call('GET', '/v1/prices?lookup_keys[]=pro_monthly');
  expect('prices are found by lookup key', prices.status === 200);

  // One customer per org, created by the platform, the org id in its metadata.
  const customer = await call('POST', '/v1/customers', {
    name: 'Example org',
    'metadata[orgId]': 'org_a',
  });
  expect('a customer is created with the org id in its metadata', customer.status === 200);

  const checkout = await call('POST', '/v1/checkout/sessions', {
    mode: 'subscription',
    customer: 'cus_123',
    'line_items[0][price]': 'price_123',
    'line_items[0][quantity]': '1',
    success_url: 'https://app.example/admin/billing?checkout=done',
    cancel_url: 'https://app.example/admin/billing',
    client_reference_id: 'org_a',
    'subscription_data[metadata][orgId]': 'org_a',
  });
  expect(
    'a subscription checkout returns a hosted URL',
    checkout.status === 200 && typeof checkout.json.url === 'string'
  );

  const portal = await call('POST', '/v1/billing_portal/sessions', {
    customer: 'cus_123',
    return_url: 'https://app.example/admin/billing',
  });
  expect(
    'a portal session returns a hosted URL',
    portal.status === 200 && typeof portal.json.url === 'string'
  );

  const sub = await call('GET', '/v1/subscriptions/sub_123?expand[]=items.data.price');
  const itemList = isRecord(sub.json.items) ? sub.json.items.data : undefined;
  const firstItem = Array.isArray(itemList) && isRecord(itemList[0]) ? itemList[0] : undefined;
  expect(
    'the billing period is on each subscription item, not the subscription (API 2025-03-31.basil)',
    sub.status === 200 &&
      sub.json.current_period_end === undefined &&
      typeof firstItem?.current_period_end === 'number'
  );

  const meterEvent = await call('POST', '/v1/billing/meter_events', {
    event_name: 'conversations',
    'payload[stripe_customer_id]': 'cus_123',
    'payload[value]': '42',
    identifier: 'usage_report_cuid123',
    timestamp: String(Math.floor(Date.now() / 1000) - 60),
  });
  expect('a meter event with an identifier and timestamp is accepted', meterEvent.status === 200);

  // Erasure finds customers whose reference was never stored by metadata...
  const search = await call(
    'GET',
    `/v1/customers/search?query=${encodeURIComponent("metadata['orgId']:'org_a'")}`
  );
  expect('customers are found by the org id in their metadata', search.status === 200);

  // ...and lists every subscription of each customer. Stripe's `status=all`
  // includes ended ones; the adapter keeps those it calls live.
  const list = await call('GET', '/v1/subscriptions?customer=cus_123&status=all');
  expect(
    'a customer’s subscriptions are listed',
    list.status === 200 && Array.isArray(list.json.data)
  );

  const cancel = await call('DELETE', '/v1/subscriptions/sub_123', { invoice_now: 'true' });
  expect(
    'an immediate cancel with usage invoiced (org erasure) is accepted',
    cancel.status === 200
  );
  console.log(
    `  note: the cancelled subscription answers status "${String(cancel.json.status)}": stripe-mock keeps no state`
  );

  const bad = await call('POST', '/v1/billing/meter_events', {
    event_name: 'conversations',
    'payload[value]': '1',
    not_a_param: 'x',
  });
  expect('stripe-mock refuses a parameter Stripe does not have', bad.status === 400);
}

// ─── B: signature verification ───────────────────────────────────────────────

const TOLERANCE_S = 300; // the official libraries' default

function sign(rawBody: string, secret: string, t: number): string {
  const v1 = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

/** What the adapter does before anything is parsed, read or written. */
function verify(rawBody: string, header: string, secret: string, now: number): boolean {
  const parts = header.split(',').map((p): [string, string] => {
    const at = p.indexOf('=');
    return at === -1 ? [p, ''] : [p.slice(0, at), p.slice(at + 1)];
  });
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const v1s = parts.filter(([k]) => k === 'v1').map(([, v]) => v); // ignore v0 and others
  if (!Number.isFinite(t) || v1s.length === 0) return false;
  if (Math.abs(now - t) > TOLERANCE_S) return false;
  const expected = Buffer.from(
    createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
  );
  return v1s.some((v) => {
    const got = Buffer.from(v);
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

function partB(): void {
  console.log('\nB  Signature verification over the raw body');
  const secret = 'whsec_spike';
  const now = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.updated' });
  const header = sign(body, secret, now);
  expect('a correctly signed body verifies', verify(body, header, secret, now));
  expect(
    'a re-serialised body does not (verify the raw bytes, never parsed JSON)',
    !verify(JSON.stringify(JSON.parse(body), null, 2), header, secret, now)
  );
  expect('the wrong secret does not', !verify(body, header, 'whsec_other', now));
  expect(
    'a signature older than the tolerance does not',
    !verify(body, sign(body, secret, now - 301), secret, now)
  );
  const v0Only = header.replace('v1=', 'v0=');
  expect('a header with no v1 scheme does not', !verify(body, v0Only, secret, now));
}

// ─── The modelled provider ───────────────────────────────────────────────────

type ProviderStatus = 'incomplete' | 'active' | 'past_due' | 'canceled' | 'unpaid';
interface ProviderSub {
  id: string;
  customer: string;
  status: ProviderStatus;
  price: string; // lookup key of the subscribed price
}
interface ProviderEvent {
  id: string;
  type: string;
  created: number; // seconds, as Stripe sends it
  data: { object: ProviderSub };
}

/** The subscription's history, one event per change, as Stripe would emit them. */
function timeline(): { events: ProviderEvent[]; current: ProviderSub } {
  const states: Array<[ProviderStatus, string, number]> = [
    ['incomplete', 'pro_monthly', 1000],
    ['active', 'pro_monthly', 1001],
    ['past_due', 'pro_monthly', 2000],
    ['active', 'pro_monthly', 2100],
    ['active', 'team_monthly', 3000], // upgraded in the portal
    ['canceled', 'team_monthly', 3000], // same second as the upgrade
  ];
  const events = states.map(([status, price, created], i) => ({
    id: `evt_${i + 1}`,
    type: i === 0 ? 'customer.subscription.created' : 'customer.subscription.updated',
    created,
    data: { object: { id: 'sub_1', customer: 'cus_a', status, price } },
  }));
  return { events, current: { ...events[events.length - 1].data.object } };
}

/** What the platform holds for the org, and how many plan writes it made. */
interface OrgBilling {
  plan: string | null;
  status: string | null;
  planWrites: number;
}

const FALLBACK_PLAN = 'free';

/** Which plan a provider state puts the org on (the lapsed-subscription rule). */
function planFor(sub: ProviderSub): string | null {
  if (sub.status === 'incomplete') return null; // not paid yet: nothing applied
  if (sub.status === 'canceled' || sub.status === 'unpaid') return FALLBACK_PLAN;
  return sub.price === 'team_monthly' ? 'team' : 'pro'; // active and past_due keep the plan
}

/** Apply-plan as t-1093 builds it: writes only when something changed. */
function applyState(org: OrgBilling, sub: ProviderSub): void {
  const plan = planFor(sub);
  if (plan !== null && plan !== org.plan) {
    org.plan = plan;
    org.planWrites += 1;
  }
  org.status = sub.status;
}

// ─── C: replay and reorder ───────────────────────────────────────────────────

type Applier = (deliveries: ProviderEvent[], current: ProviderSub) => OrgBilling;

/** Apply each event's snapshot as it arrives. */
const naiveSnapshot: Applier = (deliveries) => {
  const org: OrgBilling = { plan: null, status: null, planWrites: 0 };
  for (const e of deliveries) applyState(org, e.data.object);
  return org;
};

/** Apply a snapshot only when its `created` is newer than the last applied. */
const createdOrdering: Applier = (deliveries) => {
  const org: OrgBilling = { plan: null, status: null, planWrites: 0 };
  let last = -1;
  for (const e of deliveries) {
    if (e.created <= last) continue;
    last = e.created;
    applyState(org, e.data.object);
  }
  return org;
};

/** The spec's rule: record the event id once, then apply the provider's current object. */
const ledgerAndFetch: Applier = (deliveries, current) => {
  const org: OrgBilling = { plan: null, status: null, planWrites: 0 };
  const ledger = new Set<string>();
  for (const e of deliveries) {
    if (ledger.has(e.id)) continue; // a replay: nothing to do
    ledger.add(e.id);
    applyState(org, current); // fetched now, not the event's snapshot
  }
  return org;
};

function partC(): void {
  console.log('\nC  Replay and reorder');
  const { events, current } = timeline();
  const [e1, e2, e3, e4, e5, e6] = events;
  const orders: Record<string, ProviderEvent[]> = {
    'in order': events,
    replayed: [e1, e1, e2, e3, e3, e4, e5, e6, e6, e2],
    reordered: [e6, e3, e1, e5, e2, e4],
  };
  // Every delivery here arrives after the last change, so each fetch sees the
  // final state: the worst case for reordering. A fetch racing a change is D.
  const want = planFor(current);
  for (const [name, deliveries] of Object.entries(orders)) {
    const naive = naiveSnapshot(deliveries, current);
    const byCreated = createdOrdering(deliveries, current);
    const spec = ledgerAndFetch(deliveries, current);
    console.log(
      `  ${name}: naive → ${naive.plan}, by created → ${byCreated.plan}, ledger+fetch → ${spec.plan} (want ${want})`
    );
    expect(`${name}: ledger + fetch ends on the provider's current state`, spec.plan === want);
    // Every fetch sees one state, so exactly one plan write is right: a replay
    // or a later delivery of the same state must add none.
    expect(
      `${name}: ledger + fetch writes the plan once, however often events arrive`,
      spec.planWrites === 1,
      `${spec.planWrites} writes`
    );
  }
  // The two rejected rules, and why: shown, not just asserted.
  const naiveReordered = naiveSnapshot(orders.reordered, current);
  expect(
    'rejected: applying snapshots as they arrive ends on a stale state when reordered',
    naiveReordered.plan !== want,
    `ends on ${naiveReordered.plan}`
  );
  const tie = createdOrdering(orders['in order'], current);
  expect(
    'rejected: ordering by `created` drops the second of two events in the same second, even in order',
    tie.plan !== want,
    `ends on ${tie.plan}`
  );
}

// ─── D: two deliveries at once ───────────────────────────────────────────────

const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function partD(): Promise<void> {
  console.log('\nD  Two deliveries handled at once');
  async function run(withLock: boolean): Promise<string | null> {
    const provider: ProviderSub = {
      id: 'sub_1',
      customer: 'cus_a',
      status: 'active',
      price: 'pro_monthly',
    };
    const org: OrgBilling = { plan: null, status: null, planWrites: 0 };
    let lock: Promise<void> = Promise.resolve();
    async function handle(fetchDelay: number, writeDelay: number): Promise<void> {
      const work = async () => {
        await tick(fetchDelay);
        const fetched = { ...provider }; // the fetch
        await tick(writeDelay); // a slow write
        applyState(org, fetched);
      };
      if (!withLock) return work();
      const prior = lock;
      let release!: () => void;
      lock = new Promise<void>((r) => (release = r));
      await prior;
      try {
        await work();
      } finally {
        release();
      }
    }
    // Delivery 1 fetches "active" and writes slowly; the subscription is then
    // cancelled; delivery 2 fetches "canceled" and writes quickly.
    const first = handle(0, 30);
    await tick(5);
    provider.status = 'canceled';
    const second = handle(0, 0);
    await Promise.all([first, second]);
    return org.plan;
  }
  const unlocked = await run(false);
  const locked = await run(true);
  expect(
    'rejected: fetching outside a lock lets an older fetch land last',
    unlocked !== FALLBACK_PLAN,
    `ends on ${unlocked}`
  );
  expect(
    'fetching inside a per-org lock ends on the current state',
    locked === FALLBACK_PLAN,
    `ends on ${locked}`
  );
}

// ─── E: a crash between recording and applying ───────────────────────────────

function partE(): void {
  console.log('\nE  A crash between recording the event and applying it');
  const current: ProviderSub = {
    id: 'sub_1',
    customer: 'cus_a',
    status: 'canceled',
    price: 'pro_monthly',
  };
  const event: ProviderEvent = {
    id: 'evt_last',
    type: 'customer.subscription.deleted',
    created: 5000,
    data: { object: current },
  };
  function deliverTwice(sameTransaction: boolean): string | null {
    const ledger = new Set<string>();
    const org: OrgBilling = { plan: 'pro', status: 'active', planWrites: 0 };
    for (const attempt of [1, 2]) {
      if (ledger.has(event.id)) continue;
      const staged = { ...org };
      if (!sameTransaction) ledger.add(event.id); // committed on its own
      const crashed = attempt === 1; // the apply fails; the endpoint answers 500
      if (crashed) continue;
      applyState(staged, current);
      if (sameTransaction) ledger.add(event.id);
      Object.assign(org, staged);
    }
    return org.plan;
  }
  const separate = deliverTwice(false);
  const together = deliverTwice(true);
  expect(
    'rejected: committing the ledger row on its own skips the retry, so the last change is lost',
    separate !== FALLBACK_PLAN,
    `ends on ${separate}`
  );
  expect(
    'committing the ledger row with the apply lets the retry apply it',
    together === FALLBACK_PLAN,
    `ends on ${together}`
  );
}

// ─── F: usage reports ────────────────────────────────────────────────────────

async function partF(): Promise<void> {
  console.log('\nF  Usage: one report per (org, meter, period)');
  const DAY = 86_400;

  /** A meter at the provider: events deduplicated on identifier for 24 hours. */
  function providerMeter(formula: 'sum' | 'last') {
    const seen = new Map<string, number>(); // identifier → when accepted
    const values: number[] = [];
    return {
      send(identifier: string, value: number, at: number): void {
        const when = seen.get(identifier);
        if (when !== undefined && at - when < DAY) return; // deduplicated
        seen.set(identifier, at);
        values.push(value);
      },
      billed(): number {
        if (values.length === 0) return 0;
        return formula === 'sum' ? values.reduce((a, b) => a + b, 0) : values[values.length - 1];
      },
    };
  }

  // Two instances run the closing job for the same period at once. The report
  // row is unique on (org, meter, period start); it is written before sending.
  const reports = new Map<string, { value: number; sent: boolean }>();
  let counts = 0;
  const meter = providerMeter('last');
  async function closingJob(): Promise<void> {
    const key = 'org_a:conversations:2026-11-01T00:00:00Z';
    if (!reports.has(key)) {
      counts += 1;
      const value = 42; // counted once, at close, and frozen on the row
      await tick(1);
      if (!reports.has(key)) reports.set(key, { value, sent: false }); // the unique insert
    }
    const row = reports.get(key)!;
    if (row.sent) return;
    meter.send(key, row.value, 0); // identifier = the report's key
    row.sent = true;
  }
  await Promise.all([closingJob(), closingJob()]);
  await closingJob(); // a retried tick
  expect('two instances and a retried tick bill the period once', meter.billed() === 42);
  expect('one report row exists', reports.size === 1);
  console.log(`  (counted ${counts} time(s); only the row that was inserted is ever sent)`);

  // A report that stayed unsent (the send failed) is resent more than a day
  // later, after Stripe's identifier window has passed.
  const sum = providerMeter('sum');
  const last = providerMeter('last');
  for (const m of [sum, last]) {
    m.send('rep_1', 42, 0);
    m.send('rep_1', 42, 2 * DAY); // our row never recorded the first send as sent
  }
  expect(
    'rejected: with `sum`, a resend after the 24-hour identifier window bills twice',
    sum.billed() === 84,
    `bills ${sum.billed()}`
  );
  expect(
    'with `last`, resending the same period total bills it once, at any age',
    last.billed() === 42
  );
}

async function main(): Promise<void> {
  console.log('Billing spike (§139 t-1092)');
  await partA();
  partB();
  partC();
  await partD();
  partE();
  await partF();
  console.log(failures === 0 ? '\nAll expectations held.' : `\n${failures} expectation(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
