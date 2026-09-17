# Org Identity

What an organisation is in Sunrise, the invariant that every install has one
and every user belongs to one, and what a fork may and may not add. This is
the first piece of the multi-tenancy programme
([design record](../architecture/multi-tenancy-design.md), Hub §106); the
context primitive, the org lifecycle API and credential binding are later
tasks of the same feature and are named here only where this page has to
promise them something.

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
//    guard (§106 t-671) resolves "none chosen" to it.
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
  `createdBy` column, so erasing the last owner leaves the org standing. What
  happens to an owner-less org is the lifecycle task's (t-672) to decide; the
  data model does not decide it for them by cascading.
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
t-671's guard resolves a null membership to the install org at `single` (and
refuses at `multi`). It is deliberately **not** a `registerUserCreatedHook`
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

**Known gap until §106 t-672:** the mapping is applied once, at creation.
A platform-role change afterwards — the admin `users/[id]` PATCH promoting a
USER to ADMIN, or demoting an ADMIN — does not touch the install-org
membership, so a demoted admin keeps `OWNER` and a promoted user stays
`MEMBER`. Harmless at `single` today (nothing reads the org role), but the
demote case becomes an over-grant the moment t-671's policy reads it, and
whether the install-org role should _follow_ the platform role or be managed
independently through the members API is a ruling t-672 has to make before it
ships. `smoke:tenancy` deliberately does not assert "every ADMIN is an OWNER"
for this reason.

Why this rule and not "everyone is MEMBER" or "every ADMIN is OWNER": the
byte-identical promise (principle 2). Nobody gains an org-level grant they did
not already hold as platform admin, so when the authorization policy learns to
read org roles (t-671) a single-tenant install answers every question exactly
as it did before. The SERVICE account holds platform `ADMIN` but never logs
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
today; t-671 is what teaches the policy to say yes to an org's own
OWNER/ADMIN. The named org must exist and be `ACTIVE` _when the invitation
is written_; a missing and a suspended org get the same 400, so the endpoint
leaks nothing about orgs the caller may not administer. Acceptance does not
re-check: an invitation into an org suspended during its 7-day window still
creates the membership, and the member is then refused at entry like every
other member of that org — suspension is enforced where a request enters an
org (the guard, t-671; the switch), never by withholding memberships. A
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
2. Otherwise `activeOrgForSession`: the user's only membership; else the
   install org if they belong to it; else the org they joined most recently;
   else — **no membership at all** — the install-org default is written right
   here (the self-heal ruled in t-669's review) and logged at `error`, because
   it means the signup path failed upstream.

Non-blocking: a fault choosing the org mints the session with `null`, which
the guard treats as the install org at `single` and refuses at `multi`
(t-671).

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

**API-key sessions cannot switch.** A credential's org is fixed at mint
(t-673); the route refuses a key caller the way key minting does.

**Reading it:** `session.session.activeOrgId` on the server (`AuthSession` in
`lib/auth/guards.ts`; the inferred type in `lib/auth/utils.ts` carries it
for free) and on the client via `useSession()` (`lib/auth/client.ts`, which
validates it at runtime the way it validates `role`). `null` or absent means
"none chosen" — the install org at `single`. An API-key session leaves it
unset until t-673 binds the key's own org.

**Not here:** revoking sessions when a membership is removed is the
lifecycle task's (t-672); `revokeUserSessions` in `lib/auth/sessions.ts` is
the primitive it will use.

## Credentials

The four long-lived credential models — `AiApiKey`, `AiAgentEmbedToken`,
`AiAgentInviteToken`, `McpApiKey` — gained a nullable `orgId` (one column,
one index, `onDelete: Cascade` on the org) in the same migration, backfilled
to the install org. Nothing writes it at mint yet; t-673 does — so **every
credential minted between this release and t-673 carries `orgId = NULL`**,
which the rule below would otherwise read as "platform credential". That is
why the read rule (feature finding 13) keys on the `admin` scope, not on
`NULL` alone: a non-admin key with a null org is the install org at `single`
and refused at `multi`. t-673 re-runs the backfill's `UPDATE`s (idempotent by
their `WHERE`) when it starts writing the column, so `multi` never meets an
interim key. **One exception in the backfill:** an `admin`-scoped API key keeps `orgId = NULL`.
The feature's rule is that `admin` means a _platform_ credential with no org
context, and an org-bound admin key is a state t-673 forbids at mint —
binding the existing ones would have created it. `smoke:tenancy` proves the
rule by creating a `chat` key and an `admin` key unbound and re-running the
migration's own `UPDATE` against them.

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
  own UPDATE, scoped to those two ids), cascade on delete.
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

- [Multi-tenancy design record](../architecture/multi-tenancy-design.md) —
  the decisions and principles this page applies
- [Multi-tenancy playbook](../architecture/multi-tenancy.md) — the RLS
  retrofit the later features perform
- [Authorization](../auth/authorization.md) — the policy that will read the
  org role (t-671)
- [Data erasure](../privacy/data-erasure.md) · [Subject access](../privacy/data-export.md)
  — the dispositions `OrgMembership` and `Org` carry
