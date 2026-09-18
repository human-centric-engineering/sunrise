# Org Identity

What an organisation is in Sunrise, the invariant that every install has one
and every user belongs to one, and what a fork may and may not add. This is
the first piece of the multi-tenancy programme
([design record](../architecture/multi-tenancy-design.md), Hub §106). The
context primitive is [context.md](./context.md); the org lifecycle — create,
suspend, members, export, erase — is the [lifecycle section](#the-lifecycle-creating-suspending-and-retiring-an-org)
below and [org-endpoints.md](../api/org-endpoints.md); credential binding —
every key and token minted in an org, acting only there — is the
[credentials section](#credentials).

**At `TENANCY_MODE=single` nothing reads these rows for an authorization
decision yet.** The session reads them to choose its active org, the Art. 15
export manifest reads them, and that is all. They exist so the org layer has
one code path rather than a dormant multi-tenant branch — see the
anti-pattern below.

## Quick Reference

| Need                              | Use                                                               |
| --------------------------------- | ----------------------------------------------------------------- |
| The models                        | `prisma/schema/tenancy.prisma` — `Org`, `OrgMembership`           |
| The install org's fixed id / slug | `INSTALL_ORG_ID`, `INSTALL_ORG_SLUG` — `lib/tenancy/constants.ts` |
| The role vocabulary (client-safe) | `ORG_ROLES`, `orgAdministers()` — `lib/tenancy/roles.ts`          |
| Make a user a member              | `ensureMembership()` — `lib/tenancy/membership.ts`                |
| The role a new user gets          | `initialMembershipFor()` / `membershipForNewUser()` — same module |
| The org a new session starts in   | `activeOrgForSession()` — same module                             |
| Change the org a session acts in  | `POST /api/v1/orgs/switch` — `app/api/v1/orgs/switch/route.ts`    |
| Invite someone into an org        | `POST /api/v1/users/invite` with `orgId` (+ `orgRole`)            |
| Create / suspend / erase an org   | `/api/v1/admin/orgs` — `lib/tenancy/lifecycle.ts`, `erase-org.ts` |
| Manage an org's members           | `/api/v1/orgs/[id]/members` — `lib/tenancy/lifecycle.ts`          |
| Give an org its data              | `exportOrgData()` — `lib/privacy/export-org.ts`                   |
| Prove it against a real database  | `npm run smoke:tenancy`                                           |
| The migration                     | `prisma/migrations/20260917120000_org_identity/`                  |

### Anti-Pattern

**Don't** branch on "is this a multi-tenant install?" to decide whether an org
exists:

```typescript
// ❌ Two code paths; the one every single-tenant install runs is the one
//    nobody tests under tenancy.
const orgId = env.TENANCY_MODE === 'multi' ? session.activeOrgId : null;
```

```typescript
// ✅ One org always exists. At `single` it is the install org, and the
//    guard resolves "none chosen" to it (see context.md).
const orgId = session.activeOrgId ?? INSTALL_ORG_ID;
```

The whole point of principle 1 in the design record is that the write path,
the authorization policy and the console split run **one** code path, so the
harness at `multi` protects the path every single-tenant install runs daily.
A `null` org is not a valid state anywhere in Sunrise; the install org is.

## The models

```prisma
model Org {
  id       String    @id @default(cuid())
  slug     String    @unique
  name     String
  status   OrgStatus @default(ACTIVE)   // ACTIVE | SUSPENDED
  settings Json?
  memberships OrgMembership[]
  // + the four credential relations (see "Credentials")
}

model OrgMembership {
  orgId  String
  userId String
  role   OrgRole @default(MEMBER)       // OWNER | ADMIN | MEMBER
  org  Org  @relation(..., onDelete: Cascade)
  user User @relation(..., onDelete: Cascade)
  @@unique([orgId, userId])
}
```

Three things about the shape are decisions, not defaults:

- **`Org` has no `User` FK.** Ownership is a membership role (`OWNER`), not a
  `createdBy` column, so erasing the last owner leaves the org standing. An
  owner-less org is administered by platform admins until one of them names
  a new OWNER through the members API (the [lifecycle](#the-lifecycle-creating-suspending-and-retiring-an-org)
  says why erasure is not refused); the data model does not decide it by
  cascading.
- **Both FKs on `OrgMembership` cascade.** A membership is the person's data
  — it goes with them (Art. 17) and it is exported to them (Art. 15, as an
  `export` source in `SUBJECT_DATA_SOURCES`). It also cannot outlive its org.
- **`role` is a Prisma enum, where `User.role` is a string.** The set is
  closed by design principle 8 ("org roles stop at OWNER / ADMIN / MEMBER"; a
  fork's product tiers sit beneath the org). The database refuses a fourth
  value, and `tests/unit/lib/tenancy/roles.test.ts` asserts the enum and
  `ORG_ROLES` agree.

Multi-membership is allowed: a user may belong to several orgs. Which one a
session is _acting in_ is `Session.activeOrgId` — see
[the active org](#the-active-org-which-org-a-session-acts-in) below.

## The invariant: one install org, every user a member

Two writes, one rule — and one writer that has to repeat it.

**Existing rows — the migration.** `20260917120000_org_identity` inserts the
install org (`id = slug = 'install'`, `ON CONFLICT DO NOTHING`) and a
membership for every user (`ON CONFLICT ("orgId","userId") DO NOTHING`). The
data statements live in the migration, not a seed, because hosted installs
never run `db:seed` ([seeding](../database/seeding.md)) — a migration is the
only thing guaranteed to reach every environment. Every statement is
idempotent, so a re-run or an operator who created the row by hand is a
no-op rather than a failed deploy.

**Later rows — the hooks.** `userCreateBeforeHook` (`lib/auth/config.ts`)
decides the membership — `membershipForNewUser(user, invitation)` — and
records it on better-auth's request state (`lib/auth/pending-signup.ts`);
`userCreateAfterHook` writes it with `ensureMembership`, first thing. Like
every other step in that hook the write is **non-blocking** — a failure is
logged at `error` and the signup completes. The reason, verified against
better-auth 1.7.4 after two review rounds disagreed about it: `create.after`
hooks are queued and run only after the sign-up's transaction has resolved,
so the user, the account and (for email sign-up) the session are already
committed when this runs. A throw would not prevent a memberless user; it
would only turn a usable signup into a 500 the person cannot act on. The
invariant is restored on the session path instead: `sessionCreateBeforeHook`
writes the install-org default for a user with no membership (below), and
the guard resolves a null membership to the install org at `single` and
refuses at `multi` ([context.md](./context.md)). It is deliberately **not** a `registerUserCreatedHook`
contributor: that registry is the fork's seam and runs last; this is a core
invariant and runs first.

Why the decision and the write are two hooks with a carrier between them:
when a sign-up auto-signs the user in (email sign-up without verification,
every OAuth sign-up) the session is created _inside_ the sign-up
transaction, so the session hook runs between the two — for a user with no
membership row yet. Without the carrier it would self-heal the install-org
default first, and the membership the invitation actually granted would then
be a no-op upsert. The carrier is `defineRequestState` from
`@better-auth/core/context` (what `getOAuthState` is built on): one store per
auth request, shared by every hook that request runs. It is also how an
OAuth-accepted invitation's org reaches the after hook, since the before hook
consumes the invitation row.

**The seeded config-owner — the seed.** `prisma/seeds/001-system-owner.ts`
upserts the SERVICE owner with Prisma directly, bypassing the hook, and on a
_fresh_ database it runs _after_ the migration — so the backfill never saw it.
The seed therefore calls `ensureMembership()` itself (idempotent; a migrated
install's existing row is left alone). `smoke:tenancy` runs in CI after
`migrate deploy` + `db:seed`, which is exactly the sequence that exposes it.

**The role rule**, applied identically by both (and asserted to agree by
`tests/unit/lib/tenancy/migration.test.ts`):

| The user is…                                                  | Install-org role |
| ------------------------------------------------------------- | ---------------- |
| A real platform admin (`role = ADMIN`, `accountType = HUMAN`) | `OWNER`          |
| Anyone else — including the seeded SERVICE config-owner       | `MEMBER`         |

**An invitation can change both halves of the answer.** The rule above is
what a user gets when nothing else chooses; an accepted invitation does
choose — see [invitations](#invitations-which-org-a-new-user-joins). It is
also why the role is judged on the platform role the invitation _grants_
rather than the one the row carries at creation: the password accept-invite
route applies `metadata.role` only after `signUpEmail` returns, and judged on
the row an invited platform ADMIN would have landed as `MEMBER` (the gap
t-669 found and t-670 closed).

**The mapping is kept, not applied once (ruling a on the feature).** A
platform-role change afterwards — the admin `users/[id]` PATCH promoting a
USER to ADMIN, or demoting an ADMIN — re-applies it: the route upserts the
install-org membership to `initialMembershipFor(updated).role` in the same
transaction as the role write (`syncInstallMembershipRole` in
`lib/tenancy/lifecycle.ts`), so a demoted admin drops to `MEMBER` and a
promoted user rises to `OWNER`, and a missing membership is healed by the same
call. The install org's OWNER set therefore _follows_ the platform-admin set —
which is what "byte-identical at single" implies, since platform admins
administer the install — and the members API refuses to edit or remove an
install-org membership directly (`INSTALL_ORG_MEMBERSHIP`): the role is not the
caller's to pick, and the membership is the account's floor, left only by
erasing the account. The alternative — two axes independent after creation,
with the members API the only writer and the doc saying "demote in both
places" — was rejected because the guard at `single` already projects the
install-org role from the platform role without reading the row
([context.md](./context.md)); the row must say the same thing or the first
read of it (any non-install org, `multi`) is an over-grant.

Why this rule and not "everyone is MEMBER" or "every ADMIN is OWNER": the
byte-identical promise (principle 2). Nobody gains an org-level grant they did
not already hold as platform admin, so now that the authorization policy reads
org roles a single-tenant install answers every question exactly as it did
before (swept, not asserted: `authorization-org.test.ts`). The SERVICE account holds platform `ADMIN` but never logs
in; making it an org OWNER would be a grant nothing today confers.

## Invitations: which org a new user joins

`POST /api/v1/users/invite` takes two optional keys, `orgId` and `orgRole`,
stored on the invitation's metadata (`invitationMetadataSchema`,
`lib/validations/admin.ts` — optional so every invitation pending before they
existed still parses). Accepting the invitation — by password or by OAuth —
creates the membership `membershipForNewUser` derives from it:

| The invitation says…                           | The member lands as                                           |
| ---------------------------------------------- | ------------------------------------------------------------- |
| neither key                                    | install org, by the role rule above on the role it **grants** |
| `orgRole` (with or without `orgId: 'install'`) | install org, that role, as written                            |
| another `orgId`, org already has members       | that org, `orgRole` (default `MEMBER`)                        |
| another `orgId`, org has **no members yet**    | that org, `OWNER` — whatever `orgRole` said                   |

The last row is the **per-org bootstrap**: an org nobody owns is one nobody
can administer, so its first member owns it. It sits beside the install-scoped
`AuthBootstrap` (first human on a fresh database → platform `ADMIN`) and never
replaces it: the install org's owner is decided by the platform role, and on a
fresh database its first member is the seeded SERVICE account, which must
stay `MEMBER`.

**Who may name an org** is the authorization policy's call, asked in the route
as `canAdminister(principal, { kind: 'org', id, orgId })` after the body is
parsed (the org is in the body, so it cannot be a guard-level `resource`
resolver). Under Sunrise's default policy that answers exactly what
`withAdminAuth` already answered — platform admins only — so nothing widens
today. The policy's org arm says yes to an org's own OWNER/ADMIN only for a
resource that carries that org ([authorization.md](../auth/authorization.md#the-org-input));
this route asks about the org itself, so the arm applies once `withAdminAuth`
admits an org admin — which, under the control-plane split the lifecycle
applies, it does not: inviting is a platform act today, and an org admin adds
an existing user through `POST /api/v1/orgs/[id]/members` instead.
The named org must exist and be `ACTIVE` _when the invitation
is written_; a missing and a suspended org get the same 400, so the endpoint
leaks nothing about orgs the caller may not administer. Acceptance does not
re-check: an invitation into an org suspended during its 7-day window still
creates the membership, and the member is then refused at entry like every
other member of that org — suspension is enforced where a request enters an
org (the guard — [context.md](./context.md) — and the switch), never by
withholding memberships. A
resend (`?resend=true`) re-sends _this_ invitation: the pending `orgId` /
`orgRole` carry over unless the body sends either key (then the body's pair
replaces both) — the admin table's Resend button posts only name, email and
role — and the inherited org goes through the same existence, status and
policy checks. The "already pending" response echoes the pending org keys.

## The active org: which org a session acts in

`Session.activeOrgId` is a better-auth session `additionalField`
(`lib/auth/config.ts`), chosen when the session is minted and changed by one
endpoint.

**At sign-in — `sessionCreateBeforeHook`**, for every session better-auth
creates (sign-in, OAuth callback, the auto-sign-in after sign-up or
verification, password reset). In order:

1. A signup in flight on this request → the org that signup is about to
   grant (see the carrier above). Nothing is read.
2. Otherwise `activeOrgForSession`, over the user's memberships in **active**
   orgs (a member of one suspended and one active org starts in the active
   one; a user whose every org is suspended starts in the most recent of them
   and is refused at entry): their only one; else the install org if they
   belong to it; else the org they joined most recently; else — **no
   membership at all** — the install-org default is written right here (the
   self-heal ruled in t-669's review) and logged at `error`, because it means
   the signup path failed upstream.

Non-blocking: a fault choosing the org mints the session with `null`, which
the guard treats as the install org at `single` and refuses at `multi`
([context.md](./context.md)).

**Switching — `POST /api/v1/orgs/switch` `{ orgId }`.** Verifies an active
membership (a non-member gets the same 403 whether the org exists or not; a
suspended org is refused to its own member), writes the caller's own session
row, and re-issues the cookie. Two things about that write are deliberate:

- **It is `input: false`, so the public `POST /api/auth/update-session`
  refuses it.** better-auth runs every declared session field through the
  same input parser on that endpoint and writes what survives to the caller's
  row with no idea what the field means — without `input: false`, any
  signed-in user could act in any org by naming it. `config-session-field.test.ts`
  proves it with better-auth's own parser over the real options, control
  included. The same parser refuses the field on `auth.api.updateSession`, so
  the switch writes with Prisma.
- **The cookie is re-issued, not just the row.** The guards read the session
  cookie cache (`cookieCache`, 5 minutes); a row update alone leaves the old
  org live until it expires. The route calls `auth.api.getSession` with
  `disableCookieCache`, which reads the row and re-sets the cache cookie, and
  forwards its `Set-Cookie` headers — the accept-invite precedent.

**API-key sessions cannot switch.** A credential's org is fixed at mint;
the route refuses a key caller the way key minting does.

**Reading it:** `session.session.activeOrgId` on the server (`AuthSession` in
`lib/auth/guards.ts`; the inferred type in `lib/auth/utils.ts` carries it
for free) and on the client via `useSession()` (`lib/auth/client.ts`, which
validates it at runtime the way it validates `role`). `null` or absent means
"none chosen" — the install org at `single`. An API-key session leaves it
unset: the key's org is read from the key row, never from the session.

**When a membership is removed** (`removeMember` in `lib/tenancy/lifecycle.ts`)
the user's sessions acting in that org are revoked — `revokeUserSessions`
with its `activeOrgId` filter — and their sessions in other orgs are kept.
When an org is erased, every session still pointing at it has `activeOrgId`
cleared. The 5-minute cookie cache is not a hole in either case: the guard
re-reads the membership on every request into a non-install org
([context.md](./context.md)), so the removal is enforced at the next request.

## The lifecycle: creating, suspending and retiring an org

Every org mutation goes through `lib/tenancy/lifecycle.ts`, and every rule
below is stated there once, so the routes inherit them rather than each
re-deciding. The HTTP surface is [org-endpoints.md](../api/org-endpoints.md);
which routes are the vendor's and which the customer's follows the
[control-plane split](../architecture/multi-tenancy.md#the-control-plane-which-admin-surfaces-are-whose):
create, rename, suspend, export and erase are platform-only
(`/api/v1/admin/orgs`); membership within an org is the org's own OWNER/ADMIN's
(`/api/v1/orgs/[id]/members`), admitted by the authorization policy's org arm
while they are acting in that org — never by a role check in a route.

**The rules, each with a test:**

- **The install org can be renamed, and nothing else** (ruling b): never
  suspended, re-slugged or deleted — `INSTALL_ORG_IMMUTABLE`. It is the one
  row principle 1 promises always exists, and its id and slug are literals the
  guard, the hook and the migration name.
- **An org keeps at least one OWNER.** Demoting or removing the last one is
  refused — `LAST_OWNER` — the way `users/me` refuses to delete the last
  platform admin, and the count and the write share a transaction. Only the
  members API is held to this: `eraseUser()` (Art. 17) is not conditional on
  org roles, so an org _can_ be left owner-less by an erasure. That is a
  state the admin list flags (`ownerCount: 0`), and a platform admin — whom
  the policy admits everywhere — repairs it through the same members route.
  `POST /api/v1/admin/orgs` takes `ownerUserId` so the org starts with one.
- **The first member of an empty org becomes OWNER** when no role is asked for
  — the same bootstrap as an invitation into an empty org
  (`membershipForNewUser`). Unlike the invitation path, an explicit role on
  `POST …/members` is honoured: it is an API call by someone who chose it.
- **Only an OWNER confers or revokes OWNER** (`OWNER_STANDING`). The policy
  admits an ADMIN to the roster; the lifecycle is where "without the OWNER's
  standing" (`lib/tenancy/roles.ts`) is made true — an ADMIN manages MEMBERs
  and ADMINs but may not grant `OWNER`, change an OWNER's role or remove an
  OWNER. The routes hand the lifecycle the caller's standing off the
  principal (`platformAdmin`, `orgRole`); a platform admin has it everywhere.
  Found by t-672's security review: without it the last-OWNER guard protected
  the count of owners while a delegate could crown themself and remove their
  appointer in two requests.
- **The install org's memberships follow the platform role**
  (`INSTALL_ORG_MEMBERSHIP`; the ruling above), so the members API refuses a
  role there, and refuses a removal there.
- **A removed member's sessions in that org are revoked**, the rest kept.
- **Suspension is enforced at entry.** `PATCH` with `status: "SUSPENDED"`
  writes the status and nothing else; the guard refuses every request into
  the org from then on ([context.md](./context.md)), and `POST
/api/v1/orgs/switch` remains the member's way to another org. Reinstating is
  the same write back. `smoke:tenancy` proves it through the real entry
  function against real rows.
- **Erasure is a privacy act, not a lifecycle one** — `eraseOrg()` in
  `lib/privacy/erase-org.ts`, with [its own page](../privacy/org-erasure.md):
  invitations into the org, session pointers and the row go in one
  transaction, memberships and credentials cascade, and users are never
  deleted. [Export](../privacy/org-export.md) precedes it.

**The members routes need a browser session, and the org arm is a session
grant.** Every members route refuses an API key at the handler, and the
default policy's org arm refuses an `api-key` principal outright — a key's
standing is its scopes, and none of them mean "manage the org". The second
half closes what the first alone would not: `enterApiKeyOrg` projects the
key OWNER's platform role onto the key at `single`, so a `chat` key minted
by a platform admin arrived at the install org as `OWNER` and would have
read the whole roster — the user directory — through the `GET` (t-672's
security review). An `admin` key is a platform credential and administers
through `administersEverything`, as before.

## Credentials

The four long-lived credential models — `AiApiKey`, `AiAgentEmbedToken`,
`AiAgentInviteToken`, `McpApiKey` — carry a nullable `orgId` (one column,
one index, `onDelete: Cascade` on the org: an org's credentials go with it).
**Every mint writes it** (t-673): the org the minting request was acting in,
read once from the tenant context (`orgForMint` in `lib/tenancy/entry.ts`)
and never from a body field — a caller cannot mint into an org they are not
in. The mint routes are `POST /api/v1/user/api-keys` and the three admin
routes for embed tokens, invite tokens and MCP keys; each returns `orgId`.
Rotation of an MCP key never touches it.

**Every resolution enters it.** An API key enters through `enterApiKeyOrg`
(the guards); an embed token and an MCP key through their own resolvers,
which apply `resolveCredentialOrg` — the org's status read on the same query
as the credential, since there is no member to verify — and whose routes
wrap the handler in `runAsOrg`. An agent invite token is the odd one out: a
gate the session passes through rather than a credential that acts, so it
enters nothing and `lib/orchestration/invite-tokens.ts` compares its org with
the one the guard entered. The three resolver docs carry the detail
([api-keys](../orchestration/api-keys.md#org-binding-106),
[embed](../orchestration/embed.md#org-binding-106),
[agent-visibility](../orchestration/agent-visibility.md#org-binding-106),
[mcp](../orchestration/mcp.md#api-key-lifecycle)).

**An `admin`-scoped API key is a platform credential and binds no org**
(feature finding 13). Mint stores it with `orgId = NULL`, refuses `admin`
asked for from any org but the install org (`400`), and both guards refuse
a key that carries both `admin` and an org — `withAdminAuth` at its scope
floor, `withAuth` through `enterApiKeyOrg` (`bound-admin-key`) — so "an
org-bound key can never hold `admin`" holds at mint and at both guards, and
a fork's policy cannot widen it. That is also why the read rule keys on the scope, not on
`NULL` alone.

**The interim rows.** The column landed in 0.12.0 (`20260917120000_org_identity`),
backfilled once, and nothing wrote it at mint until t-673 — so every
credential minted in between carried `orgId = NULL`. At `single` the read
rule resolves such a row to the install org, so nothing was wrong; at
`multi` it is refused, so an install that switches modes must never meet one.
`20260918120000_credential_org_backfill` re-runs the identity migration's
four `UPDATE`s verbatim — idempotent by their `WHERE "orgId" IS NULL`, and
still leaving an `admin` key unbound (`tests/unit/lib/tenancy/migration.test.ts`
holds the two files' statements byte-equal). `smoke:tenancy` proves the rule
against Postgres: a `chat` key binds and an `admin` key stays unbound under
the identity migration's `UPDATE`, and a token written with no org is bound
by the re-run's.

`Session.activeOrgId` also landed in this migration (nullable, no FK —
better-auth owns the `session` table's shape). Folding both into it is what
lets the identity release carry **one** migration, as the design record's
merge-impact section promises forks.

## What a fork may add — and what it may not

- **A product layer beneath the org** — plans, billing, branding, teams — is
  yours (principle 8). Put it in your own schema file with a FK to `Org`.
- **Your own tenant-owned models** join the org by carrying an `orgId` column
  (principle 4); the row-isolation feature's classification test will name
  each one until it is classified.
- **Not a fourth org role.** The enum is closed upstream. A "billing admin"
  or "viewer" is a product-layer concept on your side of the FK, not a value
  on `OrgMembership.role`.
- **Not a second "install" org.** `INSTALL_ORG_ID` is a fixed literal the
  guard, the hook and the migration all name; it can never be suspended or
  deleted (ruling b on the feature).

## Proving it

- `npm run smoke:tenancy` — against a real database (and in CI, on a fresh
  one after `migrate deploy` + `db:seed`): the install org exists, every user
  is a member exactly once, the seeded config-owner is a MEMBER, a new user
  gets a membership, the backfill rule on two keys it creates (the migration's
  own UPDATE, scoped to those two ids), cascade on delete — and the
  lifecycle: an org created with its OWNER, the last-OWNER guard both ways,
  the install-org refusals, a SUSPENDED org refusing its own OWNER through
  the real entry function and admitting them once reinstated, a removal
  revoking exactly the session in that org, an export carrying every manifest
  section, and an erasure leaving both users standing.
- `tests/unit/lib/tenancy/lifecycle.test.ts` — every rule above on a
  populated org (the last-OWNER guard with two members, shown to pass once a
  second OWNER stands); `tests/unit/lib/privacy/org-sources.test.ts` — the
  org manifest guard, shown to name an undeclared `orgId` model.
- `tests/unit/app/api/v1/orgs/**`, `tests/unit/app/api/v1/admin/orgs/**` —
  the routes through the real guards and the real policy: an org ADMIN acting
  in the org is admitted, a MEMBER and an ADMIN acting elsewhere are not, a
  platform admin is from anywhere, refusals name nothing.
- `tests/unit/app/api/v1/users/[id]/route.test.ts` — a promotion upserts the
  install membership to OWNER, a demotion to MEMBER (ruling a).
- `npm run smoke:erasure` — now also proves a membership cascades with the
  subject and the org survives.
- `tests/unit/lib/tenancy/migration.test.ts` — the migration's statements,
  their idempotency, and that its `CASE` and `initialMembershipFor()` agree.
- `tests/unit/lib/auth/config-database-hook.test.ts` — the before hook
  records the membership on every arm (an ADMIN invitation → OWNER even though
  the row is USER), the after hook writes it first, and a failure there is
  logged at error while the signup still completes.
- `tests/unit/lib/tenancy/membership.test.ts` — `membershipForNewUser`'s
  table above and `activeOrgForSession`'s four arms, including that the
  self-heal writes for a memberless user and for nobody else.
- `tests/unit/lib/auth/config-session-hook.test.ts` — the session hook's
  order (a signup in flight wins and reads nothing) and its failure shape.
- `tests/unit/lib/auth/config-session-field.test.ts` — `activeOrgId` is not
  client-settable, with the control that shows the assertion doing work.
- `tests/unit/app/api/v1/orgs/switch/route.test.ts` — the switch through the
  real guard: row + cookie, non-enumerating refusals, API keys refused.
- `tests/unit/app/api/v1/users/invite/route.test.ts` — an invitation without
  an org writes metadata byte-identical to before; one with an org asks the
  policy.
- `tests/unit/auth-role-literals.test.ts` — no bare `'OWNER'` / `'MEMBER'`
  outside `lib/tenancy/roles.ts`, the way it already polices `'ADMIN'`.

## Related

- [Tenant context](./context.md) — how a request enters the org it acts
  for, and what reads it
- [Multi-tenancy design record](../architecture/multi-tenancy-design.md) —
  the decisions and principles this page applies
- [Multi-tenancy playbook](../architecture/multi-tenancy.md) — the RLS
  retrofit the later features perform
- [Authorization](../auth/authorization.md) — the policy that reads the org
  role
- [Data erasure](../privacy/data-erasure.md) · [Subject access](../privacy/data-export.md)
  — the dispositions `OrgMembership` and `Org` carry
