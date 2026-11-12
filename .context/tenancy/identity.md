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

| Need                              | Use                                                                    |
| --------------------------------- | ---------------------------------------------------------------------- |
| The models                        | `prisma/schema/tenancy.prisma` — `Org`, `OrgMembership`                |
| The install org's fixed id / slug | `INSTALL_ORG_ID`, `INSTALL_ORG_SLUG` — `lib/tenancy/constants.ts`      |
| The role vocabulary (client-safe) | `ORG_ROLES`, `orgAdministers()` — `lib/tenancy/roles.ts`               |
| Make a user a member              | `ensureMembership()` — `lib/tenancy/membership.ts`                     |
| The role a new user gets          | `initialMembershipFor()` / `membershipForNewUser()` — same module      |
| The org a new session starts in   | `activeOrgForSession()` — same module                                  |
| Change the org a session acts in  | `POST /api/v1/orgs/switch` — `app/api/v1/orgs/switch/route.ts`         |
| Invite someone into an org        | `POST /api/v1/users/invite` with `orgId` (+ `orgRole`) — platform      |
| …as that org's OWNER/ADMIN        | `POST /api/v1/orgs/[id]/invitations` — `checkInvitationInto()`         |
| Accept as an existing account     | `POST /api/v1/invitations/accept` — `lib/tenancy/accept-invitation.ts` |
| Decline an invitation             | `POST /api/v1/invitations/decline` — same module                       |
| Create / suspend / erase an org   | `/api/v1/admin/orgs` — `lib/tenancy/lifecycle.ts`, `erase-org.ts`      |
| Manage an org's members           | `/api/v1/orgs/[id]/members` — `lib/tenancy/lifecycle.ts`               |
| Give an org its data              | `exportOrgData()` — `lib/privacy/export-org.ts`                        |
| Prove it against a real database  | `npm run smoke:tenancy`                                                |
| The migration                     | `prisma/migrations/20260917120000_org_identity/`                       |

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
  // + a back-relation for every tenant-owned model (42 as of §107 t-705):
  //   the four credential relations (see "Credentials") and the 38 the
  //   row-isolation feature added. The relation, not a list, is what lets
  //   eraseOrg() cascade — see "The lifecycle".
  // Then the framework zone and the app zone, empty in Sunrise: a fork's
  // back-relations go below its tier's marker (#859).
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
- **`settings` is one JSON column with five platform-owned keys**, and the
  rest of it is a fork's. `retention` (§108 t-713) holds the retention
  windows this org keeps instead of the platform's, described in
  [Data Retention](../orchestration/retention.md#per-org-windows) and written
  through `PATCH /api/v1/admin/orgs/[id]`. `platformAgents` (§116 t-724) is
  the [platform-agent](../orchestration/platform-agents.md) reconcile's marker:
  the registry digest it last reconciled the org against, and the agents it
  placed there. Only the reconcile writes it, and no route exposes it.
  `providers` (§120 t-742) holds the ids of the AI provider rows a platform
  admin approved the org for, and optionally its jurisdictions, written through
  `PUT /api/v1/admin/orgs/[id]/providers`. Unlike `retention`, an unreadable
  `providers` slice reads as "no provider", not as a default (see
  [LLM providers](../orchestration/llm-providers.md#per-org-approved-providers-core-at-multi)).
  `quotas` (§110 t-788, t-789) holds the org's own caps, `monthlyBudgetUsd`
  and `requestsPerMinute`, written through `PATCH /api/v1/admin/orgs/[id]`
  from the install org only, or by a fork's billing code through
  `writeOrgQuotas()`. An unreadable cap is dropped, leaving the org with no
  cap of its own (see
  [Costs](../admin/orchestration-costs.md#per-org-monthly-budget-cap) and
  [Rate limiting](../security/rate-limiting.md#per-org-request-cap)).
  `privacy` (§127 t-1010) holds the org's LLM privacy floor (`minimumMode`)
  and the names it always protects (`protectedTerms`), written through
  `PUT /api/v1/admin/orgs/[id]/privacy`. Like `providers`, it is read whole
  and fails closed: an unreadable slice refuses the org's every AI call until
  it is saved again (see
  [LLM privacy layer](../privacy/llm-privacy-layer.md#what-is-built-t-1010)).
  `lib/tenancy/org-settings.ts` is the whole of what the platform reads and
  writes there. It **replaces its own slice rather than the object**, in a
  serializable read-modify-write, so a fork's keys, and the other platform
  keys, survive a platform write.
  Two rules follow from the column being shared. A fork adding its own slice
  owns the route that writes it — the platform's PATCH is strict and refuses a
  key it does not know, deliberately, so a typo is a 400 rather than a value
  written and never read. And nothing publishes the raw column to an org
  member: `GET /api/v1/orgs/[id]` returns the validated `retention` slice
  alone, because the platform cannot vouch for what a fork put beside it.

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
records it twice: on better-auth's request state (`lib/auth/pending-signup.ts`),
and on the user row itself as `User.signupOrgId` / `signupOrgRole` — returned
as hook data, so it lands in the same INSERT as the user (t-838).
`userCreateAfterHook` writes it with `writeNewUserMemberships`, first thing:
the memberships and the cleared record in **one transaction**, so either the
membership exists and the record is gone, or neither changed. Like
every other step in that hook the write is **non-blocking** — a failure is
logged at `error` and the signup completes. The reason, verified against
better-auth 1.7.4 after two review rounds disagreed about it: `create.after`
hooks are queued and run only after the sign-up's transaction has resolved,
so the user, the account and (for email sign-up) the session are already
committed when this runs. A throw would not prevent a memberless user; it
would only turn a usable signup into a 500 the person cannot act on. The
invariant is restored on the session path instead: a failed write leaves the
record, and `sessionCreateBeforeHook` heals the user from it at their next
sign-in, into exactly the membership the signup decided, in either mode
(below). The guard resolves a null membership to the install org at `single`
and refuses at `multi` ([context.md](./context.md)). It is deliberately **not** a `registerUserCreatedHook`
contributor: that registry is the fork's seam and runs last; this is a core
invariant and runs first.

**When deciding fails.** The decision reads the invited org's non-staff
member count (for the first-owner bootstrap), and a failure there is logged at
`error` and never blocks the signup. The before hook then records
`undecidedMembershipsForNewUser(user, invitation)`: the invitation's org with
the role it names, default `MEMBER`, plus the install-org floor at `single`,
exactly as the decision would have (t-834, t-836). Only the OWNER bootstrap is
lost, so a failure narrows a role and never widens one. An org left with no
owner is one a platform admin fixes.

**When the request state is missing.** If recording the decision on the
request state failed, or the after hook cannot read it back, the after hook
reads the record on the created row instead (t-838; validated, so a malformed
value is ignored rather than written). Only when that is missing too — a fork
path that creates users without the before hook — does it answer from what
the request still knows (t-836):

| Signup                                                              | `single`                    | `multi`                                |
| ------------------------------------------------------------------- | --------------------------- | -------------------------------------- |
| Password, through an invitation (`runInvitedSignup` still holds it) | invited org + install floor | invited org only                       |
| OAuth (its invitation rode only on the request state)               | install-org default         | **nothing written**, logged at `error` |
| Anything else (uninvited)                                           | install-org default         | install-org default                    |

At `multi` the install org is the vendor's own, so an OAuth signup that might
have been invited is left with no membership rather than put there. The guard
refuses a memberless user at `multi`, and a platform admin adds them through
`POST /api/v1/orgs/[id]/members`.

**The record is not client-settable.** The self-heal writes a membership into
whatever org `signupOrgId` names, so the field is as sensitive as `role`:
both columns are declared `additionalFields` with `input: false` and
`returned: false`, which makes `POST /api/auth/sign-up/email` and
`POST /api/auth/update-user` answer 400 for either.
`tests/unit/lib/auth/config-role-input.test.ts` proves it with better-auth's
own parser over the real options. There is deliberately no FK to `Org`: an
org erased before the user signs in leaves a value the heal checks for and
clears.

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

| The invitation says…                           | The member lands as                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| neither key                                    | install org, by the role rule above on the role it **grants**                 |
| `orgRole` (with or without `orgId: 'install'`) | refused by the route (400) — see below                                        |
| another `orgId`, org already has members       | that org, `orgRole` (default `MEMBER`); at `single`, the install org too      |
| another `orgId`, org has **no members yet**    | that org, `OWNER` — whatever `orgRole` said; at `single`, the install org too |

**An install-org role follows the platform role, here too** (#871). The
members API refuses to edit one, so a role an invitation set there could be
undone only by changing the platform role. The route therefore refuses an
`orgRole` that names no other org, and `membershipForNewUser` ignores one on
an invitation written before it did (a resend drops it).

**At `single`, an invitee into another org is a member of the install org as
well** (#872), by the role rule above on the platform role the invitation
grants. `membershipsForNewUser` decides both. Without it, suspending their org
would lock them out entirely, and the invariant this page opens with would not
hold. Their first session starts in the org they were invited to. A later one
follows [the active org](#the-active-org-which-org-a-session-acts-in) rule,
which starts anyone in several orgs in the install org, the same as every
other single-tenant user who belongs to a second org.

The floor is written at signup, so an account invited into another org before
#872 shipped has none. `npm run db:tenancy:install-floor`
(`backfillInstallMemberships`, t-835) adds it for every user who lacks an
install-org membership, by the same role rule on the stored platform role —
except a user whose signup record survived a failed write (t-838), who gets
what the record decided (the inviting org, with the floor) and loses the
record, as at sign-in. It leaves every existing row alone, writes nothing on a second run, and
refuses at `multi`, for the reason below. A migration cannot do this, because
the mode is in the environment, not the database.

**At `multi` they are not.** There the install org is the vendor's own: it
holds the control plane (every org's usage, the provider policy, the Learn
page), and a customer org's OWNER or ADMIN can invite people into their own
org (`POST /api/v1/orgs/[id]/invitations`). An automatic install-org
membership would let any customer admin make outsiders members of the
vendor's org. And suspending a customer org is meant to lock its members
out.

The last row is the **per-org bootstrap** (`takesFirstOwnership`): an org
nobody owns is one nobody can administer, so **an org's first member who isn't
platform staff** owns it. Staff are a platform `ADMIN` (by the account's role
or by the role the invitation grants) or a SERVICE account.

- **Staff in the org don't count** (#1178). A vendor's staff can be in an org
  as `ADMIN`, preparing it, before its first real person arrives, and that
  person still becomes its owner.
- **Staff never take it.** An org whose only owner is the vendor is not one
  its own people can administer. Staff who should hold `OWNER` are given it
  explicitly.
- **It is not "no `OWNER` yet".** An org can lose its last owner to an erasure
  and keep its ADMINs, and an ADMIN may add members or invite with no role.
  Under "no owner yet" that ADMIN would pick the next owner, their own second
  account included, without the owner standing every explicit `OWNER` grant
  needs. Any non-staff member closes the bootstrap, and a platform admin
  repairs such an org.
- **Its grantor needs owner standing**, as for an explicit `OWNER`: the
  `addMember` actor, or an invitation's issuer (`invitedBy`) **when it is
  accepted** (`hasOwnerStandingIn`). Otherwise an ADMIN could invite a second
  account of theirs, then remove every other non-staff member and leave, and
  the count would be 0 again by acceptance.

Whether an invitation's explicit `orgRole` should win over the bootstrap is a
separate question (#1156). The bootstrap sits beside the install-scoped
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
this route asks about the org itself, so the arm would apply if `withAdminAuth`
admitted an org admin. It does not, and this route stays the platform's: it
sets a platform role and can name any org.

**An org's own OWNER/ADMIN invites through `POST /api/v1/orgs/[id]/invitations`**
(§111 t-813), the route behind the Members page. It has the members routes'
admission (the org `resource`), takes `{ name, email, orgRole? }`, and writes
an invitation into the URL's org as a platform `USER`. It has no platform
role and no `orgId` in its body. `checkInvitationInto()` holds the rules: an
`OWNER` invitation needs owner standing, the install org is refused (invite
there from Users, where the platform role is set), and a suspended org is
refused. Pending invitations are kept **one per (email, org)** (#1199): the
address may hold invitations into several orgs at once, and this route reads,
re-sends and replaces only the URL's org's. Two pending invitations it does
not own refuse it with a `409` that names neither, and are left untouched: one
carrying a platform role or naming no org (the platform's, from Users, which
an existing account could never redeem if this one were accepted first), and
one whose metadata cannot be read (its org is unknown). **An address that
already has an account is invited like any other**: the invitation is stored
and sent, and the answer is the same whether or not the account exists, so an
org admin learns nothing about accounts outside their roster. Only someone
already a member of the org gets a different answer, `409 ALREADY_MEMBER`, and
they are on the roster the caller can read. The email names the inviter and
the org, and asks an existing account to sign in and accept rather than set a
password; see [existing accounts](#accepting-as-an-existing-account).
The named org must exist and be `ACTIVE` _when the invitation
is written_; a missing and a suspended org get the same 400, so the endpoint
leaks nothing about orgs the caller may not administer. Acceptance does not
re-check: an invitation into an org suspended during its 7-day window still
creates the membership, and the member is then refused at entry like every
other member of that org — suspension is enforced where a request enters an
org (the guard — [context.md](./context.md) — and the switch), never by
withholding memberships. A
resend (`?resend=true`) re-sends _this_ invitation: the pending `orgId` /
`orgRole` carry over (an install-org `orgRole` is dropped) unless the body sends either key (then the body's pair
replaces both), and the inherited org goes through the same existence, status and
policy checks. The "already pending" response echoes the pending org keys.
Which pending invitation is _this_ one (#1199): the one in the org the body
names, and with no org named the install org's. Never simply the newest,
which may be another org's. A platform invitation (a platform role, or the
install org) and an org invitation are never written side by side for one
address: a new one of either kind, or a resend that changes the pending one's
kind, is refused with a `409` while the other kind is pending. Whichever is
accepted first creates the account, and the platform one could then never be
redeemed. The org route refuses the same way. The admin table's Resend
and Delete name the row's org for that reason, and Delete revokes only that
org's invitation (`?orgId=`). A caller who is not a platform admin is refused
while any platform-role invitation is pending for the address.
**The platform route invites an existing account into an org too** (t-1008),
so the table's Resend works on an invitation the org route sent to one. An
invitation into another org at the default role is sent as the org route
sends it: the email asks them to sign in, and the answer does not depend on
whether the account exists. Someone already in that org gets `409
ALREADY_MEMBER`. A platform invitation (a platform role, or the install org)
to an address with an account is still `409 EMAIL_TAKEN`, because an existing
account cannot redeem one.

## Accepting as an existing account

An invitation to an address that already has an account cannot be redeemed by
creating one, so its owner signs in and accepts (#1199, t-1006):
`POST /api/v1/invitations/accept` with `{ token, email }`, the rules in
`acceptInvitationAsExistingUser` (`lib/tenancy/accept-invitation.ts`). The
accept page learns which way to go from `GET /api/v1/invitations/metadata`
(`accountExists`, answered only to a valid token).

- **The session must be signed in as the invited address, and it must be
  verified.** The token proves the email arrived; the session proves who is
  acting on it. A session for any other account is refused with `403
INVITATION_WRONG_ACCOUNT`, and the page says who is signed in and offers to
  sign out, rather than redeeming the invitation into the wrong account. An
  unverified address gets `403 EMAIL_NOT_VERIFIED`.
- **Only an org invitation with no platform role.** One that grants a platform
  role, or names no org, is the platform's: it exists to create an account,
  and following a link does not give an existing account a platform role
  (`409 INVITATION_NEEDS_NEW_ACCOUNT`). The password accept route answers an
  address with an account `409 EMAIL_TAKEN` and points it here.
- **The membership follows the new-account rule.** `membershipForNewUser`
  decides the role (the invitation's `orgRole`, default `MEMBER`, and `OWNER`
  by the per-org bootstrap), and `addMember` writes it. The
  inviter's owner standing for an `OWNER` invitation was checked when it was
  issued, and is checked again at acceptance: an `OWNER` invitation whose
  issuer has since lost owner standing lands its invitee as `MEMBER`
  (#1235). An existing user
  already has their install-org floor at `single`, so nothing else is
  written. A suspended org's invitation is accepted as on the new-account
  path, and the member is refused at entry.
- **Only the redeemed invitation is consumed**, after the membership is
  written, so a failure in between leaves it to retry. Someone already a
  member gets `409 ALREADY_MEMBER`, and the moot invitation is deleted. The
  address's invitations into other orgs stay pending; so do they when a new
  account is created from one of them, which then become existing-account
  invitations.
- **Declining needs only the token**: `POST /api/v1/invitations/decline`,
  public, deletes that one invitation. Whoever received the link may turn it
  down without an account.

Acceptance runs in the session's current org like any guarded route, so a
member whose active org is suspended switches to another org first.

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
   membership at all** — the self-heal, logged at `error` because it means the
   signup path failed upstream:

   | The user                                                                                   | `single`                            | `multi`                                                                        |
   | ------------------------------------------------------------------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------ |
   | Signup record set, its org exists (the signup's membership write failed)                   | that membership + install floor     | that membership — the inviting org, or the install org for an uninvited signup |
   | Signup record names an org that no longer exists                                           | record cleared; install-org default | record cleared; **nothing written**                                            |
   | No record (a fork created the row by hand, or left with no org by `eraseOrg` or a removal) | install-org default                 | **nothing written**                                                            |

   The record is cleared in the same transaction that writes the membership,
   so a set record means only "the signup's write never landed" — a user
   whose membership was written and later removed has none, and is never put
   back (t-838). Any other membership write **pays** a surviving record
   first: `addMember`, `createOrg` with an owner and
   `syncInstallMembershipRole` each call `healSignupRecord()`, which grants
   what the record decided (the inviting org, with the floor at `single`)
   and clears it in the caller's transaction — so neither is the invitation
   lost, nor can a later removal heal it back. A fork writing `OrgMembership`
   rows directly should call it too.

   **At `multi`, a user with no record is refused** (t-836, owner ruling
   2026-10-17; kept by t-838). The session starts with no org, the guard
   refuses it, and the event is logged at `error`. The install org is the
   vendor's own, and none of those users belongs there by default: a member
   whose org was erased should be invited somewhere, not moved into the
   vendor's org. A platform admin adds them through
   `POST /api/v1/orgs/[id]/members`.

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
- **An org's first non-staff member becomes OWNER** when no role is asked
  for — the same bootstrap as an invitation (`takesFirstOwnership`, shared
  with `membershipForNewUser`). It needs an actor with owner standing, so an
  org ADMIN never triggers it. Unlike the invitation path, an explicit role on
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
- **An invitation is held to the same rules before it is sent**
  (`checkInvitationInto`, t-813): an `OWNER` invitation needs owner standing,
  and the install org and a suspended org (`ORG_NOT_ACTIVE`) take none from
  the org route. An invitation outlives that check, so acceptance asks the
  issuer's (`invitedBy`) standing again: an `OWNER` invitation whose issuer
  has since been demoted or removed confers `MEMBER`, not `OWNER` (#1235).
  It narrows rather than refuses, so the invitee still joins the org that
  invited them and the signup hooks never block; an owner can promote them.
  One edge follows: a sole owner who hands over by `OWNER` invitation and
  then erases their account before it is accepted leaves the org with no
  owner. The invitee lands as `MEMBER`, and a platform admin grants `OWNER`
  on the members route. Erasure does not yet hold to the last-owner rule.
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

**The interim rows.** The column landed in `20260917120000_org_identity`
(0.13.0 — no release before it carried the column), backfilled once, and nothing wrote it at mint until t-673 — so every
credential minted in between carried `orgId = NULL`. Both migrations ship in
0.13.0, so an install upgrading from a release applies them together and
never holds such a row; only a deployment tracking `main` between them could. At `single` the read
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
  (principle 4), in the exact shape every core model uses:

  ```prisma
  orgId String?
  org   Org?    @relation(fields: [orgId], references: [id], onDelete: Cascade)

  @@index([orgId])
  ```

  plus a back-relation line on `Org`, in your tier's zone at the end of the
  model: the framework zone for a framework fork, the app zone for a leaf
  (`prisma format` puts a leaf's there). Sunrise never edits below the first
  marker, so the line merges cleanly and is not a divergence (#859; CUSTOMIZATION.md §5,
  "Relating your models to `Org` and `User`"). `Cascade` is the rule for data that is
  the org's; a retained record (a billing row — `AiCostLog` is the one core
  case) uses `onDelete: SetNull` instead, per the FK rule in `CLAUDE.md`.
  `tests/unit/lib/tenancy/model-classification.test.ts`
  names every model that is neither tenant-owned nor classified system, shared
  settings or user-owned (core's lists in `lib/tenancy/classification.ts`, a
  fork's through `lib/app/tenancy-classification.ts`) until it is classified, and `tests/unit/lib/privacy/org-sources.test.ts`
  names every `orgId` model until `lib/privacy/org-sources.ts` says what an
  org receives from it. Never delete from an allowlist to go green.

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
  logged at error while the signup still completes; the before hook's data
  carries the signup record, and the after hook writes the memberships and
  clears it in one transaction, falling back to the row's record when the
  request state is lost (t-838).
- `tests/unit/lib/tenancy/membership.test.ts` — `membershipForNewUser`'s
  table above and `activeOrgForSession`'s four arms, including that the
  self-heal writes for a memberless user and for nobody else; that a signup
  record heals an invitee into the inviting org at `multi` and never the
  install org, a record naming a gone org is cleared, and no record writes
  nothing at `multi` (t-838); and `undecidedMembershipsForNewUser` in both
  modes.
- `tests/unit/lib/auth/config-role-input.test.ts` — `role`, `signupOrgId` and
  `signupOrgRole` are not client-settable on sign-up or update, each with the
  control that shows the assertion doing work.
- `tests/unit/lib/auth/config-session-hook.test.ts` — the session hook's
  order (a signup in flight wins and reads nothing) and its failure shape.
- `tests/unit/lib/auth/config-session-field.test.ts` — `activeOrgId` is not
  client-settable, with the control that shows the assertion doing work.
- `tests/unit/app/api/v1/orgs/switch/route.test.ts` — the switch through the
  real guard: row + cookie, non-enumerating refusals, API keys refused.
- `tests/unit/app/api/v1/users/invite/route.test.ts` — an invitation without
  an org writes metadata byte-identical to before; one with an org asks the
  policy; an existing account's org invitation re-sends (that org's only, the
  same answer either way) while a platform one to it is still refused.
- `tests/unit/auth-role-literals.test.ts` — no bare `'OWNER'` / `'MEMBER'`
  outside `lib/tenancy/roles.ts`, the way it already polices `'ADMIN'`.

## Related

- [Tenant context](./context.md) — how a request enters the org it acts
  for, and what reads it
- [Support access](./support-access.md) — an org's consent for vendor support
  to act inside it, and its rules
- [Multi-tenancy design record](../architecture/multi-tenancy-design.md) —
  the decisions and principles this page applies
- [Multi-tenancy playbook](../architecture/multi-tenancy.md) — enabling
  the capability, and what a fork adds for its own models
- [Authorization](../auth/authorization.md) — the policy that reads the org
  role
- [Data erasure](../privacy/data-erasure.md) · [Subject access](../privacy/data-export.md)
  — the dispositions `OrgMembership` and `Org` carry
