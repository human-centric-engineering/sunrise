# Billing

An app on Sunrise can say what an org has (entitlement switches, meter limits
and an AI budget, [`entitlements.md`](../tenancy/entitlements.md)). Billing
lets an org pay for it: an app defines **plans**, an org subscribes to one
through a **payment provider**, and the plan's entitlements follow the
subscription. Usage on a metered item is reported to
the provider once per billing period.

This is the binding spec for §139 (`f-billing-payments`). The tasks point here
rather than restate it. It was written from Stripe's documentation and
`stripe-mock`, without a Stripe account; the spike behind it is
`scripts/spikes/billing-webhook-convergence.ts` ([The spike](#the-spike)).

**Off by default, and only at `TENANCY_MODE=multi`.** With `BILLING_PROVIDER`
unset nothing on this page runs, the `stripe` package is never loaded, and
every billing route answers that billing is off.

## Status

Each section describes the design whether or not its task has merged. This
table says what exists.

| Part                                                                          | Task   | State         |
| ----------------------------------------------------------------------------- | ------ | ------------- |
| This spec, and the spike                                                      | t-1092 | **Built**     |
| Plans as bundles of entitlements; the org's subscription record; staff assign | t-1093 | Not built yet |
| The provider adapter, Stripe, checkout, portal, the webhook, lapsed handling  | t-1094 | Not built yet |
| The billing page in the org-admin console                                     | t-1095 | Not built yet |
| Choosing a plan at signup                                                     | t-1096 | Not built yet |
| Usage reported each period; the overage rule                                  | t-1097 | Not built yet |

## Who owns what

Decision D1 (recorded 2026-11-16, amending design principle 8): **the billing
mechanism is the platform's; the product is the app's.**

| The platform owns                                                             | The app owns                                         |
| ----------------------------------------------------------------------------- | ---------------------------------------------------- |
| The plan registry and applying a plan to an org's switches, limits and budget | Its plans: their keys, labels and what each decides  |
| The adapter interface and the Stripe adapter                                  | Its prices, set up at the provider                   |
| Checkout, the customer portal, the signed webhook, the event ledger           | Which meters are billed, and each one's overage rule |
| What a lapsed subscription does to an org                                     | Its fallback plan                                    |
| Counting each billed meter per period and reporting it once                   | What a meter counts (`registerMeter()`)              |
| The org's billing records, and their export and erasure                       | Another provider, if Stripe does not suit it         |

Why the line sits here: every app that sells to orgs needs checkout, webhook
verification, replay handling and lapsed-subscription handling, and those are
the parts most often got wrong. What differs between apps is what they sell and
for how much, and none of that needs code in the platform.

## Switching it on

| Variable                | Meaning                                                                  |
| ----------------------- | ------------------------------------------------------------------------ |
| `BILLING_PROVIDER`      | `stripe`, or the key of a provider the app registers. Unset: billing off |
| `STRIPE_SECRET_KEY`     | `sk_test_…` or `sk_live_…`. Required when the provider is `stripe`       |
| `STRIPE_WEBHOOK_SECRET` | The endpoint's `whsec_…` signing secret. Required when it is `stripe`    |

- **The Stripe adapter ships in core and is loaded only when chosen.** The
  `stripe` package is imported with a dynamic `import()` inside the adapter's
  factory, which runs only when `BILLING_PROVIDER=stripe`. The cost to a fork
  that never bills is one entry in its lockfile. A separate package was
  rejected: it would add a publishing and versioning track for one adapter.
- **The SDK, not hand-written `fetch`.** Signature verification and API
  versioning are where hand-written code goes wrong. The spike verifies
  signatures by hand only so that it adds no dependency.
- **The API version is pinned in code**, in the adapter's client options, so
  that an SDK upgrade does not move it silently. Since the webhook reads only
  each event's id, type and object reference ([Webhooks](#webhooks)), the
  version the endpoint is registered with matters less than it would if
  snapshots were applied.
- **Missing keys while enabled, or `BILLING_PROVIDER` set at `single`**, show
  in config health (§133) and leave billing off. Neither throws at boot.
- **An app adds another provider** through `lib/app/billing.ts`, the same seam
  its plans are registered in, and names it in `BILLING_PROVIDER`.

## Plans

A plan is an app's name for a set of entitlements. t-1093 builds the registry;
the shape it must hold:

- **A key and a label.** The key is stored on the org's subscription record, so
  the entitlement key rules apply: never rename one orgs hold, never reuse a
  retired one.
- **Every switch it decides, on or off.** Naming only the switches that are on
  leaves default-on switches on (the entitlements anti-pattern). A switch the
  plan does not mention is left as it is.
- **Meter limits and an AI budget cap**, each optional. Applied through
  `setOrgSwitches()`, `writeOrgMeterLimits()` and `writeOrgQuotas()`, never by
  writing `Org.settings` directly.
- **Metered items**, each a meter key, the provider's name for it, an
  allowance and an overage rule ([Usage](#usage-reporting)).
- **A price at the provider, named by lookup key**, not by price id. Stripe
  price ids differ between test and live mode; a lookup key (`pro_monthly`) is
  set by the operator on both. A plan with no price is one staff assign by
  hand or give away; it never goes through checkout.
- **The app's fallback plan**, named once for the app, not per plan: what an
  org moves to when its subscription ends ([Lapsed subscriptions](#lapsed-subscriptions)).

**Applying a plan is idempotent**: it compares and writes only what changed, so
re-applying one writes nothing. The webhook relies on this. A replay re-applies
the current state, and that must be a no-op, not a fresh audit row.

**Which plan an org is on comes from the provider's subscription, not from the
checkout.** The adapter reads the subscription's price lookup keys and the
plan with that key is applied. A subscription on a price no plan names (made by
hand in the Stripe Dashboard, say) is recorded with its status. The org's plan
is left unchanged, and config health warns.

## The adapter

A provider implements this interface (`lib/billing/provider.ts`, t-1094).
Types are provider-neutral: no Stripe type crosses it.

```ts
interface BillingProvider {
  /** The value of BILLING_PROVIDER that selects it: 'stripe'. */
  readonly key: string;

  /**
   * A hosted checkout for one plan. Creates the org's customer on first use.
   * Writes the org id into the metadata of the customer, the session and the
   * subscription, so a webhook can find the org before the reference is stored.
   */
  createCheckout(input: {
    orgId: string;
    orgName: string;
    customerRef: string | null; // stored on the org's record after the first checkout
    priceLookupKey: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string; customerRef: string }>;

  /** The provider's own page for changing plan, card or cancelling. */
  openPortal(input: { customerRef: string; returnUrl: string }): Promise<{ url: string }>;

  /**
   * Verify the signature over the raw body, then say what changed. Never
   * returns state: the caller fetches it. Throws BillingSignatureError on a
   * bad or stale signature, before anything is parsed.
   */
  parseWebhook(input: { rawBody: string; headers: Headers }): Promise<BillingEvent>;

  /** The subscription as the provider holds it now. null if it does not exist. */
  fetchSubscription(subscriptionRef: string): Promise<ProviderSubscription | null>;

  /** One closed period's billed quantity for one metered item. Safe to resend. */
  reportUsage(input: {
    customerRef: string;
    subscriptionRef: string;
    providerMeter: string;
    quantity: number; // a whole number
    periodStart: Date;
    periodEnd: Date;
    identifier: string; // the usage report's id, stable across resends
  }): Promise<void>;

  /**
   * End it now, without a refund decision. Org erasure calls this. A
   * subscription that has already ended, or that the provider does not have,
   * counts as success: the outcome erasure needs is already true.
   */
  cancelSubscription(subscriptionRef: string): Promise<void>;
}

interface BillingEvent {
  id: string; // the provider's event id: the ledger key
  kind: 'subscription_changed' | 'checkout_completed' | 'payment_failed' | 'ignored';
  providerType: string; // 'customer.subscription.updated', kept for the ledger
  customerRef: string | null;
  subscriptionRef: string | null;
}

interface ProviderSubscription {
  ref: string;
  customerRef: string;
  status: 'incomplete' | 'active' | 'past_due' | 'ended';
  providerStatus: string; // 'unpaid', 'trialing', ... as the provider said it
  priceLookupKeys: string[];
  periodStart: Date;
  periodEnd: Date;
  cancelAtPeriodEnd: boolean;
}
```

**Stripe's statuses, mapped:**

| Stripe                         | Neutral      | Why                                                        |
| ------------------------------ | ------------ | ---------------------------------------------------------- |
| `trialing`, `active`           | `active`     | The org has what it chose                                  |
| `past_due`                     | `past_due`   | A payment failed and Stripe is still retrying              |
| `incomplete`                   | `incomplete` | The first payment has not gone through; nothing is applied |
| `canceled`, `unpaid`           | `ended`      | Stripe has stopped trying; access should stop              |
| `incomplete_expired`, `paused` | `ended`      | Never paid, or a trial ended with no card                  |

**Why it is shaped like this:**

- **`parseWebhook` returns what changed, not the new state**, because state is
  always fetched ([Webhooks](#webhooks)). That also fits Stripe's thin events,
  which carry only an object reference, and Stripe recommends them for new
  integrations. Snapshot events work unchanged.
- **The billing period is read from the subscription items**. Since API
  version `2025-03-31.basil`, `current_period_start` and `current_period_end`
  are no longer on the Stripe subscription. The spike checks this against
  `stripe-mock`.
- **`reportUsage` takes a closed period's total, once.** That is the lowest
  common denominator: Stripe has meters, while a provider without them (Paddle
  Billing, which bills usage as a one-off charge on the subscription) can still
  implement it as a single charge. A provider with meters does not need
  anything finer.
- **Checkout and portal return a URL.** Both Stripe's hosted pages and a
  merchant of record's overlay start from one, so card data never reaches the
  platform. This matters for VAT: a merchant of record (Paddle, or similar)
  sells to the org and handles UK and EU VAT itself, and only an adapter that
  fits this interface lets an app choose one. Stripe Tax, if the operator uses
  it, is a checkout setting in the Stripe adapter, not a platform concept.
- **`cancelSubscription` exists for erasure**, not for an org admin. An org
  changes or cancels its own plan in the portal.

## Webhooks

`POST /api/v1/billing/webhook/[provider]` (t-1094). It sits outside
`/api/v1/webhooks/` (keyed on API keys) and `/api/v1/inbound/` (orchestration
triggers). It has its own row in `lib/security/rate-limit-policy.ts`, keyed on
IP, and no session. Stripe publishes the IP ranges it sends from, but the
endpoint does not allow-list them: the ranges change, and the signature is the
control.

### Verify first

The route reads the body as text (`await request.text()`) and hands it, with
the headers, to `parseWebhook`. Nothing else is parsed, read or written before
the signature verifies. Stripe signs `<timestamp>.<raw body>` with HMAC-SHA256
under the endpoint secret, sends it as `Stripe-Signature: t=…,v1=…`, and the
SDK refuses a signature older than five minutes. A body that has been parsed
and re-serialised does not verify, so the raw bytes are what must reach the
adapter (spike part B).

### The rule: record the event once, apply the provider's current state

Stripe delivers each event at least once and in no guaranteed order. It
retries for up to three days in live mode. So:

1. **Find the org** from the event's customer reference, through the org's
   subscription record (a system read, since the org is not known yet). If no
   org holds that customer, fall back to the `orgId` that `createCheckout`
   writes into the metadata of the customer, the session and the subscription
   (and the session's `client_reference_id`). This covers a checkout whose
   provider customer was created but whose local write of the reference failed
   or has not committed: the org is linked to the customer here, provided it
   exists and holds no other customer reference. Only an event that names no
   org either way is answered `200`, logged, and not stored. It changes
   nothing, so a replay of it changes nothing either. It also cannot be
   written to the ledger, which is org-owned and refuses a row with no org at
   `multi`.
2. **Take a per-org lock**: a Postgres advisory transaction lock keyed on the
   org, inside a transaction run as that org (`runAsOrg`).
3. **Insert the event id into the ledger**, unique on (provider, event id). If
   it is already there, this is a replay: commit nothing and answer `200`.
4. **Fetch the subscription from the provider** (`fetchSubscription`), inside
   the lock.
5. **Apply that state**: the status, the period, and the plan its price names,
   under the lapsed-subscription rule. Applying is idempotent.
6. **Commit the ledger row and the change together**, then answer `200`. On any
   failure, roll back and answer `500`, so the provider retries.

Each step is there because the alternative fails (spike parts C to E):

| Rejected                                        | What goes wrong                                                                                                                     |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Apply each event's snapshot as it arrives       | A late `active` after a `canceled` leaves a cancelled org on its paid plan                                                          |
| Apply a snapshot only if its `created` is newer | `created` is in whole seconds. An upgrade and a cancellation in the same second drop the second one, even when delivered in order   |
| A ledger without fetching                       | Makes replays harmless, but a reordered event still writes old state                                                                |
| Fetching outside the lock                       | Two deliveries race: the one that fetched first can write last, and old state wins                                                  |
| Committing the ledger row before applying       | A crash between the two makes the retry look like a replay, so the change is lost. When it is the last event, nothing ever heals it |

**What each half buys.** Fetching the current object is what makes the state
converge: every delivery, in any order, writes whatever the provider holds
now. The ledger is what makes a side effect happen once. Applying a plan (an
audit row) and telling the owner a payment failed should not repeat on every
replay. Neither half is enough alone.

**The lock is held across one HTTP call** to the provider. That is accepted: it
serialises only one org's billing events, which are rare, and the transaction
gets a timeout well above a provider round trip. The alternative, comparing a
version on the provider's object, is not available: a Stripe subscription
carries no version.

**One subscription per org.** The org's record holds one subscription
reference. Checkout is refused while that subscription is `active` or
`past_due`, and the owner is sent to the portal instead. While it is
`incomplete` (a first payment that failed or awaits authentication), a new
checkout first cancels it at the provider, so the org never has two live
subscriptions.

An event for a subscription other than the stored one replaces the stored
reference when the org has none, or its stored one is `ended` or `incomplete`.
That is how an org that resubscribes after its subscription ended gets its new
plan. Otherwise the event is recorded in the ledger and not applied, with a
warning.

**Events Stripe should send:** `customer.subscription.created`, `.updated`,
`.deleted`, `.paused` and `.resumed`, `checkout.session.completed` and
`invoice.payment_failed`. The setup steps in t-1094's section of this page will
list them for the Stripe Dashboard.

**Ledger retention:** rows are kept at least 35 days. Stripe retries for three
days, and an event can be resent by hand for up to 30. A row purged earlier
would let a manual resend apply again. With fetch-and-apply that is harmless
to state, but not to side effects.

## Lapsed subscriptions

Decided at planning (2026-11-25):

| Subscription                       | What the org has                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| `incomplete`                       | What it had before checkout. Nothing is applied until the first payment succeeds       |
| `active`                           | The plan its price names                                                               |
| `active`, cancelling at period end | The same plan, until the period ends and Stripe sends the cancellation                 |
| `past_due`                         | The same plan, through the provider's retries                                          |
| `ended`                            | The app's fallback plan. With none, every switch the lapsed plan decided is turned off |

- **Past due keeps the plan** because Stripe is still collecting. Taking an
  area away from an org whose card was declined once would be harsher than the
  provider's own retries.
- **When retries stop is the operator's setting at Stripe**, not the platform's.
  In the Dashboard's failed-payment settings, choose to cancel the
  subscription or mark it unpaid once retries fail. If the operator leaves it
  `past_due`, the org keeps its plan indefinitely. The platform adds no deadline
  of its own. The setup section will say this.
- **With no fallback plan, only the switches are turned off.** The lapsed
  plan's meter limits and budget stay as they were. A removed limit reads as
  unlimited, and a limit of zero on seats would stop the org adding or
  inviting anyone. This was decided here, not at planning. An app should name a
  fallback plan, and config health warns when billing is on and none is named.
- **The org's data stays.** A lapsed org loses access to what its plan gave
  it, never the records it made there. Erasure is a separate request.

## Usage reporting

Meters count on demand: `count({ orgId, from, to })` answers how many there are
within a window, and nothing records usage events (`lib/tenancy/meters.ts`).
So usage is counted once per closed period and sent once (t-1097):

1. **The period is the provider's**, read from the subscription items and
   stored on the org's subscription record at each sync. It is not the meter's
   own `period`, and not the UTC month of §110's budget. When a sync sees the
   period move on, the one before it is closed. When a sync sees the
   subscription become `ended`, the current period is closed too, at the
   earlier of its end and the moment it ended. There is no next period to move
   on to, and without this the last period's usage would never be reported.
2. **Wait for it to settle.** The maintenance tick picks up a closed period a
   few minutes after its end, so rows committed just before the boundary are
   counted.
3. **Count once and keep the answer.** Each billed meter's `count` runs for
   `[periodStart, periodEnd)`, as the org and across its owners, and the
   result goes into the report row. It is never counted again. Rows erased or
   purged after the period closed must not change what was billed.
4. **Record before sending.** One `BillingUsageReport` per (org, meter, period
   start), unique. The insert happens before the send. A second instance or a
   retried tick that loses the insert reads the existing row and sends only if
   it is not marked sent.
5. **Send with the report's id as the identifier**, timestamped one second
   before the period's end, so the provider places it in that period.

**Stripe meters must use the `last` aggregation**, and the report is the
period's total. Stripe deduplicates on `identifier` only within a rolling 24
hours. A report whose send succeeded but was not marked sent, resent a day
later, is counted twice by a `sum` meter. A `last` meter takes the most recent
value in the period, so resending the same total is harmless at any age (spike
part F). The setup steps will say to create each meter with `last`.

**The grace period is the deadline.** Stripe finalises a period's invoice an
hour after the period ends by default, and the operator can extend that to 72
hours. Usage that arrives later is accepted, but it is added to neither that
invoice nor the next. So a report that misses the window is marked late and
logged, and never moved into the next period, which would bill the wrong
period. The setup steps will recommend a grace period of several hours, so a
tick that stalls briefly does not cost an invoice.

**What is reported, by overage rule** (the rule is the app's, per metered
item):

| Rule     | At the allowance                    | Reported                                |
| -------- | ----------------------------------- | --------------------------------------- |
| Warn     | The owner is told; nothing stops    | Nothing. Warn is a notice, not a charge |
| Soft cap | Usage continues                     | The excess: `max(0, used − allowance)`  |
| Hard cap | `checkMeterQuota()` refuses past it | Nothing. There is no excess to bill     |

The allowance lives on the plan, in one place. The provider's price is per unit
of excess, so the platform and the provider never have to agree on an
allowance. A purely usage-based item is a soft cap with an allowance of zero.
Only a hard cap writes the allowance as the meter's limit. Warn and soft cap
must not, or `checkMeterQuota()` would refuse what they allow.

**AI spend is a platform meter, in cents.** It counts the org's
`AiCostLog.totalCostUsd` within the period, leaving out calls on the org's own
key (`ownKey`). The vendor bills the org for those, as §110's caps already
assume. It is summed, then rounded to whole cents once, so rounding error does
not build up per call. Any markup is the app's price per cent at the provider.

**Standing meters** (seats) have no window. The report is the count when the
closing tick picks the period up, a few minutes after it ends, not the count
at the boundary itself. A seat added or removed in those minutes moves the
closed period's bill. That is accepted: catching the boundary exactly would
need a sync at that second. Billing seats as a subscription quantity, changed as members
join, is not in this feature.

**Not verified:** Stripe's documentation now recommends Metronome over Billing
Meters for new usage-based integrations, and calls Billing Meters appropriate
when already in use. Billing Meters is the only usage API in Stripe's core
billing that this adapter can use without a second vendor. If Stripe retires
it, the adapter's `reportUsage` is the one method that changes.

## Who may do what

Decided at planning:

- **An org OWNER** can start a checkout and open the customer portal.
- **An org ADMIN** can view billing, but cannot change it.
- **A MEMBER** cannot see it.
- **Platform staff** assign a plan by hand on `/admin/orgs/[id]`, with the
  refusals the entitlements route has (`mayChangeOrgCommercialSettings()`).
- **The webhook** acts as no person. Its changes are audited with the provider
  as the actor.

## Privacy

- **Billing records hold no `userId`.** The subscription record, the event
  ledger and the usage reports belong to the org. They go in the org export and
  org erasure manifests (`lib/privacy/org-sources.ts`). The audit row records
  who acted, so the per-person manifest is unchanged.
- **Card details never reach the platform.** Checkout and the portal are the
  provider's pages.
- **Erasing an org cancels its subscription at the provider first**
  (`cancelSubscription`), then deletes the local rows. Otherwise the provider
  keeps charging a card for an org that no longer exists. A subscription that
  has already ended, or that the provider no longer has, counts as cancelled,
  so a lapsed org's erasure is not stuck retrying. Any other refusal fails the
  erasure step, which is retried. It does not go on without it.
- **The provider's own records stay with the provider**: the customer, its
  invoices and payments, under the provider's retention and the tax rules on
  keeping invoices. The org export includes the provider's customer reference,
  so the org can ask the provider for them.

## The spike

`scripts/spikes/billing-webhook-convergence.ts`, kept so that t-1094 and t-1097
can re-run it. It needs no dependency beyond Node:

```bash
npx tsx scripts/spikes/billing-webhook-convergence.ts            # B–F, offline
stripe-mock &                                                    # go install github.com/stripe/stripe-mock@latest
STRIPE_MOCK_URL=http://localhost:12111 npx tsx scripts/spikes/billing-webhook-convergence.ts
```

| Part | Shows                                                                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A    | Each request the adapter will send is valid against Stripe's OpenAPI spec: price by lookup key, customer, checkout, portal, subscription with items, meter event, cancel |
| B    | Signature verification refuses a re-serialised body, the wrong secret, a stale timestamp and a header with no `v1`                                                       |
| C    | Replayed and reordered deliveries end on the provider's state with ledger + fetch, and on stale state with the two rejected rules                                        |
| D    | Two deliveries at once: fetching outside the lock ends stale, inside it ends current                                                                                     |
| E    | A crash after the ledger row commits loses the last change. Committing both together lets the retry apply it                                                             |
| F    | Two instances and a retried tick bill a period once. A late resend double-bills a `sum` meter and not a `last` one                                                       |

**What stripe-mock cannot show.** It keeps no state and sends no webhooks:
cancelling a subscription still answers `active`. So parts C to F run against a
provider modelled in the script on Stripe's documented behaviour. Part A checks
only that the requests are well formed. A real test-mode checkout,
cancellation and period-end report are the feature's check after deploy, not
any task's done-when.

## Not decided here

- **Seats as a subscription quantity** rather than a metered item.
- **Trials** beyond reading `trialing` as active: whether a plan can offer one
  is t-1093's to decide.
- **Proration and mid-period plan changes** are the provider's (Stripe prorates
  in the portal). Stripe leaves usage reported in the grace period off the
  invoice made by a mid-period price change. That is noted for t-1097, not
  designed around.
- **Invoices in the console**: the portal shows them. The billing page links to
  it rather than listing invoices.

## Related

- [`../tenancy/entitlements.md`](../tenancy/entitlements.md): switches, meters and limits, which a plan writes
- [`../architecture/multi-tenancy-design.md`](../architecture/multi-tenancy-design.md): principle 8
- [`../admin/config-health.md`](../admin/config-health.md): where missing keys and a missing fallback plan are reported
- [`../privacy/org-export.md`](../privacy/org-export.md): the org manifests the billing records join
