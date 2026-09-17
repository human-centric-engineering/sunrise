# Org Identity

What an organisation is in Sunrise, the invariant that every install has one
and every user belongs to one, and what a fork may and may not add. This is
the first piece of the multi-tenancy programme
([design record](../architecture/multi-tenancy-design.md), Hub §106); the
context primitive, the org lifecycle API and credential binding are later
tasks of the same feature and are named here only where this page has to
promise them something.

**At `TENANCY_MODE=single` nothing reads these rows yet** except the
Art. 15 export manifest. They exist so the org layer has one code path
rather than a dormant multi-tenant branch — see the anti-pattern below.

## Quick Reference

| Need                              | Use                                                               |
| --------------------------------- | ----------------------------------------------------------------- |
| The models                        | `prisma/schema/tenancy.prisma` — `Org`, `OrgMembership`           |
| The install org's fixed id / slug | `INSTALL_ORG_ID`, `INSTALL_ORG_SLUG` — `lib/tenancy/constants.ts` |
| The role vocabulary (client-safe) | `ORG_ROLES`, `orgAdministers()` — `lib/tenancy/roles.ts`          |
| Make a user a member              | `ensureMembership()` — `lib/tenancy/membership.ts`                |
| The role a new user gets          | `initialMembershipFor()` — same module                            |
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
session is _acting in_ is `Session.activeOrgId`, landed by this migration and
wired by t-670.

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

**Later rows — the hook.** `userCreateAfterHook` (`lib/auth/config.ts`)
calls `ensureMembership(user.id, initialMembershipFor(user))` first. Like
every other step in that hook it is **non-blocking** — a failure is logged at
`error` and the signup completes. That was reversed from "blocking" in
review, and the reason is worth keeping: the hook runs inside better-auth's
`createUser`, _before_ the credential account is linked, so a throw would
leave a user row nobody can sign in as, with no path that ever re-runs the
hook — and forgot-password would later mint the credential and sign them in
memberless regardless. The invariant is restored on the session path instead:
t-670's `session.create.before` hook re-runs `ensureMembership` for a user
with no membership, and t-671's guard resolves a null membership to the
install org at `single` (and refuses at `multi`). It is deliberately **not** a
`registerUserCreatedHook` contributor: that registry is the fork's seam and
runs last; this is a core invariant and runs first.

**Fork note.** Sunrise passes no `transaction` option to `prismaAdapter`, so
the hook's write sees the user row. A fork enabling `transaction: true` gets
an interactive transaction the shared client cannot see into, and this upsert
fails its FK on every signup — pass the transaction's client through as
`ensureMembership`'s `db` argument (see the docblock in
`lib/tenancy/membership.ts`).

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

**Known gap until §106 t-670:** the password accept-invite route
(`app/api/auth/accept-invite/route.ts`) applies the invitation's platform role
_after_ `signUpEmail` returns, so the hook sees `role: USER` and an invited
platform ADMIN lands as `MEMBER`. An under-grant with no effect at `single`
(nothing reads the org role yet); t-670 rewrites that route and fixes it.
`smoke:tenancy` does not assert on it (see the next gap for why).

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

## Credentials

The four long-lived credential models — `AiApiKey`, `AiAgentEmbedToken`,
`AiAgentInviteToken`, `McpApiKey` — gained a nullable `orgId` (one column,
one index, `onDelete: Cascade` on the org) in the same migration, backfilled
to the install org. Nothing writes it at mint yet; t-673 does. **One
exception in the backfill:** an `admin`-scoped API key keeps `orgId = NULL`.
The feature's rule is that `admin` means a _platform_ credential with no org
context, and an org-bound admin key is a state t-673 forbids at mint —
binding the existing ones would have created it. `smoke:tenancy` proves the
rule by creating a `chat` key and an `admin` key unbound and re-running the
migration's own `UPDATE` against them.

`Session.activeOrgId` also lands here (nullable, no FK — better-auth owns the
`session` table's shape). It is unread until t-670 teaches better-auth to
write it. Folding both into this migration is what lets the identity release
carry **one** migration, as the design record's merge-impact section promises
forks.

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
- `tests/unit/lib/auth/config-database-hook.test.ts` — the hook writes the
  membership first, and a failure there is logged at error while the signup
  still completes.
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
