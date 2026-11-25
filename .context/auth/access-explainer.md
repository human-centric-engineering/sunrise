# The access explainer: roles and access (§143)

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
| Page                  | `/admin/access` ([page](../../app/admin/access/page.tsx)), drawn by `components/admin/access-explainer/`                  |
| App seam (registrars) | [`lib/auth/access-explainer-registry.ts`](../../lib/auth/access-explainer-registry.ts)                                    |
| App seam (scaffold)   | [`lib/app/access-explainer.ts`](../../lib/app/access-explainer.ts) — `initAppAccessExplainer()`                           |
| Sunrise's words       | `admin.access` in [`lib/i18n/messages/en.json`](../../lib/i18n/messages/en.json)                                          |

## What it shows, and where each part comes from

| Section         | Content                                                                                                                                       | Derived from                                                                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `your-access`   | the viewer's org role (`null` under a support grant, whose role is the policy's, not a membership), the tiers they hold, their org's switches | `adminReachOf()` (the policy, once per tier), `loadOrgSwitches()`                                                                              |
| `roles`         | platform admin, support access, OWNER / ADMIN / MEMBER, every named tier; and `model`, the role model's tables (below)                        | `namedAdminTiers()`, with each tier's `label` / `description` from `registerAdminTier()`; `CORE_ACCESS_PERMISSIONS` and the app's restatements |
| `areas`         | every org-tier page, grouped, with the tier and switch it needs, whether it opens, and why it is locked                                       | `orgTierAdminPages()`, `namedTierAdminPages()`, `adminPageRequirements()`, `reachesTier()`, `lockedSwitchFor()`                                |
| `switches`      | each entitlement switch: label, description, held or not, the refusal and upgrade link                                                        | `registeredEntitlementSwitches()`                                                                                                              |
| `platform-only` | what the install keeps for the platform, and why                                                                                              | `closedCoreOrgTierSections()`, and the app's `registerPlatformOnlySurface()`                                                                   |

Then any sections the app registered (`appSections`).

`/admin` itself is left out of the areas: it sends each viewer on and shows
nothing. At `single` there is no `areas` section (it is left out of
`sections`, not sent empty) and `roles` is the platform admin alone, since
no org role opens the console there (`model` still describes every role, with
`tenancy` saying they are not in force). Leaving out the areas is deliberate: the
platform admin is the only reader, every page opens to them, and their sidebar
already lists every page.

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

| Audience     | Who                                                            | Sees                                                                                                                                                                                          |
| ------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'platform'` | a platform admin                                               | every registration; every switch, with `held: null` (switches do not limit them); links to platform-only surfaces                                                                             |
| `'org'`      | the OWNER or ADMIN of the org they entered, at `multi`         | every role; every org-tier and named-tier page; the switches the org holds, those it lacks that a page requires and the app registered `whenLacking: 'lock'`, and every `setBy: 'org'` switch |
| `'holder'`   | someone holding a named tier, who is not the org's OWNER/ADMIN | their own tiers; the pages of those tiers; the switches those pages need                                                                                                                      |

Anyone else, an org `MEMBER` holding nothing included, gets a **403**.

Two rules hold for every audience but the platform's:

- **A switch the app hides stays hidden.** A switch registered `whenLacking:
'hide'` that the org lacks is not listed, and neither is a page that needs
  it. The app chose not to show it, and the explainer does not undo that.
  The exception is a page the policy opens (a fork policy may grant the
  switch some other way, or the switch read may have failed): a page the
  viewer opens is always listed. And an org's OWNER/ADMIN sees every
  `setBy: 'org'` switch, on or off, with the pages that need it: hiding keeps
  what the platform sells out of sight, not a switch from the admin who turns
  it on.
- **The narrowing happens on the server.** The read model builds only the
  viewer's slice, so a holder's response never carries another tier's pages
  for a client to filter out.

If the org's switches cannot be read, `you.switchesUnreadable` is `true` and
`switchesOn` is `null`, and each switch listed has `held: null`, so neither a
switch nor a locked page is explained with a guess. That
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

Each page carries what is needed to say why it is closed, without reading
another section: `tierLabel` and `requiresLabel` name its tier and switch, and
`closedBy` is `'tier'` when the viewer does not hold the tier, `'switch'` when
they do and the org lacks the switch, `'unread'` when they do and the org's
switches could not be read, `'policy'` when they hold the tier and the org has
the switch (or the page needs none) but the policy still keeps it closed, and
`null` when the page opens. `you` likewise
carries `tierLabels`, `switchLabels`, `supportEntry` and `anySwitches`. An app
may hide `roles` or `switches` from an audience (`setAccessSectionAudience()`),
and the viewer's own panel still names everything in it.

## The page

`/admin/access` ("Roles and access") is a shell over the endpoint: it reads
`GET /api/v1/admin/access` through `loadServerData`, checks the response with
`accessExplainerResponseSchema` (`lib/validations/access-explainer.ts`), and
renders the sections the response names, in its order, then the app's own
(`AccessExplainerView`). It decides nothing and filters nothing: a section
missing from the response is one this viewer does not get. A failed load, or a
response the schema rejects, shows "Couldn't load roles and access" and is
logged, never an empty page.

| Viewer                        | What the page shows                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A platform admin              | that switches do not limit them; every role, area, page and switch; what the install keeps for the platform, with links                                            |
| An org OWNER/ADMIN            | **Your access in _org_**: their role, the tiers they open, the org's switches, and each page they cannot open with the reason (the app's refusal and upgrade link) |
| A named-tier holder           | the same panel for their tiers only, and only their tiers' pages and those pages' switches                                                                         |
| A MEMBER, or no one signed in | nothing: the admin layout turns them away                                                                                                                          |

**The role model (RBAC).** With the `roles` section, the route sends `model`
(`AccessRoleModelView`) to every audience but a named-tier holder: the platform
roles (User, Platform admin, Support access), the organisation roles (Owner,
Admin, Member), the permission table's columns, and its rows: what each role
may do for an organisation. Every core role is sent whatever the tenancy mode,
because it describes the model, not who holds what; each carries `held` for the
viewer. The page draws these as tables, then the app's named tiers as **App
roles**; a holder gets the App roles table only. The rows are
`CORE_ACCESS_PERMISSIONS` (`lib/auth/access-explainer-registry.ts`), words under
`admin.access.permissions.<key>`. They restate rules the routes and
`lib/tenancy/lifecycle.ts` enforce under the default policy (only an OWNER
grants support access; only an OWNER or a platform admin confers, changes or
removes OWNER), and `tests/unit/lib/auth/access-explainer.test.ts` pins every
cell, so change both together. **A fork whose policy answers differently says
so** with `setAccessPermission(key, cells | null)`, so the table never claims
what its guards do not do, and adds its own rows with
`registerAccessPermission()`. The platform admin's column is what they do from the install
org: at `multi`, inside a customer's org the platform role is withheld
(`withholdsPlatformRole()`) and they act as the role that org gave them, which
the table's intro says. Areas, switches and what the platform keeps are tables
too. An empty switches or platform-only section is left out, since a line saying
an install has none was noise the page was rewritten to remove; an empty areas
section says that no pages are listed for the viewer, since there the gap is
about them. At `single` (the response's `tenancy`) the organisation-roles table
carries a note that only platform admins open the console and there is no
support access, so the model is described without claiming it is in force. The
User row is marked "You" for anyone who is neither a platform admin nor in
under support access, from the route's `held` like every other row.

If the app's explainer init throws, everything it registered is rolled back,
its permission restatements included, so `model.permissions` is `null` rather
than core's cells, which may claim what its policy does not do. The page says
the table could not be loaded; the role tables still show.

**Who reaches it.** The page is in its own class, `EVERY_VIEWER_ADMIN_PAGES`
(`lib/auth/admin-tier.ts`): open to every viewer the console admits, which no
tier says (an `'org'` page is closed to a named-tier holder, a named-tier page
to every other tier). `reachesAdminPage()` admits any reach that holds a tier
there, so the layout, `AdminTierGate` and the sidebar agree, and a reach of
nothing is still refused. The class is core's: it is a frozen list with no
registrar, `access` is in `CORE_ADMIN_SECTIONS` so a fork cannot register a
page under it, and the roster test (`tests/unit/scripts/ci/admin-tier-roster.test.ts`)
pins the list and fails on a fork page in its section. The route stays the
boundary; the page-level gate only decides who is shown the shell.

**Where viewers find it.** A sidebar item, "Roles and access", under
Management, shown to every viewer the console admits. `AccessExplainerLink`
(`components/admin/access-explainer/access-explainer-link.tsx`) on the overview
(a platform admin's landing), the orchestration dashboard and Members (an org
admin's), and on `LockedAdminPage`, so whoever meets a locked page finds the
explanation. A named tier's landing is the app's page: put
`<AccessExplainerLink />` on it so a holder finds it from where they arrive.

**Words.** Every string of the page's own is under `admin.access.page`, and
the nav item's under `admin.nav.access`, so the page follows the viewer's
language and a fork rewords it with `overridePlatformMessages()`.
`tests/unit/components/admin/access-explainer/access-explainer-pseudo-locale.test.tsx`
renders it under the pseudo-locale and fails on a raw key.

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
| Restate a permission row your policy changes        | `setAccessPermission(key, { platform_admin, owner, admin, member } \| null)`          |
| Add a permission row of your own                    | `registerAccessPermission({ key, label, allowed })`                                   |
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
- **Adding a page to `EVERY_VIEWER_ADMIN_PAGES`.** It opens the page to every
  holder of every named tier a fork registers. It holds pages whose route
  answers each viewer for themselves, and a fork cannot add to it; open a
  fork page to its audience with a tier instead.
