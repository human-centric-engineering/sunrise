# Org Endpoints

The organisation API (§106). Two views, decided by the authorization policy
rather than by URL:

- **The member view** under `/api/v1/orgs` — what a person may do with the
  orgs they belong to. `withAuth`; the org's own OWNER/ADMIN administer its
  members through the policy's org arm.
- **The platform view** under `/api/v1/admin/orgs` — the vendor's acts:
  create, rename, suspend, export, delete. `withAdminAuth`, platform admins
  only. See the control-plane split in
  [`multi-tenancy.md`](../architecture/multi-tenancy.md#the-control-plane-which-admin-surfaces-are-whose).

Every rule the routes enforce — the install org's immutability, the
last-OWNER guard, the install org's roles following the platform role — lives
in `lib/tenancy/lifecycle.ts`, and every refusal from it carries a `code` in
the error envelope alongside the message.

All responses use the standard envelope (`{ success, data }` /
`{ success: false, error: { code, message } }`). Rate limits are the section
tier (`/api/v1/**` 100/min per user; `/api/v1/admin/**` the admin tier), plus
the per-admin export sub-cap noted below.

## Who may call what

| Route                                       | Guard           | Admitted                                                                                                                                               |
| ------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/v1/orgs`                          | `withAuth`      | Any signed-in user (their own memberships). Does **not** enter the session's org.                                                                      |
| `POST /api/v1/orgs/switch`                  | `withAuth`      | Any member of the target org, browser session only. Does **not** enter the session's org.                                                              |
| `GET /api/v1/orgs/[id]`                     | `withAuth`      | Any member of that org (keyed on the caller's own membership).                                                                                         |
| `GET/POST /api/v1/orgs/[id]/members`        | `withAuth`      | The org's OWNER/ADMIN **while acting in it**, or a platform admin — the policy's org arm. Browser session only (`GET` included: the roster is people). |
| `PATCH/DELETE …/members/[userId]`           | `withAuth`      | As above. Granting `OWNER`, or changing / removing an `OWNER`, needs an OWNER (or platform admin).                                                     |
| `GET /api/v1/orgs/[id]/audit-log`           | `withAuth`      | As the roster: the org's OWNER/ADMIN while acting in it, or a platform admin. Browser session only (every row names a person).                         |
| `POST /api/v1/orgs/[id]/invitations`        | `withAuth`      | As above. Inviting as `OWNER` needs an OWNER (or platform admin). Not the install org. Per-IP invite sub-cap.                                          |
| `POST /api/v1/invitations/accept`           | `withAuth`      | A session signed in as the invited, verified address; browser session only. Per-IP accept-invite sub-cap.                                              |
| `POST /api/v1/invitations/decline`          | none            | Whoever holds the invitation token. Per-IP accept-invite sub-cap.                                                                                      |
| `GET/POST /api/v1/admin/orgs`               | `withAdminAuth` | Platform admins.                                                                                                                                       |
| `GET/PATCH/DELETE /api/v1/admin/orgs/[id]`  | `withAdminAuth` | Platform admins.                                                                                                                                       |
| `GET /api/v1/admin/orgs/[id]/export`        | `withAdminAuth` | Platform admins; per-admin sub-cap.                                                                                                                    |
| `GET/PUT /api/v1/admin/orgs/[id]/providers` | `withAdminAuth` | Platform admins.                                                                                                                                       |
| `GET/PUT /api/v1/admin/orgs/[id]/privacy`   | `withAdminAuth` | Platform admins.                                                                                                                                       |

"While acting in it" is t-671's rule: the policy compares the org the guard
_entered_ for the request — the session's active org, or the proxy's
resolver header — with the org the URL names. An org ADMIN of X acting in the
install org gets `403 Access denied` on `/orgs/X/members`; they switch first.
A MEMBER, a non-member and a caller naming an org that does not exist get the
same 403 — nothing enumerates. An API key of any scope is refused on every
members route: a key is narrower than its owner, and no scope means "manage
the org" — an `admin` key is a platform credential and uses the platform view.

**OWNER standing.** An org ADMIN administers the roster — MEMBERs and other
ADMINs — but may not grant `OWNER` (to anyone, themself included), change an
OWNER's role, or remove an OWNER: `403 OWNER_STANDING`. Only an OWNER, or a
platform admin, may. Without this the last-OWNER guard would protect the
_count_ of owners while a delegate rewrote _who_ they are in two requests.

## Member view

### List my orgs

```
GET /api/v1/orgs
```

**Response** (200 OK):

```json
{
  "success": true,
  "data": {
    "activeOrgId": "install",
    "orgs": [
      {
        "id": "install",
        "slug": "install",
        "name": "Default organisation",
        "status": "ACTIVE",
        "role": "OWNER",
        "joinedAt": "2026-09-17T12:00:00.000Z",
        "active": true
      }
    ]
  }
}
```

`activeOrgId` is the org the guard would enter for this request, in the entry
rule's precedence: the proxy's resolver header if a fork registered one, else
the stored pointer, else the install org at `single` and `null` at `multi`. Suspended orgs are listed with their status rather than hidden — a
member whose active org was suspended is refused everywhere else, and this
list is how they find the org to switch to.

### Switch active org

✅ **Implemented in:** `app/api/v1/orgs/switch/route.ts`

**Purpose**: Change the org the current session acts in. The session's
`activeOrgId` is chosen at sign-in; this is the one way to change it afterwards.

```
POST /api/v1/orgs/switch
```

**Authentication**: Required (browser session — an API-key caller is refused,
because a credential's org is fixed at mint)

**Request Body**:

```json
{ "orgId": "install" }
```

**Validation**: `switchOrgSchema` from `lib/validations/tenancy.ts` —
`orgId` required, non-empty; the caller must be a member.

**Response** (200 OK) — also re-issues the session cookie cache so the next
request reads the new org:

```json
{
  "success": true,
  "data": {
    "activeOrgId": "install",
    "org": { "id": "install", "slug": "install", "name": "Default organisation" }
  }
}
```

**Error Responses**:

- **400 Validation Error**: Missing or empty `orgId`
- **401 Unauthorized**: Not authenticated
- **403 Forbidden**: Not a member of that org (the same answer whether the org
  exists or not), the org is suspended, or the caller is an API key

### One org, as a member

```
GET /api/v1/orgs/[id]
```

**Response** (200 OK):

```json
{
  "success": true,
  "data": {
    "id": "cmorg…",
    "slug": "acme",
    "name": "Acme",
    "status": "ACTIVE",
    "createdAt": "…",
    "settings": { "retention": { "executionRetentionDays": 365 } },
    "memberCount": 4,
    "role": "MEMBER",
    "joinedAt": "…"
  }
}
```

`settings.retention` is the org's own retention windows, `null` when it has set
none and is on every global window (§108 t-713 — see
[Data Retention](../orchestration/retention.md#per-org-windows)). **Only that
slice is published here**, not the `Org.settings` column: this route is readable
by every MEMBER, a fork keeps its own org config in the same JSON, and the
platform can only vouch for the key it owns. The whole column is on the
platform-admin view below. A window whose stored value cannot be read is
reported as absent, exactly as the sweep treats it.

- **403 Forbidden** `Access denied`: not a member, or no such org.

### The roster

```
GET /api/v1/orgs/[id]/members
```

**Response** (200 OK):

```json
{
  "success": true,
  "data": {
    "orgId": "cmorg…",
    "members": [
      {
        "id": "cm…",
        "name": "Jane",
        "email": "jane@acme.example",
        "image": null,
        "role": "OWNER",
        "joinedAt": "…"
      }
    ]
  }
}
```

### Add a member

```
POST /api/v1/orgs/[id]/members
```

**Request Body** (`addOrgMemberSchema`):

```json
{ "userId": "cm…", "role": "MEMBER" }
```

- `userId`: required, an existing user's id (cuid). The seeded SERVICE account
  is refused as if missing.
- `role`: optional, `OWNER` / `ADMIN` / `MEMBER`. Default `MEMBER` — except
  that, when no role is asked for, the org's **first member who isn't
  platform staff** becomes `OWNER` (the invitation path's bootstrap; staff
  already in the org don't stop it, #1178, and any non-staff member, an ADMIN
  included, does), when the caller holds owner standing. `OWNER` needs OWNER
  standing.
  On the install org a `role` is refused: roles there follow the platform role.

Adding by id enrols the user without asking them — it mirrors the platform
admin naming an owner at creation, and the org's administrators already see
the roster. The consenting path is an invitation, which the invitee accepts:
`POST /api/v1/orgs/[id]/invitations` below, or the platform's
`POST /api/v1/users/invite` with `orgId`. The `404` for an unknown id confirms
only that a cuid — unguessable — does not name a user.

**Response** (201 Created): the membership row.

**Error Responses**: `400` with code `INSTALL_ORG_MEMBERSHIP` (a role on the
install org) · `403 OWNER_STANDING` · `404 USER_NOT_FOUND` · `409 ALREADY_MEMBER`.

### Invite someone into the org

```
POST /api/v1/orgs/[id]/invitations
POST /api/v1/orgs/[id]/invitations?resend=true
```

The org's own invitation (§111 t-813), behind the Members page. Same admission
as the members routes. The invitee joins this org on acceptance, as a platform
`USER`.

**An address that already has an account is invited the same way** (#1199).
The answer does not depend on whether the account exists. The email asks an
existing account to sign in and accept (`POST /api/v1/invitations/accept`)
rather than set a password. Pending invitations are kept one per (email, org),
so an invitation into another org neither blocks this one nor is touched by
it. See [identity.md](../tenancy/identity.md#accepting-as-an-existing-account).

**Request Body** (`inviteOrgMemberSchema`):

```json
{ "name": "Ada", "email": "ada@example.com", "orgRole": "ADMIN" }
```

- `orgRole`: optional, default `MEMBER` on acceptance. `OWNER` needs OWNER
  standing.
- No platform `role` and no `orgId`. A `role` key is dropped.
- `?resend=true` re-issues this org's pending invitation. It keeps the
  pending `orgRole` unless the body names one. Replacing a pending `OWNER`
  invitation needs OWNER standing, whatever role the body sends.

**Response** (201 Created): `{ message, invitation: { email, name, orgId,
orgRole, invitedAt, expiresAt }, emailStatus }`. That is the platform route's
shape without `role` and **without `link`**. The token in the link is all
`accept-invite` asks for before it creates a verified account with a
password the caller chooses. An inviter who held it could therefore open an
account for an address they do not own. It goes to the invitee by email only. If
`emailStatus` is not `sent`, the invitation is stored, and a platform admin
re-sends it from Users. A platform resend keeps the pending org. If an invitation into this org is already
pending, the answer is `200` with `emailStatus: "pending"` and no link. Send
`?resend=true` to issue a new token.

**Error Responses**: `400 INSTALL_ORG_MEMBERSHIP` (invite into the install org
from Users) · `400 ORG_NOT_ACTIVE` (suspended) · `403 OWNER_STANDING` ·
`409 ALREADY_MEMBER` (already a member of this org) · `409 CONFLICT` (a
platform invitation for this email is pending, carrying a platform role or
naming no org, or one this route cannot read; it is left untouched and not
named) · `429` (invite sub-cap).

### Accept or decline an invitation

```
POST /api/v1/invitations/accept    { token, email }   — signed in, browser session
POST /api/v1/invitations/decline   { token, email }   — public, token-gated
```

**Accept** is for an address that already has an account (#1199). The session
must be signed in as the invited address, verified. The membership follows the
new-account rule (the invitation's `orgRole`, default `MEMBER`, and `OWNER` for
the org's first non-staff member). Only that invitation is consumed.
**Response** (200): `{ message, membership: { orgId, role } }`.
**Errors**: `403 INVITATION_WRONG_ACCOUNT` (signed in as another address) ·
`403 EMAIL_NOT_VERIFIED` · `404` (no such invitation, or already used) ·
`409 ALREADY_MEMBER` (the moot invitation is deleted) ·
`409 INVITATION_NEEDS_NEW_ACCOUNT` (a platform invitation, which only creates
an account) · `410 INVITATION_EXPIRED` · `429` (accept-invite sub-cap).

**Decline** deletes only the invitation the token names, expired or not, and
needs no session. **Errors**: `404` · `429`.

### Change a member's role

```
PATCH /api/v1/orgs/[id]/members/[userId]
```

**Request Body** (`updateOrgMemberSchema`): `{ "role": "ADMIN" }`.

**Error Responses**: `403 OWNER_STANDING` (an ADMIN granting `OWNER` or
touching an OWNER) · `400 LAST_OWNER` (demoting the org's only OWNER — make
another member an owner first) · `400 INSTALL_ORG_MEMBERSHIP` (the install
org: change the user's platform role instead) · `404 NOT_A_MEMBER`.

### Remove a member

```
DELETE /api/v1/orgs/[id]/members/[userId]
```

Removes the membership and revokes that user's sessions acting in this org;
their sessions in other orgs are untouched. Removing an OWNER needs OWNER
standing, and an OWNER may remove themselves only while another OWNER stands.

**Response** (200 OK):

```json
{
  "success": true,
  "data": { "orgId": "cmorg…", "userId": "cm…", "removed": true, "revokedSessions": 1 }
}
```

**Error Responses**: `403 OWNER_STANDING` · `400 LAST_OWNER` ·
`400 INSTALL_ORG_MEMBERSHIP` (a user leaves the install org by having their
account deleted) · `404 NOT_A_MEMBER`.

### The org's admin history

```
GET /api/v1/orgs/[id]/audit-log?page=&limit=&userId=&entityType=
```

The admin audit rows belonging to this org, newest first (t-1005): its
members' actions, support's, and the vendor's changes to the org. `limit`
defaults to 50, max 100. `userId` narrows to one person; `entityType` is a
comma-separated list (at most 20) narrowing to those entity types. Which rows
belong to the org, what each holds, what it leaves out and why, is in
[the audit log guide](../admin/orchestration-audit-log.md#the-org-a-row-was-made-in).

**Response** (200 OK, paginated):

```json
{
  "success": true,
  "data": [
    {
      "id": "cm…",
      "action": "agent.update",
      "entityType": "agent",
      "entityId": "cm…",
      "entityName": "Support bot",
      "changes": { "name": { "from": "Old", "to": "New" } },
      "metadata": null,
      "createdAt": "…",
      "actor": { "id": "cm…", "name": "Jane" },
      "support": null
    }
  ],
  "meta": { "page": 1, "limit": 50, "total": 1, "totalPages": 1 }
}
```

`support` is `{ grantId }` on a row made in a support session (`grantId` is
null once the grant has gone), and `null` otherwise.

**Error Responses**: `403` for an API key, a MEMBER, a caller acting in another
org, or no such org.

## Platform view

### List every org

```
GET /api/v1/admin/orgs
```

**Response** (200 OK) — one enriched read; `ownerCount: 0` flags an org
nobody can administer (an OWNER erased their account, say):

```json
{
  "success": true,
  "data": {
    "orgs": [
      {
        "id": "install",
        "slug": "install",
        "name": "…",
        "status": "ACTIVE",
        "createdAt": "…",
        "updatedAt": "…",
        "memberCount": 12,
        "ownerCount": 2
      }
    ]
  }
}
```

### Create an org

```
POST /api/v1/admin/orgs
```

**Request Body** (`createOrgSchema`):

```json
{ "slug": "acme", "name": "Acme", "ownerUserId": "cm…" }
```

- `slug`: required, lowercase alphanumeric with hyphens, unique, ≤100.
- `name`: required, ≤200.
- `ownerUserId`: optional. Names the founding `OWNER` in the same write —
  prefer it; an org created without one is administered by platform admins
  until a member is made OWNER, and its first invitee or added member
  becomes OWNER by the bootstrap rule.

**Response** (201 Created): the org row.

**Error Responses**: `409 SLUG_TAKEN` · `404 USER_NOT_FOUND`.

### One org, with its roster

```
GET /api/v1/admin/orgs/[id]
```

The org row plus `members` in the roster shape above, and the whole `settings`
column — a fork's own keys included, which is the difference from the member
view. `404 ORG_NOT_FOUND`.

### Rename, re-slug, suspend, reinstate, set retention windows

```
PATCH /api/v1/admin/orgs/[id]
```

**Request Body** (`updateOrgSchema`, at least one key):

```json
{
  "name": "Acme Ltd",
  "slug": "acme-ltd",
  "status": "SUSPENDED",
  "settings": { "retention": { "executionRetentionDays": 365, "costLogRetentionDays": null } }
}
```

Suspension writes only the status: members are not signed out, the guard
refuses their next request into the org, and the switch is their way to
another org. Reinstating is `{ "status": "ACTIVE" }`.

`settings.retention` sets this org's own retention windows (§108 t-713).
`settings` and `retention` are both **strict**, so an unknown key inside either
is a 400 rather than a value written and silently ignored. The **top level** is
not: like every other body in this API it strips what it does not know, so a
misspelled `settngs` renames the org and drops the retention write without
saying so. The five keys are `webhookRetentionDays`,
`webhookDlqRetentionDays`, `costLogRetentionDays`, `executionRetentionDays` and
`evaluationRetentionDays`; a key omitted inherits the global window, and `null`
carries whatever `null` means for that column globally — keep forever for four
of them, and "use the webhook window" for `webhookDlqRetentionDays`, whose
fallback predates this. A slice is stored and returned in both tenancy modes
but **applied at `multi` only**. The write **replaces** the `retention`
slice and preserves every other key in `settings`;
`{ "settings": { "retention": null } }` removes the slice.
[Data Retention](../orchestration/retention.md#per-org-windows) has the
precedence rules and why `auditLogRetentionDays` is not among them. Platform
admin only for now — the org-admin console is §111.

**Error Responses**: `400 INSTALL_ORG_IMMUTABLE` (the install org can be
renamed but never suspended or re-slugged) · `400 VALIDATION_ERROR` (a
malformed slice, or a cost-log window shorter than the execution window the org
would be left with once the global row is inherited) · `409 SLUG_TAKEN` ·
`404 ORG_NOT_FOUND`.

### Export an org's data

```
GET /api/v1/admin/orgs/[id]/export
```

The bundle `exportOrgData()` builds — see
[Org Data Export](../privacy/org-export.md). Served as a download
(`Content-Disposition: attachment`), never cached, under the same per-admin
sub-cap as the subject export. `404` for a missing org.

### An org's approved providers

```
GET /api/v1/admin/orgs/[id]/providers
PUT /api/v1/admin/orgs/[id]/providers
```

Which AI providers the org may use at `TENANCY_MODE=multi` (§120 t-742). A
`PUT` replaces the whole policy, `{ approved: string[], jurisdictions: string[] | null }`
(`jurisdictions` is required: `null` lifts the restriction, and leaving it out is a 400),
and writes an `org.providers.replace` audit row. `[]` revokes every grant.
A `PUT` that changes the policy then reconciles the org's platform agents, so
a clean-up agent whose provider the platform picks moves at once to what the
new policy allows (t-798). That is a shortcut: the maintenance job re-picks
such a binding whenever it drifts, so a reconcile failure, or a suspended org,
is caught up there, and the `PUT` succeeds either way.
Both return `{ orgId, unrestricted, enforced, approved, jurisdictions }`, each
grant in `approved` as `{ id, slug }`: the grant is stored as the provider row's
id, so it survives a rename, and `slug` is `null` if the row was deleted. See
[LLM providers → Per-org approved providers](../orchestration/llm-providers.md#per-org-approved-providers-core-at-multi)
for what it governs.

**Error Responses**: `400 VALIDATION_ERROR` (an unknown provider slug, named
in `details.unknownProviders`, with the message also as
`details.errors: [{ path: 'approved', message }]` so a form reads it like any
validation error; or a malformed body) · `400 INSTALL_ORG_IMMUTABLE`
(a `PUT` naming the install org, which may use every provider) ·
`404 ORG_NOT_FOUND` · `409 CONFLICT` (another write to the org's settings
landed at the same time; nothing was written, so retry).

### An org's LLM privacy settings

```
GET /api/v1/admin/orgs/[id]/privacy
PUT /api/v1/admin/orgs/[id]/privacy
```

The org's privacy floor and the names it always protects (§127 t-1010). A
`PUT` replaces both: `{ minimumMode, protectedTerms }`, where `minimumMode` is
`detect`, `pseudonymise`, `redact`, `block` or `null` (none), and
`protectedTerms` is a list of `{ value, type }` with `type` `PERSON` or `ORG`
and `value` 3 to 200 characters, at most 500, the same name twice (ignoring
case) kept once. Both keys are required, so a replace cannot drop one by
leaving it out. It writes an `org.privacy.replace` audit row with the floor
and how many terms it replaced, never the names.

Both return `{ orgId, saved, unreadable, minimumMode, protectedTerms }`.
`saved` is false until the org first saves, which is when the org page
suggests its own name as a term. `unreadable` is true when the stored slice
does not parse: the privacy layer then refuses every AI call made for the
org until it is saved again. The floor only raises the mode a call runs
under, and both apply from the next chat turn or workflow step. See
[LLM privacy layer → What is built (t-1010)](../privacy/llm-privacy-layer.md#what-is-built-t-1010).

**Error Responses**: `400 VALIDATION_ERROR` (a missing key, `off` as the
floor, a term too short or of another type, an unknown key) ·
`404 ORG_NOT_FOUND` · `409 CONFLICT` (another write to the org's settings
landed at the same time; nothing was written, so retry).

### Erase an org

```
DELETE /api/v1/admin/orgs/[id]
```

Calls `eraseOrg()` — see [Org Erasure](../privacy/org-erasure.md). The org,
its memberships, its credentials and its pending invitations go; its members'
accounts stay. After the transaction commits, the org's storage prefix
(`orgs/{id}/`) is deleted, best-effort: `storageSwept` is `true` when that
worked, `false` when the provider failed (the org is still erased), and `null`
when no storage is configured.

**Response** (200 OK):

```json
{
  "success": true,
  "data": {
    "orgId": "cmorg…",
    "erasedAt": "…",
    "members": 3,
    "pendingInvitations": 0,
    "sessionsCleared": 2,
    "storageSwept": true
  }
}
```

**Error Responses**: `400 INSTALL_ORG_IMMUTABLE` · `404 ORG_NOT_FOUND`.

## Related Documentation

- [Tenancy: Org Identity](../tenancy/identity.md) — the model, the install-org invariant, the lifecycle rules
- [Tenancy: Context](../tenancy/context.md) — which org a request acts in, and why "acting in it" is the precondition
- [Authorization](../auth/authorization.md#the-org-input) — the org arm these routes rely on
- [Org Data Export](../privacy/org-export.md) · [Org Erasure](../privacy/org-erasure.md)
- [Authentication Endpoints](./auth-endpoints.md) — invitations, which can name an org
