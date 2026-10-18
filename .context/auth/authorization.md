# Authorization

**Authentication asks who you are. Authorization asks what you may touch, and
over whose data.** Sunrise ships one answer to the second question — a platform
`ADMIN` administers everything and reads everyone; everyone else reads
themselves — behind a seam a fork replaces without editing a route.

This document is the contract for that seam: the three inputs it is shaped to
take, the recipe for owner-scoped reads, the leak that recipe prevents, and —
stated as plainly as the capabilities — the parts of the read axis that are
**not** behind the seam yet.

- **The module:** [`lib/auth/authorization.ts`](../../lib/auth/authorization.ts)
- **The fork's file:** [`lib/app/authorization.ts`](../../lib/app/authorization.ts) — ships empty
- **Guards that consult it:** [`lib/auth/guards.ts`](../../lib/auth/guards.ts)

> **Scope of this page.** It describes what ships today. The org input ships
> as of §106 (the guard enters an org for every request and the default
> policy reads it — see [the org input](#the-org-input) below and
> [`tenancy/context.md`](../tenancy/context.md)); row isolation (RLS) is
> still the programme's and is marked as such; see
> [`multi-tenancy-design.md`](../architecture/multi-tenancy-design.md).

---

## Three orthogonal inputs, one predicate

The mistake this design exists to avoid is a single widening `role` string.
"Admin of this org", "sees only their own rows" and "is vendor staff" are three
different questions, and folding them into one enum means every new combination
is a new value.

| Axis          | Question                                                           | Supplied by                    | State today                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------ | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tier**      | Is this principal platform staff, a customer's admin, or a member? | #366, §111                     | **Ships the mechanism** (§111 t-810): a surface declares `tier: 'org'` and the guards pass it as `scope.tier`. No core surface declares it yet. See [Admin tiers](#admin-tiers).               |
| **Ownership** | Within one tenant, over _whose_ rows?                              | #367                           | `scope.ownership` (`'own' \| 'team' \| 'all'`) is carried; `canRead` / `subjectScope` are the faces that answer it.                                                                            |
| **Org**       | Which tenant's rows exist at all?                                  | Multi-tenancy programme (§106) | **Ships.** The guard enters an org per request; `viewer.orgId` / `viewer.orgRole` carry it and `scope.org` repeats it. Between-tenant isolation is enforced by RLS (§107), not by this policy. |

`AuthorizationScope` is an open struct with every member optional, so each axis
arrives as a new key rather than a new signature. That is the whole reason the
struct exists — `scope.org` arrived as a new key and swept no caller. For the
same reason **every face returns a `Promise`** although today's default body
needs none: a fork's org policy may look something up, and converting a
synchronous seam to an asynchronous one later is a caller sweep.

## The org input

The guard decides which org a request acts for **once**, at the boundary
([`lib/tenancy/entry.ts`](../../lib/tenancy/entry.ts): the session's active
org, the API key's org, or the proxy-written resolver header — verified
against membership wherever a non-install org is named), and then carries it
two ways: **on the principal** — `viewer.orgId` and `viewer.orgRole` (`OWNER` /
`ADMIN` / `MEMBER` from [`lib/tenancy/roles.ts`](../../lib/tenancy/roles.ts),
or `null` for no membership) — and as the tenant context the handler runs
inside. `scope.org` carries the same id for a policy that prefers to read it
there. The policy is _told_ the org facts and never reads the tenant context
itself: that keeps it testable with a plain object and correct for a caller
holding a principal but no context (the feature's journal decision).

A platform credential — an `admin`-scoped API key — enters **no** org: no
`orgId` on the principal, no scope, the handler runs outside any context.

**What the default policy does with it.** An org `OWNER`/`ADMIN`:

- **administers a resource that carries their org** —
  `resource.orgId === viewer.orgId`, with `resource.orgId` present. A `null`
  resource, or one without an `orgId`, grants **nothing**: those are the
  platform-ops surfaces (every core _admin_ route — no core admin resolver
  names an org until §107), which stay platform-only. That is the control-plane
  split in the tenancy playbook. The core routes that _do_ name an org are the
  org members routes (`/api/v1/orgs/[id]/members/**`, §106 t-672), and this
  arm is what admits an org's own OWNER/ADMIN there while they act in it —
  see [org-endpoints.md](../api/org-endpoints.md). A single-tenant install
  stays byte-identical: on the install org the OWNER set _is_ the
  platform-admin set (the role follows the platform role and is kept in
  step), so the arm admits exactly whom the platform check admits; on every
  other core route no resource carries an org, and
  `authorization-org.test.ts` sweeps every principal × every question those
  routes can ask, with and without org facts, and asserts identical answers.
- **is a session grant.** An `api-key` principal never takes the arm, whatever
  `orgRole` the entry projected onto it: a key is narrower than its owner
  (#542) and only the `admin` scope administers, through the platform check —
  and only while the key's owner is a platform admin (#746).
- **reads the ownerless `this-row` of a resource that carries their org** —
  answered _before_ the once-per-kind diagnostic, because an org resource with
  no `ownerId` is a fork's steady state, not a misconfigured resolver.
- does **not** reach the capability question (`'any-row-of-this-kind'`): that
  names no row, and admitting an org admin to it would hand them every org's
  ownerless rows of that kind until the data layer scopes those reads by org.
  So `checkOwnerlessReachability` over a roster of only org admins reports
  every kind closed — deliberately — and platform staff must stay on the
  roster.

`subjectScope` and the `'subject'` arm are unchanged: an org admin is narrowed
to their own rows like any member — so on an org row **another member owns**,
`canAdminister` says yes and `canRead` says no. That is deliberate: widening
the subject arm would break parity with `subjectScope`, which can name one
user or everyone and cannot yet say "rows in my org" (§107). The narrower
face wins on the read path. **So an org admin is a _narrowed_ admin**,
and the first _admin_ route whose resolver names an org-carrying resource owes
an `ownership` declaration and must read `session.subjectFilter` — the scenario
`guards-ownership-development.test.ts` names. None exists in core until §107;
the org members routes are `withAuth`, declare `ownership: 'resource'`, and
read nothing outside the resolved org.

The comparison is guarded on the resource side explicitly because
`resource.orgId === viewer.orgId` with both `undefined` is `true` — the trap the
fork seam's docblock warns about. A fork's own org policy must guard it the same
way.

### A support session presents as an org ADMIN (§121 t-824)

A platform admin entering a customer org under its support grant
([support-access.md](../tenancy/support-access.md#entering-under-a-grant-t-824))
is, for the length of the entry, **an org ADMIN of that org who is not a
platform admin**. The guards build that principal (`orgRole: 'ADMIN'`, the
entered `orgId`) with the **default user role in place of the platform role**
(`presentedRole`, `lib/auth/support-principal.ts`), and hand the handler a
session whose `user.role` is replaced the same way (`presentedSession`).
`sessionPrincipal` does likewise for the admin layout and the maintenance
bypass.

That is what makes it hold for every policy rather than core's alone. A
`support` flag the default policy checked would be ignored by a fork whose
`canAdminister` is `isPlatformAdmin(viewer)`, which would then hand support
the whole console inside the customer's org. Presenting a non-platform role
needs no policy to cooperate: `isPlatformAdmin(viewer)` answers false, org
arms answer as for the org's own ADMIN, and a handler's
`isPlatformAdmin(session.user)` is false too. `tests/unit/lib/auth/guards-support.test.ts`
pins the fork-policy case. The stored `User.role` is never changed.

A policy that wants to know it is talking to support reads
`getTenantContext()?.source === 'support'` (and `.support` for the grant) —
the principal does not carry it, deliberately.

## Admin tiers

Every admin surface is the **platform's** unless it says otherwise. An org
`OWNER`/`ADMIN` may use a surface that declares itself the org's, and nothing
else; a platform admin uses everything, as before. Undeclared means platform,
fork surfaces included, so an upgrade opens nothing a fork did not opt into,
and opening a surface is a one-line diff a reviewer sees. The roster lives in
[`lib/auth/admin-tier.ts`](../../lib/auth/admin-tier.ts) (§111 t-810).

**How a surface declares it:**

| Surface  | Declaration                                                   | Read by                                                               |
| -------- | ------------------------------------------------------------- | --------------------------------------------------------------------- |
| API      | `withAdminAuth(handler, { tier: 'org', ownership: … })`       | the guard, which passes `scope.tier: 'org'` to `canAdminister`        |
| Page     | its route pattern in `ORG_TIER_ADMIN_PAGES` (`/admin/x/[id]`) | the admin layout on a full load; `AdminTierGate` on in-app navigation |
| Nav item | `tier: 'org'` on the `NavItem` (`lib/admin-nav/registry.ts`)  | the sidebar, which shows an org viewer only those items               |

A page cannot declare itself in its own file, because Next.js refuses unknown
exports from a `page.tsx`, and a check a page has to remember to call is
fail-open for every page that forgets. So pages are listed centrally. A pattern
names one page and not the pages below it.

**What the default policy does with it.** `canAdminister` admits an org
`OWNER`/`ADMIN` when `scope.tier === 'org'`, as a session, with org facts on
the principal, **and only at `multi`**. At `single` the arm admits nobody.
Nothing isolates an org's rows there, and a session can act in a non-install
org it owns (`POST /api/v1/orgs/switch` is not mode-gated), so admitting that
owner would hand them every row the surface reads. An API key never takes the
arm, and `withAdminAuth`'s scope floor refuses a non-`admin` key before the
policy is asked. A tier the default policy does not know (`'team'`) admits
nobody.

**Where the refusal actually happens.** The API is the authority. Admin pages
are shells over `serverFetch` calls, and each call reaches a guard that asks
the policy with that route's own tier. The admin layout refuses an undeclared
page on a full load. It learns the page from the `x-sunrise-pathname` header,
which `proxy.ts` sets on every request and overwrites if a client sent one; a
missing header counts as a platform page. Next.js does not re-render a layout
on in-app navigation, so `AdminTierGate` re-checks the pathname on each one and
sends an org viewer away from a platform page. That is the reader's refusal,
not a security boundary. A database check in `proxy.ts` would make it one, and
Next.js advises against database checks in the proxy, because it runs on every
route, prefetches included.

**What opening a surface costs.** An org admin's rows are narrowed to their own
(`subjectScope` answers `{ userId }`), so every route that admits them owes an
`ownership` declaration. The guard refuses an undeclared one under test and
logs it elsewhere. The roster test enforces the same thing at review time.
`writesSharedSettings` still refuses a shared-settings write from outside the
install org, so `tier: 'org'` widens admission only.

**The roster is pinned.** `tests/unit/scripts/ci/admin-tier-roster.test.ts`
(always-run) pins both lists. It fails when:

- a route declares `tier: 'org'` without being listed in `ORG_TIER_ADMIN_ROUTES`;
- a route is listed without declaring it;
- a route passes a `tier` the scanner cannot read as the literal;
- an org-tier route has no `ownership`;
- a listed page has no `page.tsx`;
- a core nav item marked org-tier points at a page that isn't listed.

**What core opens (§111 t-811).** The customer's sections from the
[control-plane map](../architecture/multi-tenancy.md#the-control-plane-which-admin-surfaces-are-whose):
agents, workflows, triggers, knowledge, conversations, evaluations (with
datasets and runs), experiments, event subscriptions, MCP keys and approvals.
That is their pages, their nav items, and every API route those pages call,
traced from each page's actual fetches. The roster is the list; the map is
the reasoning behind it.

- **Shared configuration is read, never written.** The agent form and the
  knowledge pages need capabilities, agent profiles, providers, provider
  models, embedding models, graders and tags, so those `GET`s are org-tier.
  Their writes keep `writesSharedSettings` and are not org-tier. An org admin's
  provider list omits each row's `baseUrl`, `apiKeyEnvVar` and `metadata`,
  which are the operator's infrastructure. The usage counts on these lists
  (agents per capability, model, tag or profile) cover their own org only:
  how many of another tenant's agents use a shared row is a platform admin's
  delete check, not theirs to know. The settings singleton, the
  knowledge seed, the tags page and the patterns knowledge stay platform-only,
  and their controls are hidden where shared settings are read-only (the seed
  button, the workflow builder's pattern "Learn more").
- **An org admin's MCP key may run slower than the server, never faster.**
  `rateLimitOverride` on a key they create or edit may lower the server's
  `globalRateLimit`, not raise it (`assertKeyRateLimitAllowed`).
- **Each opened route declares its ownership.** Routes over a person's rows
  (conversations, evaluations, runs, datasets, experiments, executions, webhook
  subscriptions, the admin chat turn) are keyed on the caller: `'self'`. Routes
  over the org's configuration (agents, workflows, triggers, knowledge
  documents, MCP keys) and the shared-config reads make no ownership decision:
  `'nothing'`, with the reason. Row isolation bounds both to the entered org,
  and the owner layer still checks every enforced personal model below them.
- **A route that acts beyond the entered org tells its two callers apart.**
  `administersPlatform(principal)` (`lib/auth/admin-viewer.ts`) asks the policy
  the admin layout's platform question. The provider test routes use it: an org
  admin may test only a provider their org is approved for, in their own org,
  while a platform admin keeps the install-org probe.
- **The mixed pages are split per viewer, not assigned** (§111 t-812). The
  orchestration dashboard, costs, the executions list and the MCP landing are
  on the page roster, and each asks `adminPageViewerTier()`
  (`lib/auth/admin-page-viewer.ts`, the layout's platform question, cached per
  request and shared with the layout) and renders its platform-ops half for a
  platform viewer only. Analytics is on the roster too, but every figure on it
  is the org's, so it has no half to split and does not ask. An org admin gets
  the org's half; the routes behind it (costs, its summary and alerts, the
  model catalogue, the dashboard stats and the analytics routes) are
  org-tier, and the routes behind the platform-ops half stay undeclared, so
  they refuse them. The MCP landing shows them the API Keys card alone, which
  is their nav route to the keys page. The overview stays platform-only, since
  every figure on it is install-wide; `/admin` sends an org admin to the
  orchestration dashboard instead. The playbook's control-plane map says how
  each page splits.

**If you replace `canAdminister`,** handle `scope.tier`. A policy that ignores
it admits nobody new: org admins stay locked out of every surface, which is the
safe failure. The other direction is not safe. A policy that admits on
`viewer.orgRole` alone (the old `canAdminister: isOrgAdmin` one-liner) admits
an org admin to every platform surface, roster or not. Gate it on
`scope.tier === 'org'`.

**A fork's own pages** (t-817) are listed in `lib/app/admin-tier.ts`, not in
`ORG_TIER_ADMIN_PAGES`: its `initAppOrgTierAdminPages()` calls
`registerOrgTierAdminPage(pattern)`, and `orgTierAdminPages()`
(`lib/auth/org-tier-admin-pages.ts`) returns core's list and the fork's. Its
routes and nav items already declare in the fork's own files, so opening a
fork page edits no core file.

- **One realm.** The init runs lazily on the server, at the admin layout's
  first read. The layout hands the list to `<AdminTierGate>` and
  `<AdminHeader>` as a prop, so the browser never builds a list of its own
  that could disagree with the one the layout admitted by.
- **Its own sections only.** The registrar throws on a dynamic first segment
  and on any of `CORE_ADMIN_SECTIONS`, so the fork's list cannot reach a core
  page, platform or org.
- **All-or-nothing.** If the init throws, the fork's pages roll back and none
  of them open; the roster test fails on that, rather than passing an empty
  list.
- **No shadowing.** `adminPageTier()` matches patterns without seeing the
  tree, so a `[x]` segment would also name a literal page beside it, which
  Next.js serves instead. The roster test fails for any page a listed
  pattern names that is not itself listed, core's and the fork's alike.

`lib/auth/admin-tier.ts` imports nothing, so the scaffold can import the
registrar from it and `proxy.ts` its header name without either pulling the
fork's scaffold in.

---

## The seam

### Where the question is asked

Sunrise consults the policy in exactly four places, and they are the reason a
fork edits nothing else. **Which face each one asks matters more than the
count** — three ask `canAdminister`, one asks `canRead`:

| Chokepoint                             | Face            | What it gates                                                                                                                                                                                |
| -------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `withAdminAuth` (`lib/auth/guards.ts`) | `canAdminister` | 262 handler wrappings across 190 files, 257 of them under `/api/v1/admin`                                                                                                                    |
| `app/admin/layout.tsx`                 | `canAdminister` | The whole `/admin` page tree, asked with `tier: 'org'` on a page listed in `ORG_TIER_ADMIN_PAGES` ([Admin tiers](#admin-tiers))                                                              |
| `components/maintenance-wrapper.tsx`   | `canAdminister` | The maintenance-mode bypass — an access decision, not chrome, because getting past that page reaches the whole site                                                                          |
| `withAuth` (`lib/auth/guards.ts`)      | `canRead`       | 23 handler wrappings. Asked on **every** one of them; all but one declare no `resource` resolver, so it is asked about `{ kind: 'nothing' }`. The exception is `app/api/v1/users/[id]` (GET) |

Read that table before assuming an override is doing what you meant.
**Replacing `canAdminister` alone changes nothing about a `withAuth` route.**

The converse used to be just as clean, and no longer is. `canRead` is still the
only face that **admits or refuses** a `withAuth` request and nothing else — but
both guards now also ask it, four times per request, to fill
`session.unattributedReads` ([Rows nobody owns](#rows-nobody-owns)). Those calls
decide no admission; they answer "may this caller read rows nobody owns?" for the
handler. So overriding `canRead` alone still admits every admin your
`canAdminister` admits, **and** changes what all 262 admin handlers are told
about ownerless rows. If your policy does I/O, that is also four lookups on every
admin request.

`subjectScope` is asked by **both** guards — that is where
`session.subjectFilter` comes from, and how the guard knows whether the route
owed an ownership decision (see
[the recipe](#every-route-declares-how-it-decides)). Not on every request: only
where the answer can be used, which is a route that declared nothing (the check
needs it) or `{ decidedBy: 'policy' }` (the handler does). It is a third call
site rather than a fifth chokepoint — it supplies an answer and reports an
omission, it does not admit or refuse a request.

The last row carries a trap. `canRead` runs on every `withAuth` request whether
or not the route named a resource, so **a policy that denies `'nothing'` takes
down every core `withAuth` route** — the arm exists precisely so "the route
declared no resource" is answerable without being confused for "the row has no
owner". Permit `'nothing'` unless you have migrated every route to a resolver.

### Registering a policy

`getAuthorizationPolicy()` runs `initAppAuthorizationPolicy()` once, lazily,
before the first read — which happens at the top of every guarded request. A
fork registers; it wires nothing.

```ts
// lib/app/authorization.ts
import {
  registerAuthorizationPolicy,
  DEFAULT_AUTHORIZATION_POLICY,
} from '@/lib/auth/authorization';

export function initAppAuthorizationPolicy(): void {
  registerAuthorizationPolicy({
    ...DEFAULT_AUTHORIZATION_POLICY,
    canAdminister: async (viewer, resource, scope) => {
      /* … */
    },
  });
}
```

**Spread the default and override a face; do not send a patch.** The copy is
then visible in the fork's own diff, which is what keeps "I overrode `canRead`
and forgot `subjectScope`" a thing they can see.

**Registering must be synchronous, and here that is a security property.** An
`async` `initAppAuthorizationPolicy` makes the init gate latch success on the
_promise_ rather than the work, so every read in that window — and every read
forever, if the promise rejects — gets Sunrise's default policy, the widest one,
while the **safe-mode machinery reports nothing wrong** — the gate latched
`'ok'`, so no rollback and no `onFailure`.

It is not silent, though, and the log is where to look first:
`lib/fork-init.ts` emits `logger.error('… returned a promise — this seam must be
synchronous, and the all-or-nothing rollback does NOT apply to it')`, plus a
second error if the promise later rejects. Lint also catches it
(`@typescript-eslint/no-misused-promises`). What is missing is a _refusal_:
the gate logs and carries on, so the install runs the widest policy either way.
[#739] tracks that.

### The three faces

```ts
canAdminister(viewer: AuthorizationPrincipal,
              resource: AuthorizationResource | null,
              scope: AuthorizationScope): Promise<boolean>;

canRead(viewer: AuthorizationPrincipal,
        target: ReadTarget,
        scope: AuthorizationScope): Promise<boolean>;

subjectScope(viewer: AuthorizationPrincipal,
             scope: AuthorizationScope): Promise<SubjectFilter>;
```

`canRead` takes a **union**, not a nullable id, and answering every arm is
enforced by the compiler:

```ts
type ReadTarget =
  | { kind: 'nothing' }                                      // route declared no resolver
  | { kind: 'unattributed'; asking: UnattributedQuestion;    // nobody owns it
      resource: AuthorizationResource }
  | { kind: 'subject'; userId: string; resource: … | null }; // a row owned by someone

type UnattributedQuestion =
  | 'this-row'               // a resolver named one row and could not attribute it
  | 'any-row-of-this-kind';  // may this caller read unowned rows of this kind at all?
```

A `switch` that misses an arm returns `undefined`, which does not satisfy
`Promise<boolean>`, so an incomplete policy **fails the fork's build**. The
previous signature was `subject: string | null`, and the natural line to write
against it — `subject === null || subject === viewer.userId` — permitted every
caller on any ownerless row while reading exactly like a check. Build the target
with `readTargetFor(resource)`, `readSubject(userId)` or
`readUnattributedKind(kind)`; do not construct it by hand at a call site, which
is how two guards drifted apart in the first place — and, since the arm gained
`asking`, a hand-built literal no longer compiles anyway.

`'unattributed'` is the arm to think hardest about, and it answers **two**
questions. One is a row the resolver named and could not attribute — an org-owned
row, or a nullable `createdBy` on a `SetNull` model, which `CLAUDE.md` mandates
for retained config and audit models. The other has no row at all: _may this
caller read unowned rows of this kind, before I build a query?_ — the capability
question the guards precompute, and the one
[Rows nobody owns](#rows-nobody-owns) is about.

The default policy answers both alike — platform staff, nobody else — and
**diagnoses only the first**, once per resource kind. A missing `ownerId` on a
resolved row is something a fork can go and fix; there is nothing to fix about
the capability question, and warning on it told every install to correct a
resolver that does not exist. `asking` exists so the arm can tell them apart; a
policy that treats them alike ignores the field, which is what the built-in ones
do. Narrowing the warning to resources carrying an `id` was tried instead and
reverted — a resolver returning a kind with no id is exactly the misconfiguration
the diagnostic is for.

**But read the field before reading the resource.** On the capability question
there is no row, so `resource` carries a `kind` and nothing else. A policy that
_dereferences_ one of the absent fields throws, and a throwing policy is answered
by safe mode — it denies, which is the safe direction. A policy that _compares_
one does not: `target.resource.orgId === scope.org` is `undefined === undefined`
on this path, which is **`true`**, granting ownerless reads the policy was
written to refuse. Answer `'any-row-of-this-kind'` from the principal alone and
keep resource-reading logic on the `'this-row'` branch.

### What a failure does

Every path fails closed, and that is a deliberate outage rather than a
degradation:

- A policy method that **throws** denies, and is logged. All three faces then
  answer from `SAFE_MODE_POLICY`, so the degraded behaviour is parity-consistent
  by construction rather than hand-written per face. This is **per call**, not a
  latch: the next request goes back to the fork's policy. An intermittently
  throwing `subjectScope` therefore produces intermittently narrowed lists and
  does not close the console — unlike the registration failure below.

  Because it is per call, a `canRead` that throws for everything now costs
  **five** error lines per guarded request, not one: the route's own read plus
  the four ownerless-read questions the guard precomputes
  ([Rows nobody owns](#rows-nobody-owns)). That is deliberate rather than
  overlooked — latching the log would hide exactly the intermittent case this
  bullet exists for — but expect the volume, and read the **registration** error
  at process start for the cause rather than trying to find it in the flood.

- A **registration** that throws puts the install in safe mode for the life of
  the process: nobody administers anything, and every declared read narrows to
  the reader's own rows.

Sunrise deliberately does **not** fall back to its own default policy on a failed
registration. A fork's policy typically _narrows_ the platform default, so
falling back would widen access under a log line saying the feature was disabled.

Safe mode does not deny a read with **no declared subject** — almost every core
route declares none, so denying those would take the application down over a seam
most of them do not use. It refuses what it was asked about, not what it was not
asked about: `app/api/v1/users/[id]` (GET) declares a resource, and safe mode
refuses that read even for a platform admin.

---

## What is not behind the seam yet

Read this before trusting a narrowing `canRead`.

**Not every read of personal data is a `canRead` read.** No core route decides a
read from the platform role _inline_ any more — `app/api/v1/users/[id]` (GET)
was the last holdout and declares a resolver as of this release. But two core
routes read other users' personal data through **`withAdminAuth`**, so
`canAdminister` governs them, not `canRead`:

| Route                           | Reads                                     | Face            |
| ------------------------------- | ----------------------------------------- | --------------- |
| `GET /api/v1/users`             | Every user's id, name, email and role     | `canAdminister` |
| `GET /api/v1/users/[id]/export` | One user's complete subject-access bundle | `canAdminister` |

So the pattern this page recommends — `{ ...DEFAULT_AUTHORIZATION_POLICY, canRead: narrower }` —
**does not narrow either of them.** A fork that overrides only `canRead` still
lets every platform `ADMIN` list all users and export any user's full record.
Narrowing reads means overriding `canAdminister` too, and giving those routes a
`resource` resolver so it has something to narrow on.

This is the converse of the warning under the chokepoint table, and it is the one
that costs data rather than access: overriding `canAdminister` alone leaves
`withAuth` routes wide, and overriding `canRead` alone leaves the admin read
surface wide.

**No core list endpoint narrows by `subjectScope`.** It is now called by both
guards — that is how `session.subjectFilter` and the ownership check below exist
— but no Sunrise list route narrows by its _answer_, because a single-tenant
install has one class of admin and nothing to narrow to. The predicate ships for
the fork whose `AND`-it-into-the-query code needs it, and because shipping
`canRead` without the thing that keeps it honest is how the two faces diverge.

Owner-scoped core lists do exist, and they are all hand-rolled — **but not all
on the same column**, which is the thing to know before grepping for them:
webhooks and experiments key on `createdBy`, the evaluations family (sessions,
runs, datasets) on `userId`. A roster assembled by searching for one of those
two names silently omits the other half.

Hand-rolled is not an oversight waiting on a migration: the default policy
answers `{}` for a platform admin, so routing one of them through `subjectScope`
would _widen_ it to every admin. The seam is for the fork that changes that
answer, not a replacement for a boundary core has already decided.

**The marker cannot see past the route.** The `ownership` declaration below is
about the handler; a route that declares `{ decidedBy: 'nothing' }` and calls a
library function that reads every row is exactly as leaky as it was before. The
standing example is the webhook-subscription read in
`lib/orchestration/backup/exporter.ts` (`readConfig`), reached by
`GET /api/v1/admin/orchestration/backup/export`, which reads every
subscription's `url` and `emailAddress` in the org with no owner filter. What changed is
that the route now has to say so in its own source, which is the difference
between an unreviewed omission and a reviewed decision. Closing it properly
needs a control at the query, which is the tenancy chokepoint in
`lib/db/client.ts` — see [the leak](#the-leak-stated-plainly).

**Which files read rows nobody owns outside the helpers is derived, not
recalled.** The always-run test `tests/unit/scripts/ci/ownerless-surfaces.test.ts`
lists every source file under `app/`, `lib/` and `components/` and, through the
library `scripts/ci/ownerless-surfaces.ts` (no entry point of its own), parses
each with the TypeScript compiler and finds each
read of `AiWorkflowExecution`, `AiConversation` or `AiMessage` — a property or
element access on any receiver, a destructured client, a table name in SQL text
— and the always-run test fails unless the file value-imports the access helper
for that model or is declared in `OWNERLESS_SURFACE_EXCEPTIONS`
(`lib/orchestration/access/ownerless-surfaces.ts`, beside the helpers) with a
reason the checker enforces as non-trivial. The parser rather than a regex,
deliberately: a first draft tokenized source by hand and three review rounds
each found ordinary shapes it could not see. Two dispositions: `'by-design'` for a file
with no caller to scope to (the engine, the reaper, a webhook receiver, a
consumer route keyed on `session.user.id`), and `'known-gap'` for one that
should go through the helper and does not yet, which must name the issue or
task that closes it and is reported as stale the moment the file starts
importing the helper. The first pass (t-692) measured 54 files touching the
three models — 23 through the helpers, 29 by design, and two known gaps:
`approvals/history` and the analytics service. t-694 moved the analytics
service through the helper and #773 moved approval history, so the roster
carries **none**. Three earlier
coverage claims on this page were each written from the files their author had
read and each was wrong; this is what replaces them. **It raises the floor; it
is not a proof** — a file that imports the helper and runs an unscoped query
beside it passes (an import of a helper _type_ — with or without the `type`
keyword — does not, nor does `isShareActive`, a predicate on a row: coverage is
an import of one of the helper's _decisions_, the exported functions that take
the `AuthenticatedSession`, read off the helper's own source; nor does a bare
import nothing uses), and a read through a relation `include` is not seen at
all. A fork's own files land
in the roster the moment they exist, and a fork declares its exceptions in
`appOwnerlessSurfaceExceptions` (`lib/app/ci.ts`) rather than editing the core
list.

---

## Owner-scoped reads: the recipe

The two faces are **one rule in two shapes**. Use both, or the detail page opens
a record its own list does not contain.

### Every route declares how it decides

`withAuth` and `withAdminAuth` take an `ownership`, and it is the declarative
owner-scope marker #367 asked for. Four ways to satisfy it:

| Declaration                          | Means                                                                                              |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `{ decidedBy: 'policy' }`            | the handler reads `session.subjectFilter` — **and the guard checks that it did**                   |
| `{ decidedBy: 'resource', because }` | the policy decided about the row the `resource` resolver named, and the handler reads nothing else |
| `{ decidedBy: 'self', because }`     | keyed on the caller's own id and nothing else                                                      |
| `{ decidedBy: 'nothing', because }`  | no ownership decision, deliberately                                                                |

**The obligation only exists when the caller is actually narrowed.** The guard
asks `subjectScope(principal)` when the answer can be used; `{}` means this
caller may see every subject, so there is nothing to forget and nothing to
declare. `{ userId }` means there is, and a route that declared none of the four
is reported — a **failing test**, and a `logger.error` said once per route
everywhere else, development included.

Development logs rather than refusing because of what the canonical fork
migration looks like: the documented one-line
`{ ...DEFAULT_AUTHORIZATION_POLICY, canAdminister: isOrgAdmin }` leaves the
default `subjectScope`, so an org admin is narrowed and **all 262
`withAdminAuth` handlers owe a declaration at once**. Refusing in development
would take a fork's whole admin console down the first time they booted after
upgrading, for following the recipe. The failing-test list is the better
instrument anyway: it enumerates the routes instead of withdrawing the app.

**It is also silent on a response that carried no rows.** A handler returning
4xx — a rate-limit 429, a validation 400, a 404 — answered nobody's query, so it
cannot have answered it too widely. This matters because the recipe below pairs
`'policy'` with the handler shape core itself uses, and 38 guarded routes here
open with `if (!rateLimit.success) return createRateLimitResponse(rateLimit)`.
Without the gate, every rate-limited request on such a route would be a 500.

The one shape it gets wrong is a **streamed body**, because the read happens
after the response is returned. Read `session.subjectFilter` before you hand
back the stream — you need it to build the query anyway.

That is why all but nine of Sunrise's 263 `withAdminAuth` handlers carry no
declaration and its 23 `withAuth` handlers do: under the default policy a platform admin is
unrestricted and a member is not. On a fork whose org admin **is** narrowed, the
admin routes start asking too, one route at a time, in that fork's own test
suite.

The nine are the experiments family, which scopes itself by hand and says so
with `'self'` — see [Experiments](#experiments--the-divergence-this-page-was-written-about-since-closed).

`because` is required on all but `'policy'`, and required rather than
encouraged. The value of the marker is the sentence; a reviewer reading
`{ decidedBy: 'nothing' }` alone learns only that somebody typed it. `'policy'`
is the exception because it is the one the guard can check for itself.

**A `resource` resolver is not a declaration on its own.** It used to exempt the
whole handler automatically, and that was too generous: `canRead` was asked about
one row, and says nothing about a list of siblings the same handler goes on to
run. It was also the only escape hatch that needed no sentence and produced no
log line. Declare `{ decidedBy: 'resource', because }` and let the sentence carry
the "and nothing else" — `app/api/v1/users/[id]` (GET) is the worked example.

**Reading `session.subjectFilter` on a route whose declaration settles the
question without it gives you the reader's own id, and logs.** The filter is
only computed where it can be used — a route that declared nothing, or one that
declared `'policy'`. Everywhere else the getter answers `{ userId }`: the
_narrowest_ value the type can express, so a query built from it returns too few
rows rather than too many. It deliberately does **not** answer `{}`, which is the
widest, and it deliberately does not throw — `subjectFilter` is a required member,
so a shared helper typed against `AuthenticatedSession` has no way to know
reading is unsafe, and a 500 for real users is the wrong price for that. Same
trade as `subjectScope`'s own wrapper, which logs and falls back to safe mode
rather than raising.

**`'self'` is not `'policy'` with extra steps, and must not be migrated to it.**
`subjectScope` widens to `{}` for a platform admin — correct for an admin list,
catastrophic on `users/me`, where it would hand an admin everyone else's row.
A route that is self-scoped by construction stays keyed on `session.user.id`.

### The principal comes from the guard — never rebuild it

`session` is an `AuthenticatedSession`: `AuthSession`, plus the `principal` the
guard decided with, plus `subjectFilter` — the policy's answer for this caller,
already computed. There is nothing to construct.

**Do not rebuild the principal from `session.user`.** `administersEverything`
branches on `credential` and `scopes`, and a handler cannot see either: the
credential kind and an API key's scopes are known only inside the guard, and
`AuthSession` carries neither. The plausible reconstruction —
`credential: 'session'`, taken from the session object you were handed — is a
**widening bug**: `withAuth` accepts a key of any scope, so a `chat`-scoped key
held by a user whose role is `ADMIN` gets judged by the role, and a policy that
should answer `{ userId }` answers `{}` — every subject.

It is also invisible to `checkAuthorizationParity`, which is why the fix is one
object rather than a documented convention. The guard asks `canRead` with the
true principal; a handler asking `subjectScope` with a reconstruction makes the
two faces disagree **at the call site**, for a policy the checker passes clean.
Reading `session.subjectFilter` is the same answer from the same principal, so
there is nothing to drift.

### The list

```ts
export const GET = withAdminAuth(
  async (request, session) => {
    // Reading this is what `decidedBy: 'policy'` promises, and the guard
    // notices whether you did. Read it once into a local; it is a getter.
    const filter = session.subjectFilter;

    // `{}` means every subject, so an unrestricted viewer adds no clause and a
    // narrowed one adds `createdBy`.
    const ownerClause = filter.userId ? { createdBy: filter.userId } : {};

    // AND, not spread. `{ ...ownerClause, ...otherFilters }` is last-wins, so a
    // `createdBy` key in `otherFilters` — the most natural extra filter on an
    // admin list, and usually built from a query parameter — silently deletes
    // the boundary and returns 200 with the whole table.
    const where: Prisma.AiWidgetWhereInput = { AND: [ownerClause, otherFilters] };

    const [rows, total] = await Promise.all([
      prisma.aiWidget.findMany({ where /* … */ }),
      prisma.aiWidget.count({ where }),
    ]);
    return paginatedResponse(rows, { page, limit, total });
  },
  { ownership: { decidedBy: 'policy' } }
);
```

**Make the security clause unclobberable.** `webhooks/route.ts` does the
equivalent by putting the visibility fragment and the optional filters side by
side in an `AND`. Either shape is fine; a spread with the owner clause first is
not.

**Count with the same `where` as the query.** A total computed without the filter
tells the caller how many rows exist that they cannot see — a small leak that
survives every test asserting the _page_ is correct.

### The single row

```ts
export const GET = withAuth<Params>(
  async (request, session, { params }) => {
    /* … */
  },
  {
    // `context` is optional on the resolver type, hence the `!`.
    resource: async (_request, context) => {
      const { id } = await context!.params;
      const row = await prisma.aiWidget.findUnique({
        where: { id },
        select: { id: true, createdBy: true },
      });
      // Returning null DENIES. It is a refusal, not "unscoped".
      if (!row) return null;
      return { kind: 'widget', id: row.id, ownerId: row.createdBy ?? undefined };
    },
  }
);
```

Two things about the resolver that are easy to get backwards:

- **It runs before authorization**, because the policy cannot be asked about an
  unresolved resource. On an admin route that means it is reachable by any
  authenticated caller — keep it cheap and do not leak through its errors.
- **`null` and a throw both deny.** The permissive state is reached by declaring
  _no resolver at all_, which is visible in the route's source rather than in a
  row that happened to be missing. `ownerId: row.createdBy ?? undefined` is the
  idiom for a nullable `SetNull` FK; an explicitly-`undefined` `ownerId` lands in
  the `'unattributed'` arm, not the `'subject'` arm.

### Proving the two agree

`checkAuthorizationParity` is a pure function — no vitest import — so a fork's
own harness can call it:

```ts
const violations = await checkAuthorizationParity(myPolicy, [
  {
    label: 'a member',
    viewer: { userId: 'u1', credential: 'session' },
    subjects: ['u1', 'u2'], // at least one subject the viewer is NOT
  },
]);
expect(violations).toEqual([]);
```

**Give every case a subject the viewer is not.** A self-only case is clean under
every self-inclusive policy, correct or divergent, because both faces agree
trivially about the viewer. The checker reports that as a violation rather than
passing it — along with zero cases and zero subjects, because a parity check that
proves nothing must not report success.

**Run its companion over the same roster.** `checkOwnerlessReachability`
(`lib/auth/orphan-reads.ts`) asks a different question of the same policy: for
every kind of row nobody owns, does at least one principal you named reach it?
Parity proves the faces agree; this proves the policy has not closed a door that
has no other key — and there are two of those, explained under
[Rows nobody owns](#rows-nobody-owns) below.

```ts
const unreachable = await checkOwnerlessReachability(myPolicy, [
  { label: 'an org admin', viewer: { userId: 'u1', credential: 'session' } },
  { label: 'platform staff', viewer: { userId: 'u2', role: 'ADMIN', credential: 'session' } },
]);
expect(unreachable).toEqual([]);
```

**Name the operator principal, not only the narrowed ones.** The first case a
fork writes is the org admin its policy is _for_, and that case is _supposed_ to
be refused. The check passes when any one case reaches each kind, so the roster
has to carry whichever principal you intend to hold that reach. A roster of zero
is a fault, not a pass; a `kinds` list of your own says, visibly at the call
site, which gaps you have accepted.

### Rows nobody owns

`session.subjectFilter` answers "whose rows may I read?" and has no way to say
**nobody's**. That is not a corner: the schema has **19 nullable `User` relations
declared `onDelete: SetNull`**, every one of which can hold a row an Art. 17
erasure detached, plus the models whose rows are born ownerless.

**Six models have a read path that asks the policy about it**, and those six
are what the guards precompute. The rest are admin-global — every admin reads
every row — so there is no owner clause for an orphan to fall outside of, and
nothing to precompute:

| Model                   | Owner column                                              | `onDelete` | A null owner means                                             |
| ----------------------- | --------------------------------------------------------- | ---------- | -------------------------------------------------------------- |
| `AiConversation`        | `userId`                                                  | `Cascade`  | born ownerless — inbound                                       |
| `AiWorkflowExecution`   | `userId`                                                  | `Cascade`  | born ownerless — scheduled                                     |
| `AiDataset`             | `userId`                                                  | `SetNull`  | an Art. 17 erasure detached it                                 |
| `AiExperiment`          | `createdBy`                                               | `SetNull`  | an Art. 17 erasure detached it                                 |
| `AiWebhookDelivery`     | `subscriptionId` (owned through `subscription.createdBy`) | `SetNull`  | its subscription was deleted                                   |
| `AiWebhookSubscription` | `createdBy`                                               | `SetNull`  | an Art. 17 erasure detached it, and it kept delivering (t-782) |

**Born ownerless and left ownerless are disjoint by database constraint**, which
is why the helpers give them different names — `'system'` versus `'orphan'` — and
different audit weight. A `Cascade` row's owner column can only ever have been
null from the start, because erasing the user would have deleted the row; a
`SetNull` row's can only ever mean the owner was erased. A stranger's live
correspondence and a de-attributed test fixture are not the same thing to read.

Either way, a `where` clause keyed on the caller answers "not yours" for all
five, which turns a deliberately retained row into an unreachable one — invisible
to every admin, deletable by none, pruned by nothing.

**So `UNATTRIBUTED_READ_KINDS` is a consequence, not a roster**, and that is what
makes it easy to get wrong. Owner-scoping one of the other models — `AiWorkflow`,
`AiAgent`, `AiKnowledgeDocument` and the rest all record a nullable `createdBy` —
means adding its kind to that list **in the same change**. Leave it out and its
orphans become unreachable exactly as above, with nothing going red. It cannot be
derived from the schema the way `SUBJECT_DATA_SOURCES` is, because what decides
membership lives in the route rather than the column.

**The guards resolve the answer once per request and hand it over.** It is
`canRead`'s `'unattributed'` arm asked with `asking: 'any-row-of-this-kind'`,
once for each kind in `UNATTRIBUTED_READ_KINDS` (`lib/auth/orphan-reads.ts`),
before the handler runs:

```ts
export const GET = withAdminAuth(
  async (request, session) => {
    const mine = { createdBy: session.user.id };

    // No await: the answer was decided before this handler was called.
    const where: Prisma.AiExperimentWhereInput = session.unattributedReads.experiment
      ? { OR: [mine, { createdBy: null }] }
      : mine;

    return successResponse(await prisma.aiExperiment.findMany({ where }));
  },
  {
    ownership: {
      decidedBy: 'self',
      because:
        'Keyed on createdBy = the caller, widened only to rows with NO owner and ' +
        'only where the policy permits an unattributed read. Never another subject’s row.',
    },
  }
);
```

**`'self'`, not `'policy'`** — the widening is to _nobody's_ rows, not to other
subjects', so the route is still self-keyed. Declaring `'policy'` would mean
reading `session.subjectFilter`, which widens to `{}` for a platform admin: the
admin-global posture the experiments family was fixed away from.

`unattributedReads` is a **total record** — every kind present, `true` or `false`
— so a denied kind cannot be read the same way as a kind nobody asked about.
Unlike `subjectFilter` it is an ordinary enumerable property, so a spread of the
session carries it; nothing observes whether it was read, because there is no
`ownership` claim for it to make checkable.

**Never widen the owner clause instead.** "Nobody's" is a third case, not a
softer spelling of "someone else's" — re-admitting every admin to every other
admin's rows is the divergence [#741] closed.

**The cost is eager, and a fork inherits it.** The policy is asked once per kind
on **every** guarded request, including requests touching none of these models,
and including `withAuth` routes. On a default install that is free: the built-in
rule does no I/O. **A fork whose `canRead` hits a database pays those lookups per
request and will want to cache — but per request, not per process.** The policy
object is registered once for the life of the process, so the obvious `Map` keyed
on `userId` hung off it serves a demoted admin their old answer until the next
deploy. Scope it to the request (`AsyncLocalStorage`, or a value threaded from
wherever the fork already resolves the org). Eager was chosen over asking on
demand because the readers built on it compose `where` fragments inline inside
larger objects — `lib/orchestration/admin/live-engine-snapshot.ts` is the awkward
one — where an `await` has nowhere clean to go; making them async would put one
at every call site for a question most requests never ask. Switching to on-demand
later is possible but not free: it is exactly that sweep.

A fork with an ownerless model of its own is not in the record, whose keys are
the core kinds the guards can enumerate. It calls
`mayReadUnattributed(session.principal, kind)` and awaits — the same policy, the
same failure direction, one call.

**The example above is a shape, not a route you can go and read** — every
model's visible _set_ comes from a helper in `lib/orchestration/access/`, one
module per model. That directory is the roster:

| Model                   | Owner column             | Helper                                                    | Bases it can return           | Reaches the policy |
| ----------------------- | ------------------------ | --------------------------------------------------------- | ----------------------------- | ------------------ |
| `AiConversation`        | `userId`                 | `lib/orchestration/access/conversation-access.ts`         | `owner` / `shared` / `system` | from the record    |
| `AiWorkflowExecution`   | `userId`                 | `lib/orchestration/access/execution-access.ts`            | `owner` / `system`            | from the record    |
| `AiDataset`             | `userId`                 | `lib/orchestration/access/dataset-access.ts`              | `owner` / `orphan`            | from the record    |
| `AiExperiment`          | `createdBy`              | `lib/orchestration/access/experiment-access.ts`           | `owner` / `orphan`            | from the record    |
| `AiWebhookDelivery`     | `subscription.createdBy` | `lib/orchestration/access/webhook-delivery-access.ts`     | `owner` / `orphan`            | from the record    |
| `AiWebhookSubscription` | `createdBy`              | `lib/orchestration/access/webhook-subscription-access.ts` | `owner` / `orphan`            | from the record    |

**Four production call sites read the record directly rather than through a
helper, and each is a shape a `where` fragment cannot serve.** The conversation
search route builds its predicate in raw SQL, because a pgvector
cosine-distance query is not expressible through Prisma's query builder. The
other three — the experiments `run`, `verdicts` and `compare` routes — read
`.dataset` to answer a yes/no about a **dataset** row they already hold, as
defence in depth on a different model than their own.

This list was written saying "two" and was wrong within the same PR: the
`verdicts` guard landed a review round after it, and `compare`'s the round
after that. That is the drift it exists to catch, caught on itself. Keep it
current, and treat a site appearing here without one of those two reasons —
raw SQL, or a cross-model check on a row in hand — as the thing to question.

**The absence of that table is how the second mechanism got built**, so it is
part of the fix rather than a description of it: the experiments helper lived
outside this directory as `lib/orchestration/experiments/visible-scope.ts`,
answering the same question through `mayReadUnattributed` and a
`*_RESOURCE_KIND` constant, and nothing in the tree put the two side by side.

Executions moved onto the record in t-685, conversations in t-686, and datasets
and experiments in t-687, which finished the axis; webhook deliveries joined in §109 t-739, and webhook subscriptions in t-782 (a delivery's visibility nests its subscription's). Every helper is
**synchronous** — that is what the eager resolution bought, and what lets the
live-engine snapshot build fragments inline inside a larger object. None of them
declares a resource-kind constant any more: the record's keys _are_
`UNATTRIBUTED_READ_KINDS`, so `session.unattributedReads.dataset` cannot drift out
of that list without failing to compile, and there is no `string` on the path to
spell wrong. `mayReadUnattributed` survives for the caller the precompute cannot
serve — a fork with an ownerless model of its own.

**Two vocabularies, deliberately, and the schema is the reason.** `'system'` and
`'orphan'` are the same column state and disjoint facts: the `Cascade` models'
null can only mean _born_ ownerless, the `SetNull` models' can only mean
_erased_. One name for both would assert something the database forbids, and
would put a stranger's live correspondence and a de-attributed test fixture under
the same audit weight. So t-687 converged the **mechanism** and kept the names
apart; anyone arriving with "why are there two names for null?" should be pointed
at the two `onDelete` clauses in the table above this one.

**Reaching a row that is not your own is logged, and the two `SetNull` models
differ on the writes.** Both log the detail read and every write with
`metadata.accessBasis`; neither logs its list. Datasets skip `'owner'` on all of
it, experiments skip it on reads only — every experiment mutation already wrote a
config-change row for every caller before the basis existed, and narrowing that
to match datasets would have deleted rows an operator can read. See
[`../admin/orchestration-audit-log.md`](../admin/orchestration-audit-log.md).

**Conversations were the last model with no policy in the loop, and the one that
mattered most**: an inbound thread holds a living third party's correspondence,
from someone with no account here and no way to see who read it. A fork
registering a narrowing `canRead` now keeps one tenant's admins out of another
tenant's customers' messages **on the conversation surfaces** — list, search,
detail, messages, provenance, the dashboard counts and dataset capture — with no
route diff.

**The analytics routes are the one reader that is deployment-wide by design,
and they apply the policy's answer too — but only the arm the policy decides.**
`/analytics/unanswered`, `/topics`, `/engagement`, `/feedback` and
`/content-gaps` aggregate every user's conversations: "what are people asking
my agents?" is the product, and a member's chat with a public agent is outside
the per-caller set above (not the admin's own, not shared, not ownerless) and
inside the aggregate. So the analytics service does not take
`conversationVisibilityWhere` — that would have emptied the dashboard on every
install — and takes `deploymentWideConversationWhere(session)` instead, the
helper's fourth face: `{}` when the policy admits the caller to threads nobody
owns, `{ userId: { not: null } }` when it refuses. Every read in
`lib/orchestration/analytics/analytics-service.ts` carries it, so under a
narrowing policy an inbound thread's messages leave every aggregate the way the
thread leaves the list, and `unanswered` stops returning the sender's question
verbatim (t-694; until then these routes consulted nothing, and a fork that
narrowed `canRead` and confirmed the thread 404d was still handed the
correspondence here). On a default install the clause is empty and no number
moves. `POST /conversations/clear` with `allUsers` reads the same arm inline
(t-691).

**The same answer decides the writes, deliberately, and that closes two doors a
policy must leave someone a key to.** There is no `canWrite` face: every core
write over an ownerless row — `PATCH` / `DELETE /conversations/:id`, the
`allUsers` scope of `/conversations/clear`, `approve` / `reject` / `cancel` /
`force-fail` / `retry-step` / `rerun` on an execution — follows the
`'unattributed'` answer, so a principal the policy refuses cannot find the row
and cannot act on it. Two of those actions have no other route. An inbound
thread's sender has no account, so `eraseUser()` cannot reach their messages and
deleting the thread is their only Art. 17 remedy (t-691). A scheduled run paused
at a `human_approval` gate names its approvers, and the act routes honour that
nomination whatever the policy says — but the approvals queue is the executions
list, so an approver the policy refuses can clear a gate they have no surface to
find (t-690); that is the documented position of every delegated approver on
every install, extended to rows nobody owns. Both were weighed against a write
face, an approver arm on the read routes and a denormalised approver column, and
settled the same way: **the fork's policy must admit at least one principal to
each kind of ownerless row**, and `checkOwnerlessReachability` is how it proves
it has. The principal that holds that reach under a customer tier — a platform
operator — is the identity work's (§106) to define, and once `canRead` sees
`scope.org` an org's own scheduled runs and inbound threads stop being ownerless
for that org's admins. The trigger to revisit a write face is a fork that needs
read-yes / write-no over these rows; the reasoning is on
`lib/auth/orphan-reads.ts` and in the `f-mt-authz` journal.

One caveat a fork should know: only the **ownerless** arm asks. Owning a
conversation and holding an active share are facts about one caller and one row,
so they are outside the policy — an admin handed a share still reads that thread
whatever `canRead` says about unattributed reads. Widening _that_ is the identity
work's question, not this seam's.

---

## The leak, stated plainly

**A read that forgets to narrow used to be silent.** It returned 200 with more
rows than the caller should see. Nothing threw, no log line was unusual, the page
rendered, and the test that asserts "an admin can list widgets" passed. The
failure was visible only to someone who knew which rows _should_ have been
absent.

The `ownership` marker removes the silence **at the route**: on an install where
the caller is narrowed, a handler that made no ownership decision is reported
before its response is returned. What it does not remove is the silence **at the
query**. It knows the route did not decide; it cannot know whether the decision
the route claims to have made was applied to every read underneath it. A route
declaring `{ decidedBy: 'nothing' }` that calls a library function reading the
whole table is honest and still leaky.

Row-level security removes both for the _between_-tenant axis: a query that
forgets its `where` returns zero rows, wherever it was written. The equivalent
for this axis is the owner chokepoint at the Prisma client (below), which
refuses a narrowed caller's unnarrowed read wherever it was written. It is
switched on model by model, so on a model it does not enforce yet:

- Treat a new owner-scoped list route as needing a test that **a second user's
  rows are absent**. Asserting the caller's own rows are present passes just as
  well without the filter.
- Prefer `{ decidedBy: 'policy' }` to `{ decidedBy: 'nothing' }` when the route
  reads anything owned. `'nothing'` is a claim about the whole call tree beneath
  the handler, and it is the one the marker cannot check.

### The subject context and the owner classification (§115)

§115 moves the owner check to the query. Two inputs (t-800), and the check
that reads them ([The owner chokepoint](#the-owner-chokepoint), t-801):

- **`lib/auth/subject-context.ts` — whose rows this call stack may read.** Both
  guards run every handler inside `runAsSubject()`, carrying the principal they
  built. `getSubjectReadScope()` answers `none` (no guard entered one), `subject`
  with the policy's `SubjectFilter` (`{ userId }` narrowed, `{}` not), or
  `admitted`. The policy is asked lazily and at most once per request (a failed
  answer is not kept — the next read asks again); a `'policy'` route hands over
  the answer it already has, so `session.subjectFilter` and the data layer
  cannot disagree. The scope follows the async subtree, so a
  streamed body or an interactive `$transaction` keeps it and a maintenance job
  never has one. Work that acts for someone other than the caller once
  started — `resumeApprovedExecution`, which runs the execution's owner's
  workflow, not the approver's — declares a crossing itself (below), so every
  caller gets the same answer whether or not it had a subject.
- **Who enters no subject, on purpose.** Background jobs, and the credential
  routes that never consulted the policy — MCP, embed, webhook and inbound
  triggers, approval tokens. Their credential is not a person the policy
  narrows, so "no subject" (not narrowed) is the honest answer there.
- **`runAcrossOwners(reason, fn)` — the deliberate crossing.** For code that
  must read other members' personal rows for a narrowed caller (an org-wide
  aggregate, an org backup). Logs the reason at info, like `runAsSystem`, when
  it crosses something — the first read inside it that the owner layer would
  have checked, for a caller the policy narrowed — and once per reason per
  request (a crossing around a per-row helper is one line, not one per row). A
  platform admin's export crosses nothing and logs nothing. It lifts only the
  owner check, never the org wall. Outside a
  subject it does nothing. Core's crossings are listed under
  [The owner chokepoint](#the-owner-chokepoint).
- **`lib/db/owner-classification.ts` — which models are personal, and how the
  owner is reached.** A user column (`AiConversation.userId`,
  `AiWebhookSubscription.createdBy`) or a relation to a personal parent
  (`AiMessage` → `conversation`). A model is personal because the routes already
  scope it to its owner — the access helpers above are the evidence — so agents,
  workflows, knowledge and cost logs are `not-personal`, each with its reason.
  `tests/unit/lib/db/owner-classification.test.ts` parses every schema file —
  core's and the fork tiers' — and fails on an unclassified model linked to a
  user or to a personal model.
- **A fork classifies its own models in `lib/app/owner-classification.ts`**
  (t-807), never by editing `OWNER_CLASSIFICATION`. The scaffold ships empty;
  fill `initAppOwnerClassification()` with one `registerAppOwnerClassification()`
  call, using the same row shape core does:

  ```ts
  registerAppOwnerClassification({
    tier: 'app',
    models: {
      AppJournalEntry: { kind: 'personal', owner: { column: 'userId' }, enforced: true },
      AppInvoice: { kind: 'not-personal', because: 'Org billing record; userId is who raised it.' },
    },
  });
  ```

  The registry runs that init once, lazily, before its first read — in the
  runtime that builds the Prisma client — and `ownerClassificationOf()`,
  `personalModels()` and `enforcedModels()` return core's rows plus the fork's.
  So a fork row marked `enforced` is checked by the owner layer exactly as a core
  one is, and the coverage test holds `app.prisma` and `framework-*.prisma` to
  the same rules. The rules a fork row meets:
  - **Personal only if the fork's routes already scope it to its owner**, for
    the reason core's are — and its routes must comply before it is marked
    `enforced`, or the layer refuses reads the product means to allow.
  - **A `through` child needs its parent enforced first**; the client throws
    at construction otherwise, as it does for core.
  - **Core models cannot be reclassified**, and a model one tier classified
    cannot be taken by another. Either row is dropped with an error log and the
    first classification stands — the log is the only signal.
  - **No `alsoVisible`.** Its one arm, `active-share`, is the conversation
    share's rule and names that model's columns; a fork row carrying it is
    dropped.
  - **No `ownerless` kind.** The kinds are core's closed list
    (`UNATTRIBUTED_READ_KINDS`), each the policy's answer for one core model's
    orphans; a fork row carrying one is dropped. A fork model whose owner can be
    missing has its ownerless rows readable by no narrowed caller.
  - **A throwing init is rolled back** and every fork model is left
    unclassified — unchecked by the data layer, guarded by the fork's routes as
    before, and named by the test. Do not import `@/lib/db` from the seam: it
    runs while that client is being built.

  A framework tier registers with `tier: 'framework'` from a function the
  leaf's `initAppOwnerClassification()` calls.

The webhook-subscription read above is personal by this classification, so
when its model is enforced the exporter has to name its crossing with
`runAcrossOwners` — an org backup is a deliberate read of every admin's
subscriptions, and saying so is the point.

### The owner chokepoint

`lib/db/owner-extension.ts` (`withOwnerChecks`) is the second `$extends` layer
on the client `lib/db/client.ts` exports, over the tenancy layer. **It acts only
for a narrowed caller** — `getSubjectReadScope()` answered `subject` with a
`userId` — and only on models whose classification says `enforced: true`. For
anyone else (a platform admin, an `admin` API key, a job, a guard-less route, a
read inside `runAcrossOwners`) it sends the query it was handed, unchanged;
`tests/unit/lib/db/owner-extension.test.ts` compares the SQL with and without it.

**Enforced:** `AiUserMemory` (t-801), `AiConversation` and `AiMessage` (t-802),
`AiWorkflowExecution`, `AiEvaluationSession`, `AiEvaluationLog`, `AiDataset`,
`AiDatasetCase`, `AiEvaluationRun` and `AiEvaluationCaseResult` (t-803). The
personal models still classified but not enforced — `AiApiKey`,
`AiMessageEmbedding`, `AiWebhookSubscription`, `AiWebhookDelivery`,
`AiExperiment`, `AiExperimentVariant` — are narrowed by their routes alone.

| Operation                                                              | Rule                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `findMany`, `count`, `aggregate`, `groupBy`                            | The `where` must **confine** the read: every row it can match is one the caller may read. Otherwise refused before any SQL.                                                                                                                                                                                                   |
| `findUnique` (and `OrThrow`)                                           | Runs whatever the filter. The row returned is refused if it is someone else's, or ownerless and the caller may not read that kind. For a model whose row cannot decide alone — owned `through` a parent, or with a share arm — the read runs narrowed instead, and a miss asks whether a foreign row matched, to refuse it.   |
| `findFirst` (and `OrThrow`)                                            | An unconfined `where` has the caller's readable predicate added, so it returns the caller's first match or none — never whichever row the database found first.                                                                                                                                                               |
| `update`, `upsert`, `delete`, `updateManyAndReturn`                    | They return the row they write, so the `where` must confine them. Otherwise refused before any SQL: checking the row afterwards would be after the write.                                                                                                                                                                     |
| An `include` / `select` / `_count` of an enforced model, from any root | That relation must carry its own confining `where`. `user.findUnique({ include: { aiUserMemories: true } })` is refused. The exception is the ownership relation followed out of a checked read: a conversation's `messages`, a message's `conversation`.                                                                     |
| A to-one `include` / `select` of an enforced model                     | It cannot carry a `where`. When the target's own owner column decides a row (a run's `dataset`, a variant's `evaluationRun`), that column is selected with it and the row returned is refused if the caller may not read it. A to-one reaching a `through` owner or a share model (a case result's `datasetCase`) is refused. |

**Confines**, as a tree: every key of a `where` is a conjunct, so one confining
conjunct (at any depth under `AND`) confines the whole; an `OR` confines only
when every arm does; `NOT` never does. A leaf confines when it pins the owner
to the caller (`userId: me`, `{ equals: me }`, `{ in: [me] }`, or through the
owner relation, `user: { id: me }` / `user: { is: { id: me } }`), or to null for a
model with an `ownerless` kind the caller may read
(`session.unattributedReads`). A compound unique key (`userId_agentId_key`) is
read as its fields. A child owned `through` a parent is analysed as the parent's
predicate under the relation, so it inherits the parent's arms. A
conversation's share arm confines when it selects only live shares
(`share: { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }`),
the shape `conversationVisibilityWhere` emits — so a list built from that
fragment passes as it is, and a message read through it
(`conversation: conversationVisibilityWhere(session)`) does too.

**A share counts only on a `withAdminAuth` request.** A share is its owner's
consent for an admin to view the thread, and every such read is audit-logged
([conversation access](../security/conversation-access.md)) — it is not consent
to other members. So the guard enters the subject with `readsShared` set only
for `withAdminAuth`; on a `withAuth` route, for any caller, the share arm
neither confines a filter nor joins the narrowed predicate, and another
member's shared thread read by id is refused. A fork that adds a surface a
share should reach (a compliance-officer route, say) enters it with
`readsShared: true` and audits the read there.

The expiry bound is checked against the clock with 60 seconds of slack, so
**build the visibility fragment for each query** rather than once per request
and reused across slow awaits: a fragment older than that is refused as
`unconfined-filter`.

```ts
// Confined — passes
prisma.aiUserMemory.findMany({ where: { userId: session.user.id, agentId } });
prisma.aiUserMemory.findMany({ where: { AND: [{ agentId }, { ...session.subjectFilter }] } });
// Not confined — refused for a narrowed caller
prisma.aiUserMemory.findMany({ where: { agentId } });
prisma.aiUserMemory.findMany({ where: { OR: [{ userId: me }, { agentId }] } });
```

**A refusal throws `OwnerReadRefusedError`, in every environment.** There is no
log-only mode: that records a leak rather than stopping it. `handleAPIError`
answers it with the same 404 body a missing row gets, so a refusal does not
confirm the row exists; the log line carries the model and operation. Code that
genuinely must read across owners for a narrowed caller wraps the read in
`runAcrossOwners(reason, fn)`.

**A `'policy'` route that relies on the layer is not an ownership gap.** A read
the layer checked and passed for this caller counts as the route having used the
policy's answer, so a handler that never touches `session.subjectFilter` but
whose personal reads are confined is not reported. That holds only while every
personal read in the route was one the layer checks: a read of a personal model
not enforced yet (an experiment, say) was narrowed by nothing but the route, so
the route is reported as before.

**Not checked:** whether a write is allowed (changing another member's row is
the route's `canAdminister` decision — the layer refuses only the row a
returning write would hand back), and writes that return nothing the caller did
not send (`create`, `updateMany`, `deleteMany`); relation filters that only test existence
(`aiAgent.findMany({ where: { userMemories: { some: … } } })` returns agents);
and raw SQL, which arrives with no model. Every raw read of an enforced table is
listed, with its reason, in `tests/unit/lib/db/owner-raw-sql-manifest.test.ts`,
which fails on an unlisted one.

**Proving it agrees with the routes.** `tests/unit/lib/db/owner-parity.test.ts`
runs every principal through the default policy, safe mode and a delegating fork
policy, and asserts `canRead` on a subject, a list filtered to that subject and
a row that subject owns all get the same answer. The two-member scenarios in
`scripts/smoke/tenancy-isolation.ts` ([16b] memory, [16c] conversations and
messages, [16d] workflow runs) prove it against real Postgres, as the
restricted role. `tests/unit/lib/orchestration/access/owner-layer-agreement.test.ts`
holds the access helpers and the layer together: `executionVisibilityWhere`,
`datasetVisibilityWhere` and `conversationVisibilityWhere` confine on the layer
for every policy answer, the layer's readable predicate is the helper's, and
every row of the ownerless roster (`ownerless-surfaces.ts`) names how the layer
treats its reads — confined, checked by id, a declared crossing, no subject, or
writes only.

**Core's own crossings.** Each names its reason, and is logged when it crosses.

- **Counts and figures, never a row:** per-agent conversation and evaluation
  counts (the agents list and compare), the workflows list's run count per
  workflow, a capability's execution times across evaluations, the workflow
  cost estimate over past runs, and the analytics figures. The analytics reads
  that quote message text — popular topics, unanswered questions, content gaps,
  recent negative feedback — do not cross: for a narrowed caller they read
  through `conversationVisibilityWhere`, so an org admin sees words only from
  threads they could open. A fork that wants its org admins to read members'
  words widens the policy for them.
- **Work that acts for someone else:** resuming an approved execution, and every
  maintenance job (`runScopedJob`) — a tick fired from an admin's session acts
  for the org, not the admin.
- **The approver nomination:** approve, reject and cancel read the run through
  `acrossOwnersForApproval` (`execution-access.ts`), because the nomination is
  in the run's trace and no `where` can say it. They answer 404 unless the
  caller may see the run or the trace names them, and act across owners only for
  a named approver.
- **A dataset delete** sees anyone's queued or running run on it, and names the
  run only to its owner.
- **Exports:** the subject-data export when an admin exports someone else, and
  the org export.

**A run's cases, after its dataset changes hands.** A case result reaches its
dataset case through a to-one the layer refuses, so run results, pairwise
verdicts and failure seeds read the cases in a second query through
`datasetVisibilityWhere` (`lib/orchestration/evaluations/datasets/scored-cases.ts`).
When another member has since claimed the run's (orphaned) dataset, the run keeps
its scores and outputs and its cases come back absent.

**Cost:** 0.3–3 µs per read, measured (design doc, Spike register item 8).

**For a fork.** Fork code reading an enforced model for a narrowed caller
without confining the query now throws, and the route answers 404. That is the
intended signal: confine the query with `session.subjectFilter`, or name the
crossing.

---

## The precedent in this tree

Owner-scoping is not hypothetical here. Sunrise hand-rolls it in two families,
and how they got there is the argument for the recipe: one was coherent from the
start, the other had to be made coherent, and nothing but a reader's attention
had told them apart.

### Webhooks — coherent, and what the recipe generalises

Every read of `AiWebhookSubscription` **under `/admin/orchestration/webhooks`**
is narrowed by owner, list and detail agreeing: the list (`webhooks/route.ts`),
detail GET/PATCH/DELETE (`webhooks/[id]/route.ts`), the test action
(`[id]/test`), the deliveries list (`[id]/deliveries`), the DLQ list, stats and
replay through the relation (`webhooks/dlq/route.ts`, `dlq/stats`,
`dlq/replay`), and two post-fetch comparisons on individual deliveries
(`deliveries/[id]`, `deliveries/[id]/retry`). They used to be **twelve sites
across nine files**, all spelling `createdBy: session.user.id` by hand; since
t-782 every one goes through `webhookSubscriptionVisibilityWhere` or
`webhookDeliveryVisibilityWhere`, which is also what lets a subscription whose
creator was erased stay manageable.

**And that qualifier is load-bearing, which is the real lesson.** This paragraph
first read "every read of `AiWebhookSubscription`", and that was false:
`lib/orchestration/backup/exporter.ts:93` — reached by
`GET /api/v1/admin/orchestration/backup/export` — reads every subscription's
`url` and `emailAddress` with no owner filter. It is correct today, because a
config backup is a platform-level operation and every caller is already a
platform admin; under a customer tier it is a leak, and org-filtering that
exporter is scheduled with the external plane.

So even the family held up here as coherent is coherent only within one
directory. A roster of call sites assembled by reading routes will miss the
library function a route calls — which is the same argument this page makes
about `createdBy` two sections down, turned on the page itself.

### Experiments — the divergence this page was written about, since closed

`AiExperiment` is classified tenant-owned, and until [#741] the handlers over it
disagreed with each other. One admin saw another's experiment in the list,
opened it, edited it and could **delete** it — but got a "not found" trying to
run or compare it, from sites whose comments called the 404 deliberate, "so the
existence of a foreign experiment never leaks", while the list two directories
up leaked exactly that. The widest verb had the weakest check.

All nine are now owner-scoped on `createdBy` — the list and its `count`, the
create, the detail `GET` / `PATCH` / `DELETE`, the `run` / `compare` /
`verdicts` routes that already were, and the `claim` route below — and each declares `{ decidedBy: 'self' }`, so a reader of any
one route sees the posture without reading the other five.

**It is spelled as a `createdBy` clause, not as `subjectScope`, and that is the
part worth carrying forward.** The seam cannot express "owner-scoped" here:
`DEFAULT_AUTHORIZATION_POLICY.subjectScope` widens to `{}` for a platform admin
and `canRead`'s `'subject'` arm permits `administersEverything`, so routing this
family through the policy would have been the _admin-global_ choice. Owner-scoped
and policy-expressed were two options, not one — see [What is not behind the seam
yet](#what-is-not-behind-the-seam-yet), which is the same fact from the other end.

Which of the two to take was decided by what an experiment composes with, not by
which mechanism was newer: it reads an `AiDataset` and writes `AiEvaluationRun`
and `AiEvaluationSession` rows, and every route **under `orchestration/evaluations`**
scopes those three by hand already — on `userId`. Admin-global would have listed
experiments whose results the viewer cannot open. `AiAgent` and `AiWorkflow` —
shared configuration rather than personal work product — stay admin-global, which
is the next section.

**That qualifier is load-bearing here too**, for the same reason it is in the
webhooks section above: `agents/compare/route.ts`, through
`lib/orchestration/agents/agent-comparison.ts`, counts `AiEvaluationSession`
per agent, twice, with no owner clause. This paragraph first read "every route
over those three models", and that was false because of exactly that one file,
filed in another tree altogether (`lib/orchestration/agents/`, called from
`app/api/.../agents/compare/`). Twice on one page now: a roster read off a directory
misses the call site filed somewhere else.

**Those counts are org-wide, and cross owners inside the org on purpose**
(t-682, t-688). The org boundary is row isolation, not a clause: every model the
comparison reads carries `orgId`, so at `multi` the policy bounds each count and
sum to the caller's org, and another org's agent is a 404. No agent is shared
between orgs (slugs are per org, t-708; each org has its own platform agents,
§116), so there is no shared agent whose figures could mix two tenants. Within
the org the figures count every owner's rows, because the screen compares two
agents; narrowing them would rank two agents by how much the caller happened to
use them. The queries live in `lib/orchestration/agents/agent-comparison.ts`,
whose header carries the reasoning; the route declares `{ decidedBy: 'nothing' }`
saying so; its tests pin the absence of an owner clause, so a later tidy-up has
to change a test that explains why not; and `scripts/smoke/tenancy-isolation.ts`
([3b]) proves the org boundary against real Postgres, reading two orgs' spend,
conversations and evaluations as a narrowed org admin of one of them.

**The same route was a third instance of the roster problem, found while fixing
the second.** It reads four owner-bearing aggregates, not two: besides the
evaluation counts, `aiConversation.count` and — the one first missed —
`aiCostLog.aggregate`. `AiCostLog` carries an indexed `userId`, read
owner-scoped in `lib/privacy/export-sources.ts` for Art. 15, and the comparison
sums spend by `agentId` alone. **The missed call site was in `lib/privacy/`** —
a directory nobody auditing an admin route thinks to read.

### The families that record `createdBy` and never read it

`AiAgent`, `AiWorkflow`, `AiWorkflowTrigger`, `AiEventHook`, `McpApiKey` and
`McpExposedPrompt` all stamp `createdBy` on write and never filter on it — every
admin sees every admin's rows. `evaluations/runs/route.ts` carries a comment
noting it followed that precedent deliberately.

**Stamping `createdBy` on write is not scoping, and the two are indistinguishable
to a grep.** `createdBy: session.user.id` inside a `create`'s `data` is
attribution; the same eight characters inside a `where` are a boundary. In the
webhooks routes, twelve of the thirteen occurrences were the second kind and one
the first, until t-782 moved the twelve into a helper. That is why "we filter by `createdBy` here" is not a claim a reviewer can
check by searching, and why the rule wants a named function.

**That is correct today and it is not a bug list.** Single-tenant Sunrise has one
class of admin, so provenance is all `createdBy` is for. It is listed because
those are the models a fork adding a customer tier must revisit — the
classification is `GLOBAL_CONFIG_MODELS` in
[`lib/tenancy/classification.ts`](../../lib/tenancy/classification.ts) (the
playbook's hand-written inventory it replaced is gone), and a
`createdBy` FK is what makes them _reachable_ by the ownership axis, not what
makes them scoped.

---

## Which admin surfaces are whose

A fork adding a customer tier has to split `app/admin/*` into what the vendor
runs and what a customer runs. That mapping is in the multi-tenancy playbook, as
[the control plane](../architecture/multi-tenancy.md#the-control-plane-which-admin-surfaces-are-whose),
because it derives from the same model inventory: a surface belongs to whichever
plane its backing models sit in.

The short version, and the reason it is worth reading rather than guessing:
**the split does not follow the URL tree.** `orchestration/mcp/*` alone has
three answers — `keys` is a customer's, `tools`, `resources` and `settings` are
the vendor's, and `prompts` is **neither until `McpExposedPrompt` is scoped**,
because it is served from a process-global cache to every MCP client under a
global name namespace and a global cap. Do not summarise that page from this
one; go and read it.

The mechanism that places a surface in a plane is the tier: see
[Admin tiers](#admin-tiers).

---

## The `admin` API-key scope

An `admin`-scoped API key bypasses the role check entirely, and always has: the
scope _is_ the capability. That is pinned platform-only (design decision Q6) —
minting one already requires a platform admin with a browser session, and
`app/api/v1/user/api-keys/route.ts` documents why that check deliberately asks
`isPlatformAdmin` rather than `canAdminister`.

"An org-bound key can never carry `admin`" holds at mint and at the guard
(§106): an `admin` key is stored with no org and refused when asked for from
inside a customer org, and both guards refuse a key that carries an org
before the policy is asked (`withAdminAuth` at its scope floor, `withAuth`
through `enterApiKeyOrg`) — so a fork's policy cannot widen it. See
[`tenancy/identity.md`](../tenancy/identity.md#credentials).

---

## Related

- [`lib/auth/authorization.ts`](../../lib/auth/authorization.ts) — the contract, with the reasoning for each shape decision
- [`lib/app/authorization.ts`](../../lib/app/authorization.ts) — the fork's scaffold, with two worked policies
- [`integration.md`](./integration.md) — `withAuth` / `withAdminAuth` usage
- [`../architecture/multi-tenancy.md`](../architecture/multi-tenancy.md) — enabling the capability, and the control-plane split
- [`../architecture/multi-tenancy-design.md`](../architecture/multi-tenancy-design.md) — the org axis; design principles and the Q6 ruling
- [`../architecture/fork-init-seams.md`](../architecture/fork-init-seams.md) — the init-gate contract every `lib/app/*` seam shares
- [`CUSTOMIZATION.md`](../../CUSTOMIZATION.md) §4 — the fork-facing seam list

[#739]: https://github.com/human-centric-engineering/sunrise/issues/739
[#741]: https://github.com/human-centric-engineering/sunrise/issues/741
