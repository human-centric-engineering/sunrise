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

| Route                                      | Guard           | Admitted                                                                                                                                               |
| ------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/v1/orgs`                         | `withAuth`      | Any signed-in user (their own memberships). Does **not** enter the session's org.                                                                      |
| `POST /api/v1/orgs/switch`                 | `withAuth`      | Any member of the target org, browser session only. Does **not** enter the session's org.                                                              |
| `GET /api/v1/orgs/[id]`                    | `withAuth`      | Any member of that org (keyed on the caller's own membership).                                                                                         |
| `GET/POST /api/v1/orgs/[id]/members`       | `withAuth`      | The org's OWNER/ADMIN **while acting in it**, or a platform admin — the policy's org arm. Browser session only (`GET` included: the roster is people). |
| `PATCH/DELETE …/members/[userId]`          | `withAuth`      | As above. Granting `OWNER`, or changing / removing an `OWNER`, needs an OWNER (or platform admin).                                                     |
| `GET/POST /api/v1/admin/orgs`              | `withAdminAuth` | Platform admins.                                                                                                                                       |
| `GET/PATCH/DELETE /api/v1/admin/orgs/[id]` | `withAdminAuth` | Platform admins.                                                                                                                                       |
| `GET /api/v1/admin/orgs/[id]/export`       | `withAdminAuth` | Platform admins; per-admin sub-cap.                                                                                                                    |

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
    "memberCount": 4,
    "role": "MEMBER",
    "joinedAt": "…"
  }
}
```

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
  that the first member of an **empty** org becomes `OWNER` when no role is
  asked for (the invitation path's bootstrap). `OWNER` needs OWNER standing.
  On the install org a `role` is refused: roles there follow the platform role.

Adding by id enrols the user without asking them — it mirrors the platform
admin naming an owner at creation, and the org's administrators already see
the roster. The consenting path is an invitation (`POST /api/v1/users/invite`
with `orgId`), which the invitee accepts. The `404` for an unknown id confirms
only that a cuid — unguessable — does not name a user.

**Response** (201 Created): the membership row.

**Error Responses**: `400` with code `INSTALL_ORG_MEMBERSHIP` (a role on the
install org) · `403 OWNER_STANDING` · `404 USER_NOT_FOUND` · `409 ALREADY_MEMBER`.

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

The org row plus `members` in the roster shape above. `404 ORG_NOT_FOUND`.

### Rename, re-slug, suspend, reinstate

```
PATCH /api/v1/admin/orgs/[id]
```

**Request Body** (`updateOrgSchema`, at least one key):

```json
{ "name": "Acme Ltd", "slug": "acme-ltd", "status": "SUSPENDED" }
```

Suspension writes only the status: members are not signed out, the guard
refuses their next request into the org, and the switch is their way to
another org. Reinstating is `{ "status": "ACTIVE" }`.

**Error Responses**: `400 INSTALL_ORG_IMMUTABLE` (the install org can be
renamed but never suspended or re-slugged) · `409 SLUG_TAKEN` ·
`404 ORG_NOT_FOUND`.

### Export an org's data

```
GET /api/v1/admin/orgs/[id]/export
```

The bundle `exportOrgData()` builds — see
[Org Data Export](../privacy/org-export.md). Served as a download
(`Content-Disposition: attachment`), never cached, under the same per-admin
sub-cap as the subject export. `404` for a missing org.

### Erase an org

```
DELETE /api/v1/admin/orgs/[id]
```

Calls `eraseOrg()` — see [Org Erasure](../privacy/org-erasure.md). The org,
its memberships, its credentials and its pending invitations go; its members'
accounts stay.

**Response** (200 OK):

```json
{
  "success": true,
  "data": {
    "orgId": "cmorg…",
    "erasedAt": "…",
    "members": 3,
    "pendingInvitations": 0,
    "sessionsCleared": 2
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
