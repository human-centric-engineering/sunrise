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
| Plans as bundles of entitlements; the org's subscription record; staff assign | t-1093 | **Built**     |
| The provider adapter, Stripe, checkout, portal, the webhook, lapsed handling  | t-1094 | **Built**     |
| The billing page in the org-admin console                                     | t-1095 | **Built**     |
| Choosing a plan at signup                                                     | t-1096 | **Built**     |
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

### Setting up Stripe

In the Stripe Dashboard, in test mode first and then again in live mode:

1. **A product and price for each priced plan**, with the price's **lookup
   key** set to the plan's `priceLookupKey` (`pro_monthly`). Price ids differ
   between modes; the lookup key is what the platform uses, so set it on
   both.
2. **A webhook endpoint** (Developers → Webhooks → Add endpoint) at
   `https://<your app>/api/v1/billing/webhook/stripe`, sending exactly these
   events:
   - `customer.subscription.created`, `customer.subscription.updated`,
     `customer.subscription.deleted`, `customer.subscription.paused`,
     `customer.subscription.resumed`
   - `checkout.session.completed`
   - `invoice.payment_failed`

   Copy its signing secret (`whsec_…`) into `STRIPE_WEBHOOK_SECRET`. Any
   API version works: the webhook reads only each event's id, type and
   references, and fetches the subscription at the version pinned in the
   adapter.

3. **The secret key** (`sk_test_…`, or a restricted key with read and write
   on customers, Checkout sessions, the customer portal, subscriptions and
   prices, and read on customers' search) into `STRIPE_SECRET_KEY`.
4. **Failed payments** (Billing → Revenue recovery → Retries): choose to
   cancel the subscription, or mark it unpaid, once retries fail. Left as
   past due, the org keeps its plan for as long as Stripe keeps it there; the
   platform adds no deadline of its own.
5. **The customer portal** (Settings → Billing → Customer portal): allow
   changing plan between your plans' prices and cancelling, and set
   cancellations to take effect **at the end of the billing period**, so the
   last period's usage can still be reported (t-1097).
6. Set `BILLING_PROVIDER=stripe` and restart. Config health on the admin
   overview says if either key is missing, if the install is not at `multi`,
   or if the app names no fallback plan.

For local development, the Stripe CLI forwards test-mode events to your dev
server and prints a signing secret for them:
`stripe listen --forward-to localhost:3000/api/v1/billing/webhook/stripe`.

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
- **Whether a signup link may choose it** (`availableAtSignup`). Left out, yes
  for a plan with a price and no for one without: an unpriced plan is
  otherwise assigned by hand or given away, and a link must not hand it to
  anyone. The app sets `true` on the free tier its pricing page offers, or
  `false` to keep a priced plan off signup links
  ([Choosing a plan at signup](#choosing-a-plan-at-signup)).
- **The app's fallback plan**, named once for the app, not per plan: what an
  org moves to when its subscription ends ([Lapsed subscriptions](#lapsed-subscriptions)).

**Applying a plan is idempotent**: it compares and writes only what changed, so
re-applying one writes nothing. The webhook relies on this. A replay re-applies
the current state, and that must be a no-op, not a fresh audit row.

### What t-1093 built

| Need                            | Where                                                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Register plans and the fallback | `initAppBilling()` in `lib/app/billing.ts` → `registerPlan()`, `setFallbackPlan()` (`lib/billing/plans.ts`) |
| Do plans apply here?            | `billingPlansEnabled()`: `TENANCY_MODE=multi` and at least one plan. No provider needed                     |
| Write a plan to an org          | `applyPlan(orgId, plan)`, `lib/billing/apply-plan.ts`                                                       |
| Put an org on a plan by hand    | `assignPlan(orgId, key \| null)`, `lib/billing/subscriptions.ts`; `PATCH /api/v1/admin/orgs/[id]/plan`      |
| See it                          | the **Plan** section on `/admin/orgs/[id]`, shown only when plans apply                                     |
| The record                      | `OrgBillingSubscription` (`prisma/schema/platform.prisma`), one per org                                     |
| The audit row                   | `org.plan.assign`, with the plan and each slice it changed, before and after                                |
| Check it on a real database     | `npm run smoke:billing-plans`                                                                               |

- **A plan is checked against the entitlement registry as it registers.** A
  switch or meter nothing registers, a priced fallback, or two plans on one
  price throws, and the init gate rolls back every plan the app registered.
  So `setFallbackPlan()` comes after the plan it names.
- **Plans work with no provider.** `billingPlansEnabled()` needs only `multi`
  and a plan, so a plan given away or invoiced offline works on its own.
  Staff may assign a priced plan by hand too, which is how one is given away.
- **The budget is written through `updateOrgQuotas()`**, which sets only the
  caps it names. `writeOrgQuotas()` replaces every cap, which would clear a
  request-rate cap staff set by hand.
- **An assignment is one transaction under the org's locks.** The record
  and the switches, limits and caps commit together, or not at all. It takes
  `pg_advisory_xact_lock` on `billing:<orgId>` (`billingLockKey()`), so two
  assignments run one after the other, then the org row `FOR NO KEY UPDATE`,
  so a settings write from another route waits for it. Not `FOR UPDATE`:
  checkout and the webhook hold these locks while they wait on the provider,
  and `FOR UPDATE` would block every insert into a table with a foreign key to
  the org for that long. It runs at READ COMMITTED,
  so reads after those locks see the latest commit. Serializable was tried
  and rejected in review: its snapshot is taken before the lock is granted,
  so an assignment that waited could read stale state and, with nothing to
  write, report success over another's plan.
  `applyPlan()` takes the client to write on, so t-1094's webhook joins its
  own transaction the same way, under the same key. The caller forgets the
  cached AI budget after its commit (`forgetOrgCap()`).
- **Staff do not override a provider.** While the record holds a provider
  subscription that has not ended, a hand assignment is refused
  (`provider_managed`). Over an ended one, the provider and customer
  references are kept, so erasure still finds the customer.
- **Switch keys are stored sorted** (`writeOrgEntitlements()`), as a read
  returns them, so re-applying a plan whose switches staff saved in another
  order writes nothing.
- **"No plan" clears the plan and leaves the settings.** The org keeps what
  the plan gave until someone changes it. The record is deleted, unless it
  holds a provider or customer reference, which stays for erasure.
- **Not in t-1093:** metered items and overage rules (t-1097), the provider
  adapter and the lapsed-subscription rule (t-1094), and config health's
  warning for a missing fallback plan, which applies once a provider is on
  (t-1094).

**Which plan an org is on comes from the provider's subscription, not from the
checkout.** The adapter reads the subscription's price lookup keys and the
plan with that key is applied. A subscription on a price no plan names (made by
hand in the Stripe Dashboard, say) is recorded with its status. The org's plan
is left unchanged, and the webhook logs a warning naming the lookup keys.
(Config health does not warn: nothing stores which price an org is on, and
reading every org's subscription from the provider on each admin page load
was not worth it. Revisit if operators miss the log line.)

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
   * subscription, so a webhook can find the org before the reference is stored
   * (it comes back as ProviderSubscription.orgId).
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

  /**
   * Every subscription of the customer that is `live` (see ProviderSubscription).
   * The webhook calls it when the stored subscription ends; erasure calls it.
   */
  listLiveSubscriptions(customerRef: string): Promise<ProviderSubscription[]>;

  /**
   * Every customer whose metadata names the org: Stripe's customer search,
   * which can lag a new customer by about a minute. Erasure calls it, to find
   * a customer whose reference was never stored.
   */
  findCustomerRefs(orgId: string): Promise<string[]>;

  /**
   * A period's quantity for one metered item. A later report for the same
   * meter and period replaces an earlier one, so it is safe to resend.
   * `final: false` is a running total sent during the period's last days (see
   * The last period). An adapter whose provider can only add a charge per
   * report, not replace one, sends only final reports and ignores the rest.
   */
  reportUsage(input: {
    customerRef: string;
    subscriptionRef: string;
    providerMeter: string;
    quantity: number; // a whole number
    periodStart: Date;
    periodEnd: Date;
    final: boolean;
    at: Date; // when the provider places it: periodEnd − 1s if final, else now
    identifier: string; // stable across resends of one send, new for each running total
  }): Promise<void>;

  /**
   * End it now, without a refund decision, invoicing what is owed so far.
   * Called by org erasure, and by a checkout replacing an `incomplete` or
   * paused subscription. A subscription that has already ended, or that the provider
   * does not have, counts as success: the outcome the caller needs is true.
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
  endedAt: Date | null; // Stripe's `ended_at`; null while it has not ended
  live: boolean; // the provider can still charge or resume it: not `canceled` or `incomplete_expired`
  orgId: string | null; // the org id createCheckout wrote into its metadata
}
```

**Stripe's statuses, mapped:**

| Stripe               | Neutral      | Why                                                        |
| -------------------- | ------------ | ---------------------------------------------------------- |
| `trialing`, `active` | `active`     | The org has what it chose                                  |
| `past_due`           | `past_due`   | A payment failed and Stripe is still retrying              |
| `incomplete`         | `incomplete` | The first payment has not gone through; nothing is applied |
| `canceled`, `unpaid` | `ended`      | Stripe has stopped trying; access should stop              |
| `incomplete_expired` | `ended`      | Never paid                                                 |
| `paused`             | `ended`      | A trial ended with no card. It can resume, so it is `live` |

`status` is about access: `ended` means the org loses what the plan gave it.
`live` is about money: whether the provider could still charge for it. An
`unpaid` or `paused` subscription is `ended` and `live`, and erasure cancels
it.

**Why it is shaped like this:**

- **`parseWebhook` returns what changed, not the new state**, because state is
  always fetched ([Webhooks](#webhooks)). That also fits Stripe's thin events,
  which carry only an object reference, and Stripe recommends them for new
  integrations. Snapshot events work unchanged.
- **The billing period is read from the subscription items**. Since API
  version `2025-03-31.basil`, `current_period_start` and `current_period_end`
  are no longer on the Stripe subscription. The spike checks this against
  `stripe-mock`, which serves the one OpenAPI spec it was built with and
  ignores `Stripe-Version`. So the check is only as current as the build: run
  it with a `stripe-mock` released after that API version.
- **`reportUsage` takes a period's total, not individual events.** That is the
  lowest common denominator: Stripe has meters, while a provider without them
  (Paddle Billing, which bills usage as a one-off charge on the subscription)
  can still implement a final report as a single charge. Such a provider cannot
  replace a charge, so it ignores running totals, and the last period of a
  subscription cancelling at period end goes uncollected there.
- **Checkout and portal return a URL.** Both Stripe's hosted pages and a
  merchant of record's overlay start from one, so card data never reaches the
  platform. This matters for VAT: a merchant of record (Paddle, or similar)
  sells to the org and handles UK and EU VAT itself, and only an adapter that
  fits this interface lets an app choose one. Stripe Tax, if the operator uses
  it, is a checkout setting in the Stripe adapter, not a platform concept.
- **`cancelSubscription` is the platform's, not an org admin's.** Erasure calls
  it, and so does a checkout replacing an `incomplete` or paused subscription. An org
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
   (and the session's `client_reference_id`). To read it, step 1 makes its
   own `fetchSubscription`, outside any lock, and uses only `orgId` from it;
   the fetch whose state is applied is step 4's. This covers a checkout whose
   provider customer was created but whose local write of the reference failed
   or has not committed. The fallback only names the org; linking it to the
   customer happens in step 5, under the lock. An event that names no org
   either way, or names one that no longer exists (an erased org's
   cancellation arrives after its rows are gone), is answered `200`, logged,
   and not stored. It changes
   nothing, so a replay of it changes nothing either. It also cannot be
   written to the ledger, which is org-owned and refuses a row with no org at
   `multi`.
2. **Take a per-org lock**: a Postgres advisory transaction lock keyed on the
   org, inside a transaction run as that org (`runAsOrg`).
3. **Insert the event id into the ledger**, unique on (provider, event id),
   with `ON CONFLICT DO NOTHING`, and read the affected row count. A plain
   insert that hits the unique key aborts the Postgres transaction, so catching
   the error is not enough. No row inserted means a replay: commit nothing and
   answer `200`.
4. **Fetch the subscription from the provider** (`fetchSubscription`), inside
   the lock.
5. **Apply that state**: link the org to the customer if step 1 found it by
   the fallback, re-checking under the lock that the org holds no other
   customer reference. If it holds a different one, the customer is not
   linked, nothing is applied, and the ledger row commits with a warning:
   retrying would not change the answer, and erasure finds that customer by
   its metadata. Then the status, the period, and the plan its price names,
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
reference. A checkout takes the same per-org lock as the webhook and lists
every `live` subscription of the org's customer at the provider, not only the
stored one: a subscription whose webhook has not landed yet is not stored
(review round 1).

- Any `active` or `past_due`: refused, and the owner is sent to the portal.
- `incomplete` (a first payment that failed or awaits authentication), or
  ended and still `live` (`paused`, a trial ended with no card; `unpaid`):
  the checkout goes ahead and leaves it alone. **The webhook cancels it**
  when the new subscription arrives paid (`active` or `past_due`), so an
  owner who abandons the checkout page has lost nothing (review round 2). A
  new one that is itself still `incomplete` waits: it is recorded
  `unchanged` and adopted on its paid event. Stripe's portal may not offer to
  resume a paused subscription, so replacing it is the one path that always
  works.
- None live: the checkout goes ahead.
- A subscription at another provider (the install changed
  `BILLING_PROVIDER`) that has not ended, or can still charge: refused. Over
  one that has ended for good, the record's subscription fields are cleared
  with the new customer, so its old reference is not read as this
  provider's.
- A stored customer the provider no longer has (deleted in its dashboard):
  the adapter makes a new one, and checkout stores it. The portal answers
  `no_customer`.

Checkout first closes the customer's other open checkout pages
(`expireOpenCheckouts`), then lists the live subscriptions, so a page left
open in another tab is either closed or already listed. The Stripe adapter
closes them again as it makes the new one. One paid in the instant between
the expiry and the list landing at Stripe is the webhook's to record: it is refused (`not_applied`, with a warning) while the
org's stored subscription is live, and has to be refunded at Stripe.

So the org never has two live subscriptions.

An event for a subscription other than the stored one replaces the stored
reference when the fetched subscription's status is not `ended` and the org
has none, or its stored one is `ended` or `incomplete`. That is how an org
that resubscribes after its subscription ended gets its new plan. A late event
for an old subscription that has ended never replaces a live one. Otherwise
the event is recorded in the ledger and not applied, with a warning.

The two can arrive in either order. So when an applied event leaves the stored
subscription `ended`, the webhook also calls `listLiveSubscriptions` for the
customer and, if one is not `ended`, adopts it as the stored reference and
applies its state in the same transaction, preferring an `active` or
`past_due` one over an `incomplete` one. A new subscription recorded before
the old one's cancellation therefore takes effect when the cancellation
arrives, not at its next renewal. When the ended one can still charge
(`unpaid`, `paused`), only a paid subscription is adopted, and the ended one
is cancelled at the provider as it is replaced; an `incomplete` one waits for
its own paid event.

When checkout stores a new customer (another provider's, or Stripe made a new
one because it no longer had the stored one), the record's subscription
fields are cleared with it, so the old reference is not read as the new
customer's.

**Events Stripe should send:** `customer.subscription.created`, `.updated`,
`.deleted`, `.paused` and `.resumed`, `checkout.session.completed` and
`invoice.payment_failed` ([Setting up Stripe](#setting-up-stripe)). Any other
type is answered `200` and ignored.

**Ledger retention:** rows are kept at least 35 days. Nothing purges them
yet, so today they are kept until the org is erased. Stripe retries for three
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
| `ended`, never paid                | What it had: one that ends while `incomplete` gave nothing, so it takes nothing        |

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
- **The lapse happens once**, on the way into `ended` from `active` or
  `past_due`. A later delivery about the same ended subscription changes
  nothing more, and one that ends while `incomplete` (Stripe's
  `incomplete_expired`, or cancelled by a new checkout) leaves the org as it
  was, a plan staff assigned included (review round 1).
- **The org's data stays.** A lapsed org loses access to what its plan gave
  it, never the records it made there. Erasure is a separate request.

## What t-1094 built

| Need                                 | Where                                                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| The interface, an app's own provider | `BillingProvider`, `registerBillingProvider()` (`lib/billing/provider.ts`), from `initAppBilling()`       |
| Is billing on, and which provider    | `billingProviderState()`, `billingEnabled()`, `billingProvider()` (`lib/billing/config.ts`)               |
| Stripe                               | `lib/billing/providers/stripe.ts`, loaded by `import()` only when chosen; API version `2026-10-28.endive` |
| Start a checkout                     | `POST /api/v1/orgs/[id]/billing/checkout` `{ planKey }` → `{ url }` (`startCheckout()`)                   |
| Open the portal                      | `POST /api/v1/orgs/[id]/billing/portal` → `{ url }` (`openBillingPortal()`)                               |
| The webhook                          | `POST /api/v1/billing/webhook/[provider]` (`handleBillingWebhook()`, `lib/billing/webhook.ts`)            |
| The event ledger                     | `BillingWebhookEvent` (`prisma/schema/platform.prisma`), unique on (provider, event id)                   |
| Erasure cancelling first             | `cancelOrgSubscriptionsAtProvider()` (`lib/billing/erase.ts`), called by `eraseOrg()`                     |
| Config health                        | `billing_provider`, `billing_single_tenant`, `billing_fallback_plan` (`lib/config-health/checks.ts`)      |
| Check it on a real database          | `npm run smoke:billing-webhook`; with `STRIPE_MOCK_URL`, also the Stripe adapter against `stripe-mock`    |

- **Checkout and the portal sit under the org**, at
  `/api/v1/orgs/[id]/billing/`, beside the org's other routes, and are asked
  of the authorization policy as the resource kind `org.billing`. Sunrise's
  policy admits the org's OWNER and ADMIN to that kind (the ADMIN may view
  billing, t-1095); the routes then require the **OWNER, acting in the org,
  in a browser session**. An ADMIN, a MEMBER, a platform admin, a support
  session, an API key and the install org are refused. Staff put an org on a
  plan by hand instead.
- **Both answer a URL** and the browser goes there. The provider sends the
  owner back to `/admin/billing` (`?checkout=success` or `?checkout=cancelled`),
  the org-admin console's billing page ([The billing page](#the-billing-page)).
- **The webhook answers** 404 while billing is off or the URL names another
  provider, 400 on a bad signature, 200 once handled (applied, unchanged, a
  replay, an ignored type, an org that no longer exists), and 500 on anything
  else, rolled back, so the provider retries. A body over 512 KB is refused
  with 413 before it is read further.
- **Each ledger row says what was done** (`outcome`): `applied`, `unchanged`,
  `not_applied` (recorded with a warning: the org holds another customer,
  already has a live subscription, or the subscription's metadata names
  another org), or `no_subscription`.
- **Audit rows:** `org.billing.checkout` when an owner starts one, and
  `org.billing.sync`, with no user, when the webhook changed the org's plan
  or status: from and to, and what the plan wrote.
- **`providerLive`** on the record is the adapter's `live`: whether the
  provider can still charge or resume the subscription. It is what tells
  erasure, with billing off, that an `ended` one that is `unpaid` or
  `paused` still has to be cancelled.
- **A customer belongs to one org**: (`provider`, `customerRef`) is unique on
  `OrgBillingSubscription`, which is how the webhook finds the org.
- **Staff cannot assign a plan by hand over an ended subscription that is
  still `live`** (`provider_managed`): the assignment clears the reference,
  and erasure with billing off would then not see a subscription the
  provider may still collect on. Cancel it at the provider first.
- **Erasure refuses** with 409 `BILLING_NOT_CANCELLED` while billing is off
  (or on with another provider) and the org's record holds a subscription
  that has not ended, or has ended and is still `live` (unpaid, paused): there is nothing to cancel it with. Switching billing
  back on is the remedy. With an ended subscription, or none, erasure goes
  ahead and logs that it did not check the provider.
- **Not in t-1094:** telling the owner a payment failed (the event is
  recorded; nothing is sent), purging old ledger rows, and usage reports (t-1097; `reportUsage()` is implemented in the
  Stripe adapter, and nothing calls it yet).
- **Erasure closes the org's open checkout pages** at the provider before it
  cancels the subscriptions, so a page left open in a tab cannot be paid
  once the org is gone.
- **A failed erasure after a cancellation is logged as an error**: the
  provider cannot join the database transaction, so if the delete then
  fails the org still exists, without its subscription. Erasing again
  finishes it.
- **Known gap, erasure and a checkout at the same moment:** the
  cancellation runs before the erasure's transaction and outside the org's
  billing lock, so a checkout page created in that instant, or one paid in
  the instant between the list and the expiry, is not caught. Its
  webhook then names an org that no longer exists and is dropped, as with a
  customer the search has not caught up with ([Privacy](#privacy)).

## The billing page

`/admin/billing` in the org-admin console (t-1095), a shell over
`GET /api/v1/orgs/[id]/billing` (`loadOrgBilling()`,
`lib/billing/org-billing.ts`). It shows, for the org the viewer acts in:

- **The plan and its status**: active, payment overdue (with what that means:
  the provider is retrying and the plan stays), waiting for the first
  payment, or ended. "Ends on …" when it is cancelled at period end, and "Set
  by platform staff" for a plan assigned by hand.
- **The current period**, from the provider's subscription.
- **Usage against each limit**, every meter `loadOrgMeterUsage()` counts. A
  meter that could not be counted says so and never shows 0. When usage
  cannot be read at all, only that card says so: the plan, status and portal
  still show.
- **The plans it could buy**: those with a price. The OWNER gets a checkout
  button on each plan the org is not on. While a subscription is live there is
  no checkout (the route would refuse `already_subscribed`), and the page
  says to change plan in the portal. One still waiting for its first payment
  is not live, so the owner can choose again to retry it. One at a provider
  this install no longer uses has to end there first, and the page says so in
  place of both the buttons and the portal.
- **A record with only a customer** (a first checkout abandoned, or a plan
  staff removed) shows as no plan and no status: its status is the schema's
  default, not anything that happened.
- **Manage billing**, the customer portal: card, invoices, plan changes and
  cancellation, on the provider's pages. Offered once the org has a customer
  at this install's provider and a subscription to show (a checkout that was
  never paid links a customer, with nothing in its portal). The page lists no
  invoices itself.

| Who                                   | Sees                                                         |
| ------------------------------------- | ------------------------------------------------------------ |
| The org's OWNER, acting in it         | Everything, with the checkout and portal buttons             |
| The org's ADMIN                       | The same page, read-only, saying only an owner can change it |
| A platform admin, in a customer's org | Read-only, as an ADMIN                                       |
| An org MEMBER                         | Nothing: the admin console turns them away                   |

- **Only while billing is on.** With `billingEnabled()` false, the page answers
  404, its sidebar item is hidden (`sectionsForCapabilities()`, as for the
  waitlist), and the access explainer leaves it out. The route answers
  `billing_off`.
- **In the install org** it says the install org is never billed and fetches
  nothing.
- **Coming back from checkout** (`?checkout=success`) it says the payment went
  through and the plan follows once the provider confirms it. The plan comes
  from the webhook, so it may lag by a few seconds. `?checkout=cancelled` says
  nothing was charged.
- **The default upgrade link.** A switch the app gave no `upgradeUrl`
  ([entitlements](../tenancy/entitlements.md#hidden-or-locked)) links to this
  page while billing is on (`upgradeUrlFor()`, `lib/billing/upgrade-url.ts`).
  That is on the 403's `details.upgradeUrl` and on a locked item and page,
  for a viewer the policy admits to the org tier (the org's OWNER and ADMIN
  by default), the page's own tier. The 403 and the locked items ask that one
  question. A named-tier holder gets no link, since the page is not theirs,
  and nor does anyone in the install org, which is never billed. The app's
  own link always wins.
- **The words** are the platform catalogue's, `admin.billing`, so a fork
  rewords them with `overridePlatformMessages()`. Plan and meter labels are the
  app's, as it registered them.

## Choosing a plan at signup

Someone who clicks "Buy Pro" on a pricing page should not have to find the
billing page and choose again after signing up (t-1096). A pricing page links
to signup with the plan's key, and the plan is carried to the new org:

```
/signup?plan=pro
```

| Step                    | What happens                                                                                                                                                                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The signup page         | `signupPlanOffer()` checks the key. A registered plan, while billing is on, is named on the page ("You are signing up for the Pro plan…"); anything else shows nothing and is not sent                                                                                                                             |
| The signup request      | The email form sends `signupPlan` in the sign-up body; the Google button sends it in the OAuth state (`additionalData`). Neither is a user field                                                                                                                                                                   |
| The user-create hook    | `userCreateBeforeHook` reads it (`carriedSignupPlan()`) and hands it to `signupOrgMemberships()`, which checks it again (`signupPlanOf()`) and records it on the new org, in the same INSERT: `Org.settings.signupPlan` (`ORG_SIGNUP_PLAN_KEY`)                                                                    |
| A free plan: the setup  | Applied once the org's setup is finished (below): by `completeSignupOrg()` as it ends, and otherwise by the `signupPlans` maintenance task                                                                                                                                                                         |
| A paid plan: next step  | The signup goes on to `/admin/billing?signup=plan` once the person is signed in, instead of the landing route: the email form, the Google button's `callbackURL`, and the verification link (`/verify-email/callback?next=…`). The page asks `POST /api/v1/orgs/[id]/billing/signup-plan` and follows the checkout |
| A paid plan: still open | Until a subscription starts or the owner declines it, the billing page offers it: "Subscribe to Pro" (the same `POST`) or "Choose a different plan" (`DELETE`, which removes it)                                                                                                                                   |

**Why on the org, not a cookie or the session.** The plan has to survive email
verification, which may be on another device a day later, and an OAuth round
trip. The org exists from the moment the user row does, so it is the one place
every later step can read. A plan key is not personal data, so nothing new
goes into the per-person export or erasure.

**Nothing changes unless all of these hold:** billing is on (`billingEnabled()`),
the key names a registered plan the app offers at signup (`availableAtSignup`),
and the signup gets an org of its own (`asksSignupOrg()`, and the resolver
answers `own`). So:

- **An unknown plan, or one not offered at signup,** is dropped, logged at
  `info`, and the signup lands as it does today. It is never trusted: the hook
  checks the key whatever the page or the request body said, and every later
  step checks it again, so a plan the app stops offering is dropped rather
  than applied. An unpriced plan is not offered unless the app says so, so
  `/signup?plan=enterprise` cannot give away a plan staff assign by hand.
- **An invited signup** ignores it: it joins the inviting org, which is
  already on a plan. So does one an app's resolver sends to an existing org
  (`join`) or the install org, and platform staff. The Google button does not
  even send it alongside an invitation.
- **Billing off** at signup records nothing. Switched off after the signup, or
  while the app's plans failed to register (`billingPlansFailed()`), the plan
  stays waiting and nothing takes it up, since a valid choice would look
  retired.
- **Checking the plan can never move the signup.** A throw there is logged and
  the plan dropped; the person still gets their own org.

### A free plan is part of the org's setup

A free plan needs nothing from the person, so it is applied as provisioning,
not as a step they take. It goes on once the setup is **finished**: the
founder has joined (`awaitingFounder` is gone) and no org-created hook this
process runs is still owed. Applied any earlier, a hook that runs later (a
retry, or the run of an instance that held the lease) could write a default
plan over it.

- **When.** `completeSignupOrg()` applies it as the setup ends. If a hook
  failed, or another runner held the hooks, it waits; the `signupPlans`
  maintenance task (every 15 minutes, system scope) applies it once the hooks
  have run. That task selects only the orgs waiting on a free plan offered at
  signup, not awaiting their founder and owing no hook this process runs, in a
  random order, so an org waiting on a hook is not re-read every tick and none
  it cannot finish holds up the rest.
- **However long it takes.** A hook that keeps failing holds the plan back for
  as long as it fails: applying it anyway would let that hook's next run write
  its default over the founder's choice. Said once at `warn` when it starts to
  wait (`the free plan chosen at signup waits on org-created hooks still
owed`), beside the hook's own `error` on every failed run.
- **What holds it back.** A registered hook still owed, and an owed record this
  version cannot read (a newer version wrote it, and runs its hooks). A key no
  process registers any more does not: it stays owed by design, but nothing
  will ever run it.
- **How.** Removed first by a serializable read-modify-write
  (`takeOrgSignupPlan()`), so of two callers only one applies it, then applied
  with `assignPlan()`. An assignment that fails changed nothing, so the plan is
  put back (`restoreOrgSignupPlan()`, which never replaces a plan already
  waiting) for the next run. If the provider manages the org's plan (the owner
  subscribed meanwhile), it is dropped.

### A paid plan is the next step of the signup

Checkout needs the person, so for a paid plan it is the signup's own next step,
as a pricing-page "Buy" flow normally is: once they are signed in, the signup
goes on to the page that starts the checkout, server-side, for that plan.

- **Every way a signup ends goes on to it.** The email form when it signs the
  person in, the Google button's callback, and the verification link. The link's
  continuation is decided on the server when the email is sent
  (`signupContinuationForUser()`, from the founder's org), so a resent link
  keeps it and it works on whichever device the link is opened. The callback
  page follows `next` only when it is exactly that page (`signupNextOf()`), so
  the link is not an open redirect.
- **The page decides, on the server.** Sent there with nothing for this viewer
  to start (an existing account signing in from a pricing link, a plan the
  server dropped, an ADMIN), the page sends them on to the landing route, as
  the signup would have gone. A plain MEMBER never reaches it: the admin
  layout sends them to the landing route first.
- **While the org still awaits its founder,** a paid plan's checkout starts
  anyway: the mark is released after the response that sent the founder
  there, and the owner's own session proves they can act, as a sign-in does.
  Only the free plan waits for the setup.
- **Nothing intercepts later visits.** There is no redirect from the landing
  route: a redirect there would be cached by the client router's prefetch and
  replayed after the plan was settled.
- **It stays waiting until it is settled.** Starting the checkout does not
  remove it. A subscription that gives access removes it, in the webhook's own
  transaction, whichever plan it is on; so does the owner choosing a different
  plan (`DELETE`, audited as `org.billing.signup_plan.dismiss`). A
  subscription not paid yet (`incomplete`) leaves it waiting, to be offered
  again if that subscription ends unpaid. Meanwhile the billing read answers it
  (`signupPlan`, never while the org has a provider subscription) and the page
  offers it, except straight back from a successful checkout, when the webhook
  that settles it may not have landed. So an owner who leaves the checkout
  page, or whose checkout failed, finds it there, and nothing is started that
  they did not ask for.
- **Back from the provider's page** comes to the billing page, which offers it,
  not to the take-up, which would start another checkout: the take-up replaces
  its own history entry before it leaves, and a page Back restores from the
  back-forward cache is loaded afresh.

**Only the OWNER** may take it up or decline it, and the route refuses anyone
else, as the checkout route does (`assertMayChangeBilling()`); the page offers
it to the owner only.

**Audit.** A free plan applied is `org.plan.assign` with
`metadata.source: 'signup'`, the founder as the actor (none when the
maintenance task applies it). A checkout started is `org.billing.checkout` with
`source: 'signup'`; a plan declined is `org.billing.signup_plan.dismiss`.

**The billing page no longer says a free plan was "set by platform staff".**
`assignedByHand` is now true only for a priced plan staff set by hand: a
plan with no price may be the one the founder chose at signup, and has
nothing to pay for anyway.

**Not built:** carrying a plan through an invitation, a price or a trial chosen
on the link (the plan's own price is used), and a plan on the login page for a
person who already has an account (a signed-in visitor is sent from `/signup`
to the landing route, as before).

## Usage reporting

Meters count on demand: `count({ orgId, from, to })` answers how many there are
within a window, and nothing records usage events (`lib/tenancy/meters.ts`).
So usage is counted once per closed period and sent once (t-1097):

1. **The period is the provider's**, read from the subscription items and
   stored on the org's subscription record at each sync. It is not the meter's
   own `period`, and not the UTC month of §110's budget. When a sync sees the
   period move on, the one before it is closed. A subscription's last period
   has no next one, so it is handled apart: see
   [The last period](#the-last-period).
2. **Wait for it to settle.** The maintenance tick picks up a closed period a
   few minutes after its end, so rows committed just before the boundary are
   counted.
3. **Count once and keep the answer.** Each billed meter's `count` runs for
   `[periodStart, periodEnd)`, as the org and across its owners, and the
   result goes into the report row. A closed period is never counted again.
   (Running totals in a last period count an open one; they are not this
   row.) Rows erased or
   purged after the period closed must not change what was billed.
4. **Record before sending.** One `BillingUsageReport` per (org, meter, period
   start), unique. The insert happens before the send. A second instance or a
   retried tick that loses the insert reads the existing row and sends only if
   it is not marked sent.
5. **Send with the report's id as the identifier**, `final: true`,
   timestamped one second before the period's end, so the provider places it
   in that period.

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
need a sync at that second. Billing seats as a subscription quantity, changed
as members join, is not in this feature.

**Not verified:** Stripe's documentation now recommends Metronome over Billing
Meters for new usage-based integrations, and calls Billing Meters appropriate
when already in use. Billing Meters is the only usage API in Stripe's core
billing that this adapter can use without a second vendor. If Stripe retires
it, the adapter's `reportUsage` is the one method that changes.

### The last period

Stripe makes a subscription's final invoice when it ends, so usage reported
after that lands on no invoice. A report sent by the closing tick, minutes
after the end, is always too late. So:

- **Cancelling at period end** (the portal's default): while
  `cancelAtPeriodEnd` is set, each maintenance tick reports the period's
  running total with `final: false`, timestamped at the send (Stripe refuses a
  meter event timestamped more than a few minutes ahead). Each send has its
  own identifier: the report row's id and a send count kept on that row,
  since Stripe drops a repeated identifier within 24 hours. A `last` meter
  bills the latest one, so only usage in the minutes after the last tick
  before the end goes unbilled. The final count at close is still recorded,
  and marked late.
- **Cancelled by the platform** (erasure, or replacing an `incomplete`
  subscription): the open period's total is reported first (`final: true`,
  timestamped now), then the subscription is cancelled with its usage
  invoiced (Stripe's `invoice_now`).
- **Ended by the provider at once** (an immediate cancellation in the portal,
  or retries exhausted): the last period's excess is not collected. It is
  closed at `endedAt`, or at the period's end when `endedAt` is null (an
  `unpaid` subscription has not ended at Stripe), and recorded as late, so the
  loss is visible. The setup
  steps will recommend configuring the portal to cancel at period end.

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
- **Erasing an org cancels its subscriptions at the provider first**, then
  deletes the local rows. Otherwise the provider keeps charging a card for an
  org that no longer exists. It finds every customer of the org: the stored
  reference, and any whose metadata names the org (`findCustomerRefs`), which
  covers a customer whose reference was never stored. Then it cancels every
  `live` subscription of each (`listLiveSubscriptions`, then
  `cancelSubscription`), not only the stored one. So one that was recorded but
  not applied, and an `unpaid` or `paused` one, are ended too. A subscription
  that has already ended, or that the provider no longer has, counts as
  cancelled, and so does a customer deleted at the provider, so a lapsed
  org's erasure is not stuck retrying. Any other
  refusal fails the erasure step, which is retried. It does not go on without
  it. A checkout started a minute before erasure may not be in the search yet;
  its webhook then names an org that no longer exists and is dropped, so that
  subscription has to be cancelled by hand at the provider. Erasure logs the
  customer search's result so the gap can be checked.
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

| Part | Shows                                                                                                                                                                                                                                         |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | Each request the adapter will send is valid against Stripe's OpenAPI spec: price by lookup key, customer, customer search, checkout, portal, subscription with items, live subscriptions by customer, meter event, cancel with usage invoiced |
| B    | Signature verification refuses a re-serialised body, the wrong secret, a stale timestamp and a header with no `v1`                                                                                                                            |
| C    | Replayed and reordered deliveries end on the provider's state with ledger + fetch, and on stale state with the two rejected rules                                                                                                             |
| D    | Two deliveries at once: fetching outside the lock ends stale, inside it ends current                                                                                                                                                          |
| E    | A crash after the ledger row commits loses the last change. Committing both together lets the retry apply it                                                                                                                                  |
| F    | Two instances and a retried tick bill a period once. A late resend double-bills a `sum` meter and not a `last` one                                                                                                                            |

**What stripe-mock cannot show.** It keeps no state and sends no webhooks:
cancelling a subscription still answers `active`. So parts C to F run against a
provider modelled in the script on Stripe's documented behaviour. Part A checks
only that the requests are well formed. A real test-mode checkout,
cancellation and period-end report are the feature's check after deploy, not
any task's done-when.

## Not decided here

- **Seats as a subscription quantity** rather than a metered item.
- **Trials** beyond reading `trialing` as active. t-1093 gave a plan no trial
  field: a trial is a setting on the provider's price or checkout, and the
  platform reads the result as `active`. A plan that needs one is a later
  change.
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
