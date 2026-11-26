# Entitlements: what an org has

An app that sells parts of itself has to record what each org has bought.
Before §135, Sunrise could cap and measure an org (§110's budget and usage)
but had nowhere to say what it had bought, so an app kept that in a key of its
own in `Org.settings`, under names it guessed, and billing would later rename
them.

An **entitlement switch** is that record. The app registers its switches once,
in code. Platform staff set them on each org. The app reads them wherever it
needs to know. When billing arrives it becomes a second writer of the same
slice, and nothing that reads a switch changes.

This page covers switches (t-1033), requiring one on a page, route or menu
item (t-1034) and how a surface looks to an org without it (t-1053), and
**meters**: counting what an org has and limiting it
(t-1035, [Meters and limits](#meters-and-limits)).

## Quick Reference

| Need                               | Where                                                                                                                                         |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Register your switches             | `initAppEntitlements()` in `lib/app/entitlements.ts` → `registerEntitlementSwitch()`                                                          |
| Does this org have a switch?       | `orgHasSwitch(orgId, key)`, `lib/tenancy/entitlements.ts`                                                                                     |
| Every switch an org has            | `loadOrgSwitches(orgId)` → `{ nothingSet, unreadable, on, atDefault, unregistered }`                                                          |
| Resolve a row you already hold     | `resolveOrgSwitches(readOrgEntitlements(org.settings))`                                                                                       |
| What is stored                     | `Org.settings.entitlements` = `{ on: string[], off: string[] }`, `lib/tenancy/org-settings.ts`                                                |
| Set switches from your own code    | `setOrgSwitches(orgId, { on, off })`, or `null` for every switch back to its default                                                          |
| Who may write it                   | `mayChangeOrgCommercialSettings()`, `lib/tenancy/shared-settings.ts`, after an admin check                                                    |
| Read / set over HTTP               | `GET` / `PATCH` / `DELETE /api/v1/admin/orgs/[id]/entitlements` (platform admins; set from the install org)                                   |
| Set it by hand                     | the **Entitlements** section on `/admin/orgs/[id]`, shown when any switch is registered                                                       |
| Did the app's registration fail?   | `entitlementSwitchesFailed()`; the org page says so                                                                                           |
| The audit row                      | `org.entitlements.update`, with what it replaced                                                                                              |
| Require one on a surface           | `requires` beside `tier`: page, `withAdminAuth`, nav item; see [Requiring a switch](#requiring-a-switch)                                      |
| Let an org's admins set one        | `setBy: 'org'` on the switch; `/admin/org-options`, `PATCH /api/v1/orgs/[id]/entitlements`; see [Switches an org sets](#switches-an-org-sets) |
| Show it locked, say your own words | `whenLacking: 'lock'`, `refusalMessage`, `upgradeUrl` on the switch; see [Hidden or locked](#hidden-or-locked)                                |
| Key format                         | `ENTITLEMENT_KEY_PATTERN` in `lib/validations/tenancy.ts`: `lead_gen`, not `Lead-Gen`                                                         |
| Register a meter                   | `registerMeter({ key, label, period, count })` in the same `initAppEntitlements()`                                                            |
| May this org add one more?         | `checkMeterQuota(orgId, key)`, `lib/tenancy/meters.ts` → `{ allowed, used, limit, label, window }`                                            |
| Set limits from your own code      | `writeOrgMeterLimits(orgId, { key: n \| null })`, `lib/tenancy/org-settings.ts`                                                               |
| Read / set limits over HTTP        | `GET` / `PATCH /api/v1/admin/orgs/[id]/meters`; the **Limits** section on `/admin/orgs/[id]`                                                  |

### Anti-patterns

- **Collapsing "not set" into "set off".** They are different answers, per
  switch. A switch nobody has set on an org gets its `whenNothingSet`; one in
  `off` gets nothing. Code that treats a key missing from `on` as off takes
  every default-on switch away from every org that never set it, including
  orgs saved before the switch was registered.
- **Naming only the switches that are on.** `setOrgSwitches()` leaves a
  switch it is not given as it is, so a writer of its own (billing) that
  names only `on` leaves a default-on switch the plan leaves out on. Name
  every switch the plan decides, on or off.
- **Writing the slice yourself.** `writeOrgEntitlements()` is internal and
  replaces the whole slice: a writer that builds it from what it knows drops
  values stored for keys it did not know about (a newer build's switch, a
  retired one), and skips the unreadable-slice rule below. Call
  `setOrgSwitches()`, which keeps them.
- **Keeping your own copy.** A `packages` key of your own beside this one is
  two answers to one question, and billing will only ever write this one.
- **Letting an org set what it bought.** A switch is what an org bought
  unless the app registers it `setBy: 'org'`
  ([Switches an org sets](#switches-an-org-sets)). The platform write route
  is platform-only and, at `multi`, install-org only. A fork writing
  platform-set switches from a surface of its own owns the same two refusals:
  a platform-admin guard, and `mayChangeOrgCommercialSettings()` from
  `lib/tenancy/shared-settings.ts` (`setOrgSwitches` decides nothing about
  who may).
- **Marking a bought switch `setBy: 'org'`** to save building a billing
  writer. Every org admin can then give their org that area for nothing.
  `'org'` is for what is not sold: a beta opt-in, a free add-on, a feature an
  org may turn off for its own users.
- **Renaming a key orgs already hold.** The key is what is stored. Register a
  new key and leave the old one unregistered: it reads as off, and a save from
  the admin keeps it.
- **Reusing a retired key for something new.** Orgs still hold the old one,
  kept by every save, so registering it again hands the new area to every org
  that had the old one. Retire a key for good and pick a new one.
- **Giving a value to a switch.** A switch is on or off. A plan is a set of
  switches, so the check for a switch never changes when the plans do.

## Registering switches

```ts
// lib/app/entitlements.ts: yours to edit (ships empty)
import { registerEntitlementSwitch } from '@/lib/tenancy/entitlements';

export function initAppEntitlements(): void {
  registerEntitlementSwitch({
    key: 'authoring',
    label: 'Authoring',
    description: 'Build and launch questionnaires.',
  });
  registerEntitlementSwitch({
    key: 'lead_gen',
    label: 'Lead generation',
    description: 'Funnels, leads and lead briefs.',
    whenNothingSet: true, // every client org already has this today
  });
}
```

The registry runs this once, lazily, before its first read, through the shared
init gate (`lib/fork-init.ts`). Registration is synchronous. A key that is not
a key, a missing or empty label, a `whenNothingSet` that is not `true` or
`false` (the string `"false"` would read as on), or a 101st switch throws (a
missing description reads as none); any throw rolls back every switch the init
registered and logs why, so every org reads as having none of yours. That is
deliberate: half an app's switches would give some orgs part of what they
bought, which is harder to notice than none.

### Choosing `whenNothingSet`

Leave it off (the default) for an area that is **new**: it opens only where
someone switches it on, so it fails closed. Turn it on for an area **every org
already uses**, so no org that exists today loses it when you start checking
the switch. That holds for an org whose other switches were saved before this
one existed: a save sets only the switches it names, and the admin form names
only those the admin changed. Once someone sets this switch on an org, its
default no longer applies there.

**Changing a default later** reaches every org that has not set the switch.
To keep some orgs as they are (pin the paying ones on before a default-on
switch goes off by default, say), set the switch on each of them first: with
**Set it here** on the org page, or `setOrgSwitches()` from code.

## Reading switches

`orgHasSwitch(orgId, key)` is `false` for an org that does not exist and for a
key no app registers, so a typo fails closed. `loadOrgSwitches(orgId)` returns
the whole answer:

- `nothingSet`: no registered switch has been set on the org, so `on` is the
  default-on switches.
- `unreadable`: the stored slice could not be read; see below.
- `on`: the registered switches the org has, in registration order.
- `atDefault`: the registered switches nobody has set on the org, which
  follow their `whenNothingSet`.
- `unregistered`: keys stored on that no app registers. Off, and kept by a
  save (as is any such key stored off).

A page reading many orgs at once should not call `loadOrgSwitches` per row.
Select `settings` in the one list query and resolve each row with
`resolveOrgSwitches(readOrgEntitlements(row.settings))`.

Nothing is cached: each read is one indexed `findUnique` on `Org`, a system
model, so it needs no tenant scope. Code checking several switches for one org
in a request reads `loadOrgSwitches` once rather than calling `orgHasSwitch`
per key.

## Requiring a switch

A page, route or menu item of the org's (or a named tier) can need a switch,
so an org that has not bought an area is refused it and not shown it:

```ts
// lib/app/admin-tier.ts
registerOrgTierAdminPage('/admin/questionnaires', { requires: 'authoring' });

// app/api/v1/app/questionnaires/route.ts
export const POST = withAdminAuth(handler, {
  tier: 'org',
  requires: 'authoring',
  ownership: { decidedBy: 'policy' },
});

// lib/app/admin-nav.ts
{ href: '/admin/questionnaires', tier: 'org', requires: 'authoring', … }
```

The guard and the admin layout hand the key to the authorization policy as
`scope.requires`, and the default policy refuses an org admin or tier holder
whose org lacks it. A platform admin is not limited by switches. The sidebar
hides the item, the layout and the in-app gate refuse the page, and the route
answers 403 naming the switch by its label, with `details.reason:
'entitlement_required'` (`SWITCH_REQUIRED_REASON`). If the org's switches
could not be read it still refuses, with `details.reason:
'entitlement_unverified'` (`SWITCH_UNVERIFIED_REASON`) and a message saying it
could not check, since saying the org lacks the switch might not be true.
`orgSwitchState()` is the read that tells the two apart. One switch per surface.
How the three places stay in step, and what the roster test checks, is in
[`../auth/authorization.md`](../auth/authorization.md#admin-tiers).

Use the same key on the page, its routes and its item. The item and the page
are what the reader sees; the routes are the boundary.

### Hidden or locked

By default a surface whose switch the org lacks is hidden: the item is not in
the sidebar, the page sends the viewer to their landing, and a route's 403
says the sentence above. An app that would rather show what an org could have
says so on the switch (t-1053):

```ts
registerEntitlementSwitch({
  key: 'lead_gen',
  label: 'Lead generation',
  description: 'Funnels, leads and lead briefs.',
  whenLacking: 'lock', // show it locked rather than hide it
  refusalMessage: 'Lead generation comes with the Growth plan.',
  upgradeUrl: '/pricing', // or https://…
});
```

- **`whenLacking: 'lock'`**: the item is shown with a lock. Choosing it opens
  the message and a **How to get Lead generation** link, not the page. The
  page shows **Lead generation is not available** with the same message and
  link in place of its content. Nothing opens: the page's content is not shown
  and its routes refuse, as before. The lock is the reader's, like
  `AdminTierGate` on in-app navigation, not the security boundary: the page
  still renders on the server, so it must read its rows through its routes
  (`serverFetch`), as every admin page does, never straight from the database.
- **`refusalMessage`**: replaces the platform's sentence on the 403, the
  locked item and the locked page. At most 300 characters
  (`MAX_SWITCH_REFUSAL_MESSAGE`).
- **`upgradeUrl`**: a path on this site starting `/`, or an `https://`
  address. The 403 carries it as `details.upgradeUrl`
  (`switchUpgradeUrl(key)` reads it), and the locked item and page link to it.

Each is optional and works without the others: a switch that hides can still
give a refusal message and an upgrade link on its 403. A value that is not one
of these (a `whenLacking` of `'show'`, a `javascript:` or `//` link, an empty
message) throws at registration, which rolls back the init like any other.

A surface is locked only when the viewer's tier admits them and their org's
switches were read and the switch is off. One the viewer's tier does not admit
is hidden as before, and so is one whose org's switches could not be read: the
route says it could not check, and nobody is told to buy what their org may
have. A policy that also refuses that tier-and-switch for a reason of its own
(a role, say) cannot be told apart from the missing switch, so the surface is
shown locked while the org lacks it; once the org has it, the policy's own
refusal applies. A platform admin sees every surface unlocked.

## Switches an org sets

Most switches are bought, so platform staff set them. A switch that is not
bought can be left to the org (t-1054):

```ts
registerEntitlementSwitch({
  key: 'beta_editor',
  label: 'New editor (beta)',
  description: 'Try the new editor before it is the default.',
  setBy: 'org', // the org's own admins may set it; the default is 'platform'
});
```

- **Who.** By default the org's OWNER and ADMIN, for the org they are acting
  in. The route asks the authorization policy about the resource
  `{ kind: 'org.switches', id: orgId, orgId }` (`ORG_SWITCHES_RESOURCE_KIND`),
  so a fork's policy can narrow it, to OWNERs say, or to a named tier. It
  also needs a browser session and the caller acting in that org. A support
  session can read them but not change them.
- **Where.** `/admin/org-options` (**Options** in the sidebar, shown only when
  the app registers at least one `'org'` switch) over
  `GET` / `PATCH /api/v1/orgs/[id]/entitlements`. The page lists only the
  `'org'` switches. `PATCH` takes `{ on, off }` like the platform route and
  sets only what it names.
- **What it refuses.** A switch registered without `setBy` (or `'platform'`)
  is a 403 with `details: { reason: 'switch_set_by_platform', switches }`, and
  nothing is written: this route never sets what an org buys. An unregistered
  key is a 400. With no `'org'` switch registered a write is a 409. Over a
  stored slice that could not be read it is a 409 with `details.reason:
'switches_unreadable'`, writing nothing (`setOrgSwitches(…, { refuseUnreadable:
true })`): the platform's write would store every switch it does not name as
  off, which from here would close what the org bought.
- **The record.** A write that changes something is audited as
  `org.entitlements.update`, as the platform's are, with `metadata.setBy:
'org'` and what it named.

Platform staff still set an `'org'` switch from `/admin/orgs/[id]` as any
other (marked **organisation can change** there), and their write and the
org's are the same slice, so the later one wins on the switch both name.

## What is stored, and how it fails

The slice is `Org.settings.entitlements = { on: [...], off: [...] }`, beside
`quotas` (§110), `providers` (§120) and `privacy` (§127). A key in neither
list has not been set on the org. Each list is kept sorted and without
duplicates, and no key is in both. Every other key in `settings`, a fork's
included, is preserved by every write.

Both lists, rather than the keys that are on: with only `on`, a switch
registered after an org was saved would read as off there, so turning on a
check for an area every org uses would take it from every org anyone had
saved.

**The read fails closed**, like the provider policy. A slice that cannot be
read at all gives the org no switch, its defaults included, because the slice
may have set them off. A single entry that is not a key is dropped with a
warning and the rest are kept, and a key in both lists reads as off: either
can only narrow what the org has. A slice whose `on` or `off` is not a list is
unreadable too, but what parses in the other is still read, so a save keeps
those keys rather than dropping what nobody was shown. The admin page says
when a slice was unreadable, and a save from it names every switch shown,
ticked or not, so one save replaces it, with none on if none is ticked.

**The write.** `setOrgSwitches(orgId, { on, off })` sets the named switches
and leaves every other stored value as it is; `setOrgSwitches(orgId, null)`
puts every registered switch back to its default, keeping values stored for
keys nothing registers. Over a slice that could not be read, nothing comes
back on that the change does not set on: every key the slice held is kept but
off, and so is every registered switch the change does not name, so a partial
write cannot open what the unreadable slice may have set off. A change naming
nothing writes nothing. While the app's registration has failed it throws,
since there is then no telling which switches exist. It runs through
`writeOrgEntitlements`, a serializable read-modify-write of the one key whose
updater is handed what is stored inside the transaction, so nothing that
landed in between is lost. A write that would store exactly what is stored
writes nothing and reports `changed: false`. A clash throws Prisma's `P2034`
(`isSettingsWriteConflict`); the route answers 409. An empty slice is removed.

## The admin surface

`/admin/orgs/[id]` asks `GET …/entitlements` with its other reads and shows an
**Entitlements** section only when the answer lists at least one switch, so
vanilla Sunrise shows nothing new. The page learns that from the API rather
than reading the registry itself (API-first). A load that fails says so in the
section's place, since the page cannot tell whether there were switches to
show, and so does an app registration that failed (`registrationFailed`),
which leaves every org with none of the app's switches and would otherwise
look like an install that has none. The section ticks what the org has, marks the default-on switches, says
when nothing has been set and which switch is still at its default, and
offers **Clear to defaults**, behind a confirmation, once something has. The
switches are locked while a save runs. Where the caller cannot change them
(`mayChange: false`), it shows them without the form's buttons, under the
shared read-only notice (`SharedSettingsReadOnlyNotice` with its own
`reason`), which offers the switch to the install organisation or says why
there is none.

`PATCH /api/v1/admin/orgs/[id]/entitlements` takes `{ on: string[], off:
string[] }`, both required: the registered switches to set on and off. A
switch named in neither is left as it is, so a form loaded before a switch
was registered, or a script that knows only some of them, cannot turn one off
by leaving it out. The form names only the switches the admin changed, or set
as they are with **Set it here**, so a switch left at its default stays there
and follows the default if the app later changes it; Save is off until there
is something to save. `DELETE` puts every
registered switch back to its default. An unregistered key, or one in both
lists, is a 400. With nothing registered there is nothing to set, and a write
is a 409. Values stored for keys nothing registers are kept by both, on or
off: the caller could neither see nor set them, and a process running older
code during a deploy must not drop a switch newer code registered. A write
from a caller who may not make it is refused before its body is read. A
write that changes nothing writes no audit row. Two saves of the same org at
the same moment are not detected: the later one wins on each switch both
name, as on the other org settings forms. A clear handled by a process
running older code during a deploy puts back only the switches that build
registers.

Every method is platform-only (no `tier`): at `multi`, an org's own OWNER or
ADMIN is refused. The writes are also install-org only, as the caps are
(`mayChangeOrgCommercialSettings`): the guard admits a platform admin switched
into a customer's org, and from there a write would let whoever administers
that org grant it switches. Such an admin can still read them; a save answers
403 with `details.reason: shared_settings_install_org_only` and a message
saying to switch to the install organisation. An unbound admin API key acts as
the install org and may write.

## Meters and limits

§110 could cap an org's AI spend and nothing else. A **meter** counts
something an org has, and an org's **limit** for it is the most it may have.
The platform owns the mechanism; the app owns every interpretation:

- **What counts** is the app's `count({ orgId, from, to })`.
- **Over which window** is the app's `period`: `'month'` (the UTC calendar
  month, as the AI budget is), `'standing'` (how many there are now: seats,
  questionnaires), or a function `({ orgId, now }) => ({ from, to })` for a
  window of its own, such as a billing cycle anchored on the org's
  subscription date. `from` is inclusive, `to` exclusive.
- **The limit** is per org, set by platform staff or the app's own billing
  code.
- **What a refusal does** is the app's call. `checkMeterQuota()` answers and
  changes nothing.

```ts
// lib/app/entitlements.ts
export function initAppEntitlements(): void {
  registerMeter({
    key: 'completed_conversations',
    label: 'Completed conversations',
    description: 'Conversations finished this month.',
    period: 'month',
    count: ({ orgId, from, to }) =>
      prisma.conversation.count({
        where: { orgId, completedAt: { gte: from ?? undefined, lt: to ?? undefined } },
      }),
  });
}

// where the app adds one
const check = await checkMeterQuota(orgId, 'completed_conversations');
if (!check.allowed) {
  throw new APIError(meterLimitMessage(check), ErrorCodes.FORBIDDEN, 403, {
    reason: METER_LIMIT_REASON,
  });
}
```

`checkMeterQuota(orgId, key, { adding, now })` asks whether the org may add
`adding` more (default 1) without passing its limit; `adding: 0` asks whether
it is within it now. Zero is a valid limit and refuses the first one. The
check and the add are not one transaction, so two adds at the same moment can
both pass at the last free place; a hard limit that must never be passed by
one needs the app's own lock.

A meter's `count` and `period` run **as the org being counted**
(`runAsOrg`) and **across its owners** (`runAcrossOwners`), whoever asks.
Platform staff reading the admin page are in their own org, and a member's
request is narrowed to that member's own rows, so without both the count above
would read another org's conversations through the wrong org, or count only
the asker's. A meter is an org-wide total that returns a number.

### Seats

Seats are the platform's own meter, because the platform owns the ways a
person joins an org: members who are not platform staff, plus unexpired
invitations into it. An invitation that grants the platform `ADMIN` role makes
staff, so it takes no seat, and nor does one whose metadata cannot be read
(`invitationTakesSeat()`). Nor does one for an address that is already a
member of the org, or already platform staff: each person is counted once.
An invitation takes a seat as soon as it is pending, so accepting one is not
checked again, even if the limit was lowered since.

With a seats limit set, an org's own admin is refused at the limit: a 403 with
`details.reason: 'meter_limit_reached'` (`METER_LIMIT_REASON`), `meter`,
`used` and `limit`. Two places refuse:

- **A new invitation**, in `POST /api/v1/orgs/[id]/invitations`, after its
  own checks. A resend is not refused, nor an invitation to an account that is
  already platform staff.
- **Adding a member**, in `addMember()` (`lib/tenancy/lifecycle.ts`), after
  its own checks, so a user who is already a member or does not exist is told
  that instead. Every caller gets it, `POST /api/v1/orgs/[id]/members` and a
  fork's own route alike. A user who is platform staff takes no seat and is
  not checked. A user with an open invitation into the org already holds a
  seat, so adding them does not raise the count and is not refused, even
  past a lowered limit; that invitation is looked up only when the add would
  otherwise be refused (`refuseOverSeatsLimit()`'s `alreadyHeld`). Accepting an invitation passes `seatHeld`.

**A platform admin is never refused**, and the platform's own invite route
does not check: the vendor setting an org up must not be stopped by the limit
it sold. Lowering a limit below what an org already has removes nobody; it
cannot add more until it is back under.

An app that reads a seat differently (one role only, say) registers `seats`
with its own `count`, which replaces the platform's everywhere, its refusals
included. The platform refuses a seat where one is made, when an invitation
is issued and when a member is added directly, and lets in whoever takes up a
seat already counted. So an app's count keeps two rules:

- **An open invitation counts as the member it becomes.** Accepting it,
  whether by signing up or with an existing account, is never checked, so it
  must not change the count. A count that left invitations out would let any
  number of accepted invitations past the limit; one that counted a role
  counts the invitations for that role (`invitationTakesSeat()` is the
  platform's test of which invitations take a seat).
- **Platform staff take no seat.** Staff are never refused, and an
  invitation to a staff account is not checked, so a count that included
  them could pass the limit with no refusal.

### What is stored, and how it fails

Limits live at `Org.settings.quotas.meters = { [key]: number }`, beside the
AI caps in the same slice. They are written one key at a time
(`writeOrgMeterLimits(orgId, { key: limit | null })`, `null` clears), so a
writer never clears a limit it did not know about. The caps writers
(`writeOrgQuotas()`, and `PATCH /api/v1/admin/orgs/[id]` with
`settings.quotas`) replace the caps and keep the limits. Limits stored for
keys nothing registers any more are kept and limit nothing; the admin page
lists them and can clear them.

**Meters fail open**, unlike switches. A limit that cannot be read is dropped
with a warning; a count that throws or answers something that is not a whole
number of zero or more, a window function that throws or answers something
that is not a window, and a key nothing registers all answer allowed and are
logged. A broken meter must not stop an org working, and the AI budget still
bounds what it can spend. With no limit set nothing is counted at all.

### The admin surface

`GET /api/v1/admin/orgs/[id]/meters` returns every meter, seats first: its
label, period (`'custom'` for a function), whether it is the platform's own,
the org's limit, how many it has within the window (counted whether or not a
limit is set), and `countFailed` when it could not be counted; plus
`unregistered`, `mayChange` and `registrationFailed`. `PATCH` takes
`{ limits: { [key]: number | null } }` and changes only the keys it names. A
key nothing registers is a 400, unless its value is `null` (clearing a kept
limit). While the app's registration has failed, any key nothing registers is a
409, whether set or cleared: it may be one of the app's meters, and clearing
it would lose a limit the app reads again once it registers. The admin page
then offers no clear for the limits it lists as stored. The same refusals as the switches apply: platform admins only, writes
from the install org or an unbound admin API key (`mayChangeOrgCommercialSettings`),
refused before the body is read. A write that changes something is audited as
`org.meters.update` with the limits before, as stored, and after. A write
that only drops an entry the read could not use is a change, so the row shows
what went. One that changes nothing writes nothing. A settings write clash is a 409.

`/admin/orgs/[id]` always shows a **Limits** section, since seats is always a
meter: each meter's usage against its limit, marked at or over its limit, with
a box per limit (empty for none).

## Privacy

The slice is part of the org row, so the org export and org erasure already
carry it. It names no person. The audit row records the keys, which are code
names, not personal data.

## Not here

- **Metering what was used.** A meter counts on demand from the app's own
  tables; nothing records usage events, and nothing resets at a period's end.
- **A new org's starting switches.** Not set here. An app sets them from an
  org-created hook (`registerOrgCreatedHook()` in `lib/app/org-created.ts`,
  §134), which runs for every new org however it is made, by calling
  `setOrgSwitches()`.
- **Billing.** Plans that write these switches, and payment, are §139:
  [`../billing/billing.md`](../billing/billing.md).

## Related

- [`identity.md`](./identity.md): what `Org.settings` is, and what a fork may add
- [`../architecture/multi-tenancy-design.md`](../architecture/multi-tenancy-design.md): principle 8
- [`../architecture/fork-init-seams.md`](../architecture/fork-init-seams.md): the init gate's guarantee
