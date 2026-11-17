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

| Need                           | Where                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| Register your switches         | `initAppEntitlements()` in `lib/app/entitlements.ts` → `registerEntitlementSwitch()`    |
| Does this org have a switch?   | `orgHasSwitch(orgId, key)`, `lib/tenancy/entitlements.ts`                               |
| Every switch an org has        | `loadOrgSwitches(orgId)` → `{ nothingSet, unreadable, on, unregistered }`               |
| Resolve a row you already hold | `resolveOrgSwitches(readOrgEntitlements(org.settings))`                                 |
| What is stored                 | `Org.settings.entitlements` = `{ switches: string[] }`, `lib/tenancy/org-settings.ts`   |
| Write it from your own code    | `writeOrgEntitlements(orgId, (previous) => keys \| null)`                               |
| Read / set over HTTP           | `GET` / `PUT /api/v1/admin/orgs/[id]/entitlements` (platform admins only)               |
| Set it by hand                 | the **Entitlements** section on `/admin/orgs/[id]`, shown when any switch is registered |
| The audit row                  | `org.entitlements.replace`, with what it replaced                                       |
| Key format                     | `ENTITLEMENT_KEY_PATTERN` in `lib/validations/tenancy.ts`: `lead_gen`, not `Lead-Gen`   |

### Anti-patterns

- **Collapsing "nothing set" into "set to none".** They are different
  answers. An org nobody has set anything on gets each switch's
  `whenNothingSet`; an org set to `{ switches: [] }` gets nothing. Code that
  treats an absent slice as an empty list takes every default-on switch away
  from every existing org.
- **Keeping your own copy.** A `packages` key of your own beside this one is
  two answers to one question, and billing will only ever write this one.
- **Letting an org set its own.** A switch is what an org bought. The write
  route is platform-only, and a fork writing switches from a surface of its
  own owns the same refusal (`writeOrgEntitlements` decides nothing about who
  may).
- **Renaming a key orgs already hold.** The key is what is stored. Register a
  new key and leave the old one unregistered: it reads as off, and a save from
  the admin keeps it.
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
a key, or an empty label, throws; any throw rolls back every switch the init
registered and logs why, so every org reads as having none of yours. That is
deliberate: half an app's switches would give some orgs part of what they
bought, which is harder to notice than none.

### Choosing `whenNothingSet`

Leave it off (the default) for an area that is **new**: it opens only where
someone switches it on, so it fails closed. Turn it on for an area **every org
already uses**, so no org that exists today loses it when you start checking
the switch. An org that has been set ignores it.

## Reading switches

`orgHasSwitch(orgId, key)` is `false` for an org that does not exist and for a
key no app registers, so a typo fails closed. `loadOrgSwitches(orgId)` returns
the whole answer:

- `nothingSet`: nothing was ever set, so `on` is the default-on switches.
- `unreadable`: the stored slice could not be read; see below.
- `on`: the registered switches the org has, in registration order.
- `unregistered`: stored keys no app registers. Off, and kept by a save.

A page reading many orgs at once should not call `loadOrgSwitches` per row.
Select `settings` in the one list query and resolve each row with
`resolveOrgSwitches(readOrgEntitlements(row.settings))`.

Nothing is cached: each read is one indexed `findUnique` on `Org`, a system
model, so it needs no tenant scope.

## What is stored, and how it fails

The slice is `Org.settings.entitlements = { switches: [...] }`, beside
`quotas` (§110), `providers` (§120) and `privacy` (§127). It is kept sorted
and without duplicates. Every other key in `settings`, a fork's included, is
preserved by every write.

**The read fails closed**, like the provider policy. A slice that cannot be
read at all is read as set with nothing on, never as nothing set, because that
would hand the org every default-on switch. A single entry that is not a key
is dropped with a warning and the rest are kept: that can only narrow what the
org has. The admin page says when a slice was unreadable, and saving replaces
it.

**The write** (`writeOrgEntitlements`) is a serializable read-modify-write of
the one key. Its updater is handed what is stored, inside the transaction, so a
caller that keeps part of it cannot lose a write that landed in between. A clash
throws Prisma's `P2034` (`isSettingsWriteConflict`); the route answers 409.
`null` clears the org back to nothing set.

## The admin surface

`/admin/orgs/[id]` shows an **Entitlements** section only when the app
registers at least one switch, and only then fetches them, so vanilla Sunrise
shows and requests nothing new. The section ticks what the org has, marks the
default-on switches, says when nothing has been set, and offers **Clear to
defaults** once something has.

`PUT /api/v1/admin/orgs/[id]/entitlements` takes `{ switches: string[] |
null }`, the registered switches that are on. The key is required, so a
replace cannot clear an org by leaving it out. An unregistered key is a 400
naming it. With nothing registered there is nothing to set, and the PUT is a 409. Stored keys nothing registers are kept: the caller could neither see nor
set them, and a process running older code during a deploy must not drop a
switch newer code registered.

Both routes are platform-only (no `tier`), as the provider policy and the caps
are. At `multi`, an org's own OWNER or ADMIN is refused.

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
