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

This page covers switches (t-1033). Requiring a switch on a page, route or
menu item (t-1034) and quotas on app meters (t-1035) are the next tasks of
the same feature.

## Quick Reference

| Need                             | Where                                                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Register your switches           | `initAppEntitlements()` in `lib/app/entitlements.ts` → `registerEntitlementSwitch()`                        |
| Does this org have a switch?     | `orgHasSwitch(orgId, key)`, `lib/tenancy/entitlements.ts`                                                   |
| Every switch an org has          | `loadOrgSwitches(orgId)` → `{ nothingSet, unreadable, on, atDefault, unregistered }`                        |
| Resolve a row you already hold   | `resolveOrgSwitches(readOrgEntitlements(org.settings))`                                                     |
| What is stored                   | `Org.settings.entitlements` = `{ on: string[], off: string[] }`, `lib/tenancy/org-settings.ts`              |
| Set switches from your own code  | `setOrgSwitches(orgId, { on, off })`, or `null` for every switch back to its default                        |
| Who may write it                 | `mayChangeOrgCommercialSettings()`, `lib/tenancy/shared-settings.ts`, after an admin check                  |
| Read / set over HTTP             | `GET` / `PATCH` / `DELETE /api/v1/admin/orgs/[id]/entitlements` (platform admins; set from the install org) |
| Set it by hand                   | the **Entitlements** section on `/admin/orgs/[id]`, shown when any switch is registered                     |
| Did the app's registration fail? | `entitlementSwitchesFailed()`; the org page says so                                                         |
| The audit row                    | `org.entitlements.update`, with what it replaced                                                            |
| Key format                       | `ENTITLEMENT_KEY_PATTERN` in `lib/validations/tenancy.ts`: `lead_gen`, not `Lead-Gen`                       |

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
- **Letting an org set its own.** A switch is what an org bought. The write
  route is platform-only and, at `multi`, install-org only. A fork writing
  switches from a surface of its own owns the same two refusals: a
  platform-admin guard, and `mayChangeOrgCommercialSettings()` from
  `lib/tenancy/shared-settings.ts` (`setOrgSwitches` decides nothing about
  who may).
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
one existed: a save sets only the switches registered at the time. Once
someone sets this switch on an org, its default no longer applies there.

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
when a slice was unreadable, and saving replaces it.

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
by leaving it out. The form names every switch it shows. `DELETE` puts every
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

## Privacy

The slice is part of the org row, so the org export and org erasure already
carry it. It names no person. The audit row records the keys, which are code
names, not personal data.

## Not here

- **Refusing a request.** Nothing reads a switch to refuse anything yet. A
  `requires` declaration beside `tier`, read by the authorization policy so
  menus, pages and routes agree, is §135 t-1034.
- **Counting and limiting.** Quotas on meters an app registers (sessions,
  questionnaires) and a core seats meter are §135 t-1035.
- **A new org's starting switches.** No hook runs when an org is created yet;
  that is §134's org-created seam.
- **Billing.** Plans that write these switches, and payment, are §139.

## Related

- [`identity.md`](./identity.md): what `Org.settings` is, and what a fork may add
- [`../architecture/multi-tenancy-design.md`](../architecture/multi-tenancy-design.md): principle 8
- [`../architecture/fork-init-seams.md`](../architecture/fork-init-seams.md): the init gate's guarantee
