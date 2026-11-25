# The access explainer: who can do what (§143)

Once an install runs at `multi`, several things decide who may open what in the
admin console at once: the platform role, support access, the org role
(`OWNER` / `ADMIN` / `MEMBER`), any named tiers the app registers, and the
org's entitlement switches. Each is declared in code and enforced by the guards
and the policy (see [authorization.md](./authorization.md#admin-tiers)). The
access explainer says it back in plain words, to the people it governs, each
seeing their own slice.

It **decides nothing**. It reads the registrations and the policy's answer, so
it cannot disagree with what the guards enforce, and nothing registered for it
opens or closes a page.

| Piece                 | Where                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Read model            | [`lib/auth/access-explainer.ts`](../../lib/auth/access-explainer.ts) — `buildAccessExplainer()`                           |
| The viewer's reach    | [`lib/auth/admin-reach.ts`](../../lib/auth/admin-reach.ts) — `adminReachOf()`, `lockedSwitchesOf()`, `lockedSwitchesIn()` |
| Endpoint              | `GET /api/v1/admin/access` ([route](../../app/api/v1/admin/access/route.ts))                                              |
| App seam (registrars) | [`lib/auth/access-explainer-registry.ts`](../../lib/auth/access-explainer-registry.ts)                                    |
| App seam (scaffold)   | [`lib/app/access-explainer.ts`](../../lib/app/access-explainer.ts) — `initAppAccessExplainer()`                           |
| Sunrise's words       | `admin.access` in [`lib/i18n/messages/en.json`](../../lib/i18n/messages/en.json)                                          |

## What it shows, and where each part comes from

| Section         | Content                                                                                                 | Derived from                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `your-access`   | the viewer's org role, the tiers they hold, their org's switches                                        | `adminReachOf()` (the policy, once per tier), `loadOrgSwitches()`                                               |
| `roles`         | platform admin, support access, OWNER / ADMIN / MEMBER, every named tier                                | `namedAdminTiers()`, with each tier's `label` / `description` from `registerAdminTier()`                        |
| `areas`         | every org-tier page, grouped, with the tier and switch it needs, whether it opens, and why it is locked | `orgTierAdminPages()`, `namedTierAdminPages()`, `adminPageRequirements()`, `reachesTier()`, `lockedSwitchFor()` |
| `switches`      | each entitlement switch: label, description, held or not, the refusal and upgrade link                  | `registeredEntitlementSwitches()`                                                                               |
| `platform-only` | what the install keeps for the platform, and why                                                        | `closedCoreOrgTierSections()`, and the app's `registerPlatformOnlySurface()`                                    |

Then any sections the app registered (`appSections`).

`/admin` itself is left out of the areas: it sends each viewer on and shows
nothing. At `single` the areas are empty and the roles are the platform admin
alone, since no org role opens the console there.

**Areas.** Core's org-tier pages sit in core's areas (`CORE_ACCESS_AREAS`),
grouped as the sidebar groups them; a test fails on a core org-tier page none of
them claims. An area claims a page by path prefix, the longest claim wins, and
an app's area wins a tie with core's. A page nobody claims is shown under its
first segment (`/admin/reports/[id]` → "Reports"), unless an area already has
that key, in which case it joins that area, so no two areas in one response
share a key. The grouping is not read
from the sidebar: core's sections live in a client component and an app's nav
registers in the browser only, so the server cannot see either.

## Each viewer's slice

| Audience     | Who                                                            | Sees                                                                                                                                        |
| ------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `'platform'` | a platform admin                                               | every registration; every switch, with `held: null` (switches do not limit them); links to platform-only surfaces                           |
| `'org'`      | the OWNER or ADMIN of the org they entered, at `multi`         | every role; every org-tier and named-tier page; the switches the org holds and those it lacks that the app registered `whenLacking: 'lock'` |
| `'holder'`   | someone holding a named tier, who is not the org's OWNER/ADMIN | their own tiers; the pages of those tiers; the switches those pages need                                                                    |

Anyone else, an org `MEMBER` holding nothing included, gets a **403**.

Two rules hold for every audience but the platform's:

- **A switch the app hides stays hidden.** A switch registered `whenLacking:
'hide'` that the org lacks is not listed, and neither is a page that needs
  it. The app chose not to show it, and the explainer does not undo that.
  The exception is a page the policy opens (a fork policy may grant the
  switch some other way, or the switch read may have failed): a page the
  viewer opens is always listed.
- **The narrowing happens on the server.** The read model builds only the
  viewer's slice, so a holder's response never carries another tier's pages
  for a client to filter out.

If the org's switches cannot be read, `you.switchesUnreadable` is `true` and
`switchesOn` is `null`, so a locked page is not explained with a guess. That
includes an org whose row has gone while the session still names it. The route
reads the org's switches once, and works out both what the org has and what
it is shown locked (`lockedSwitchesIn()`) from that one read, so the two cannot
disagree.

## The endpoint

`GET /api/v1/admin/access` returns `{ success: true, data: AccessExplainer }`,
with every string resolved on the server. The explainer's own words, and any
`{ message }` key an app gave, are in the locale the request resolves to
(`lib/i18n/request.ts`, the same resolution every page uses; an API-key call
carries no session cookie, so it gets the fallback a cookie-less request
gets). A switch's label, description and refusal are shown as
`registerEntitlementSwitch()` gave them, which is plain text today.

It is a `withAuth` route, not `withAdminAuth`. No single tier admits all three
audiences, so the handler asks the policy for the caller's whole reach
(`adminReachOf()`, the same function behind the admin layout's
`requestAdminReach()`) and refuses an empty one. An API key is judged as the
policy judges it: an `admin`-scoped key held by a platform admin is the platform's, and a key never takes
the org or named-tier arm, so any other key is refused. The route also sets
`scope: 'admin'`, so the guard refuses any other key before the policy is asked.

A role's `held` says whether the viewer holds it where they are now: support
access is held when the guard entered the org under a support grant.

## The app seam

`lib/app/access-explainer.ts` ships empty. With nothing registered, the
explainer shows every built-in section to every audience, core's areas, and
nothing of the app's own (tested in `tests/unit/lib/auth/access-explainer.test.ts`
and the ships-empty row in `tests/unit/lib/app/defaults.test.ts`).

| To                                                  | Use                                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Name and describe a named tier                      | `label` / `description` on `registerAdminTier()` (`lib/app/admin-tier.ts`)            |
| Group your pages, or move core's into your own area | `registerAccessArea({ key, label, description?, pages })`                             |
| Say what you keep for the platform, and why         | `registerPlatformOnlySurface({ key, label, reason, href? })`                          |
| Choose who sees one of the built-in sections        | `setAccessSectionAudience(section, audiences)` (an empty list hides it from everyone) |
| Add a section of your own                           | `registerAccessSection({ key, title, body, audience })`                               |
| Reword Sunrise's own text                           | `overridePlatformMessages()` on `admin.access.*` (`lib/app/messages.ts`)              |

Text is plain, or `{ message: 'app.…' }` naming a key in the app's catalogue,
which is then shown in the viewer's language. A key the catalogue lacks is shown
as the key and logged, so the page still renders and the log says what to add.

Each registrar throws on a mistake, so a mistake registers nothing: a key that
is not a key, an area key that is one of core's (reword those through the
catalogue instead), an area claiming no pages or a pattern rather than a plain
`/admin/…` path, empty text, an audience that is not one, a section nobody
sees. The scaffold's init runs once, lazily, on the server, through the shared
init gate ([fork-init-seams.md](../architecture/fork-init-seams.md)). If it
throws, everything it registered is rolled back and logged, and the explainer
shows Sunrise's own words with what the access registrations decide.

## Anti-patterns

- **Changing access from here.** Nothing registered for the explainer opens or
  closes anything. To change who opens a page, register it in
  `lib/app/admin-tier.ts`, declare its routes, or change the policy.
- **Restating a registration.** A tier's words belong on `registerAdminTier()`
  and a switch's on `registerEntitlementSwitch()`, where they cannot drift from
  what they describe. Do not repeat them in a section.
- **Filtering on the client.** The endpoint already returns only the viewer's
  slice. A page that fetched a wider view and hid parts of it would put
  another audience's view on the wire.
