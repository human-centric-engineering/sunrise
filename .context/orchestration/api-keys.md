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

## User Endpoints

All endpoints require session auth (`withAuth`). Users can only manage their own keys.

### `GET /api/v1/user/api-keys`

List the current user's API keys (without raw key values).

Returns: `{ keys: [{ id, name, keyPrefix, scopes, lastUsedAt, expiresAt, revokedAt, createdAt }] }`

### `POST /api/v1/user/api-keys`

Create a new API key. The raw key is returned in the response — store it securely, it cannot be retrieved again.

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
    "rawKey": "sk_a1b2c3d4e5f6..."
  }
}
```

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
5. Return a session-like object with the key owner's user data + scopes

## Schema: `AiApiKey`

| Field          | Type        | Description                                         |
| -------------- | ----------- | --------------------------------------------------- |
| `userId`       | `String`    | Owner                                               |
| `name`         | `String`    | Admin-friendly label                                |
| `keyHash`      | `String`    | SHA-256 hash (unique)                               |
| `keyPrefix`    | `String`    | First 8 chars for display                           |
| `scopes`       | `String[]`  | Granted scopes                                      |
| `lastUsedAt`   | `DateTime?` | Last usage timestamp                                |
| `expiresAt`    | `DateTime?` | Expiry (null = never)                               |
| `revokedAt`    | `DateTime?` | Revocation (null = active)                          |
| `rateLimitRpm` | `Int?`      | Per-key rate limit (req/min); null = global default |

## Module Layout

```
lib/auth/api-keys.ts           # Key generation, hashing, resolution, scope checks
app/api/v1/user/api-keys/      # Self-service endpoints (list, create)
app/api/v1/user/api-keys/[keyId]/ # Revoke endpoint
```
