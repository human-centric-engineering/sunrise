# API Key Self-Service

Per-user API keys for programmatic access as an alternative to session-based authentication.

## Key Format

- Generated: `sk_<64 hex chars>` (e.g. `sk_a1b2c3d4...`)
- Stored: SHA-256 hash only — raw key returned exactly once at creation
- Display: First 8 chars stored as `keyPrefix` for identification

## Scopes

| Scope       | Grants Access To                         |
| ----------- | ---------------------------------------- |
| `chat`      | Consumer chat endpoints                  |
| `analytics` | Analytics API endpoints                  |
| `knowledge` | Knowledge base query endpoints           |
| `webhook`   | Webhook trigger endpoints                |
| `admin`     | All endpoints (implies all other scopes) |

The `admin` scope acts as a wildcard — `hasScope(scopes, anyScope)` returns true if `admin` is present.

### Fork-owned scopes (`lib/app/api-key-scopes.ts`)

The table above is the **core** list. A fork adds its own:

```ts
// lib/app/api-key-scopes.ts — ships empty
export const APP_API_KEY_SCOPES: readonly string[] = ['capture'];
```

`lib/auth/api-key-scopes.ts` unions core with these, and `createApiKeySchema` validates against the same union — so the name becomes mintable and checkable with no core edit (#542). Names are lower snake_case (`/^[a-z][a-z0-9_]{0,31}$/`) and must not collide with a core scope; a malformed or colliding entry is dropped with a logged error rather than widening the allowlist `POST /api/v1/user/api-keys` issues against.

The scope vocabulary lives in its own module, separate from `lib/auth/api-keys.ts`, because `api-keys.ts` imports Prisma and `createApiKeySchema` (in `lib/validations/orchestration.ts`) is imported by `'use client'` admin forms.

### Enforcing a scope

`withAuth` accepts an API key of **any** scope by default. A scope only means something when a route requires one:

```ts
export const POST = withAuth(handler, { scope: 'capture' });
```

- Applies to **API-key callers only**. A browser session is the full user; gating it on a scope would lock a person out of their own page.
- `admin` satisfies any scope, per `hasScope`.
- The 403 names the scope the route wants and never the ones the key holds — a 403 should not be a scope-enumeration oracle.
- **Opt-in per route, and no core route sets it yet.** Adding a requirement to a shipped endpoint would revoke access from keys that work today. Set it on new routes and on your own.

Without both halves the seam is cosmetic: a wider scope list on its own is just labels, because the key still reaches every authenticated route as its owner.

## User Endpoints

All endpoints require session auth (`withAuth`). Users can only manage their own keys.

### `GET /api/v1/user/api-keys`

List the current user's API keys (without raw key values).

Returns: `{ keys: [{ id, name, keyPrefix, scopes, lastUsedAt, expiresAt, revokedAt, createdAt }], availableScopes: string[] }`

`availableScopes` is core plus whatever `lib/app/api-key-scopes.ts` declared — sourced from the same function `POST` validates against, so a key UI cannot drift from what the API will accept. Sunrise ships no self-service key UI; this exists so a fork's does not have to restate the list.

### `POST /api/v1/user/api-keys`

Create a new API key. The raw key is returned in the response — store it securely, it cannot be retrieved again.

**Requires a browser session** — as does `DELETE /api/v1/user/api-keys/:keyId`. A caller who authenticated with an API key gets a 403 from both: minting a credential over a credential is privilege laundering — a key scoped to one narrow job could mint a `chat` key and reach every authenticated route as its owner, so the narrow scope it was issued with would bound nothing. Revocation is destructive rather than escalating, but `GET` returns every key's id, so a leaked `chat`-scoped key could otherwise enumerate its owner's keys and revoke all of them, `admin` included. Same refusal, and the same reasoning, as `PATCH /api/v1/users/me` (email) and `GET /api/v1/users/me/export`.

No legitimate flow loses anything: a headless rotate-and-revoke script needs `POST` too.

Body:

```json
{
  "name": "My CI Key",
  "scopes": ["chat", "analytics"],
  "expiresAt": "2026-12-31T23:59:59Z"
}
```

Returns (201):

```json
{
  "key": {
    "id": "...",
    "name": "My CI Key",
    "keyPrefix": "sk_a1b2c",
    "scopes": ["chat", "analytics"],
    "orgId": "install",
    "rawKey": "sk_a1b2c3d4e5f6..."
  }
}
```

### Org binding (§106)

A key is bound at mint to the org the request was acting in — the session's
active org, or the resolver header's — and never to one named in the body:
you cannot mint into an org you are not in. `orgId` is returned at creation
and in the list. On every later request the guards enter that org for the
key (`enterApiKeyOrg`, [`tenancy/context.md`](../tenancy/context.md)), and a
key cannot switch: `POST /api/v1/orgs/switch` refuses a key caller.

An `admin`-scoped key is the exception, in both directions. It is a platform
credential — it reaches every org's admin routes — so it is stored with
`orgId: null`, and asking for `admin` while acting in any org other than the
install org is a `400`: mint platform keys from the default organisation,
where the screen and the credential agree. Both guards refuse a key that
carries both `admin` and an org — `withAdminAuth` at its scope floor,
`withAuth` through `enterApiKeyOrg` (`bound-admin-key`) — so the rule holds
at the guard even for a row edited by hand, and such a row is admitted
nowhere rather than refused on the admin routes and admitted, unscoped, on
the rest.

A key whose `orgId` is still `NULL` without being `admin` — minted between
the identity migration and the backfill that re-ran it, both in 0.13.0 — is read as the install org at
`single` and refused at `multi`; the backfill leaves none behind.

### `DELETE /api/v1/user/api-keys/:keyId`

Revoke a key by setting `revokedAt`. Soft-delete — record preserved for audit.

## Using API Keys

Send the key in the `Authorization` header:

```
Authorization: Bearer sk_a1b2c3d4e5f6...
```

The `resolveApiKey()` function in `lib/auth/api-keys.ts` handles:

1. Extract key from `Authorization: Bearer sk_...` header
2. Hash and look up in DB
3. Check not revoked and not expired
4. Update `lastUsedAt` (fire-and-forget)
5. Return a session-like object with the key owner's user data + scopes, plus
   the key's `orgId` (§106 — the org it was minted in, `null` for an `admin`
   key; the guards enter it, see [`tenancy/context.md`](../tenancy/context.md))

## Schema: `AiApiKey`

| Field          | Type        | Description                                         |
| -------------- | ----------- | --------------------------------------------------- |
| `userId`       | `String`    | Owner                                               |
| `name`         | `String`    | Admin-friendly label                                |
| `keyHash`      | `String`    | SHA-256 hash (unique)                               |
| `keyPrefix`    | `String`    | First 8 chars for display                           |
| `scopes`       | `String[]`  | Granted scopes                                      |
| `orgId`        | `String?`   | Org minted in (§106); `null` = platform (`admin`)   |
| `lastUsedAt`   | `DateTime?` | Last usage timestamp                                |
| `expiresAt`    | `DateTime?` | Expiry (null = never)                               |
| `revokedAt`    | `DateTime?` | Revocation (null = active)                          |
| `rateLimitRpm` | `Int?`      | Per-key rate limit (req/min); null = global default |

## Module Layout

```
lib/auth/api-keys.ts           # Key generation, hashing, resolution (imports Prisma)
lib/auth/api-key-scopes.ts     # Scope vocabulary + validation (Prisma-free, client-safe)
lib/app/api-key-scopes.ts      # Fork seam — extra scope names
app/api/v1/user/api-keys/      # Self-service endpoints (list, create)
app/api/v1/user/api-keys/[keyId]/ # Revoke endpoint
```
