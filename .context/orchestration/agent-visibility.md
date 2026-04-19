# Agent Visibility & Access Control

Controls which agents are accessible to end-users via the consumer chat endpoint.

## Visibility Modes

| Mode          | Consumer Chat Access                       | Admin Access |
| ------------- | ------------------------------------------ | ------------ |
| `internal`    | Not accessible                             | Full access  |
| `public`      | Any authenticated user                     | Full access  |
| `invite_only` | Authenticated user with valid invite token | Full access  |

Set via `AiAgent.visibility` (default: `internal`).

## Invite Tokens

For `invite_only` agents, access is granted via opaque tokens managed by admins.

### Model: `AiAgentInviteToken`

| Field       | Type        | Description                                |
| ----------- | ----------- | ------------------------------------------ |
| `token`     | `String`    | Auto-generated CUID, shared with invitees  |
| `label`     | `String?`   | Admin-friendly label (e.g. "Beta testers") |
| `maxUses`   | `Int?`      | Usage cap (null = unlimited)               |
| `useCount`  | `Int`       | Current usage count                        |
| `expiresAt` | `DateTime?` | Expiry timestamp (null = never)            |
| `revokedAt` | `DateTime?` | Revocation timestamp (null = active)       |

### Admin Endpoints

| Method   | Endpoint                                                        | Description  |
| -------- | --------------------------------------------------------------- | ------------ |
| `GET`    | `/api/v1/admin/orchestration/agents/:id/invite-tokens`          | List tokens  |
| `POST`   | `/api/v1/admin/orchestration/agents/:id/invite-tokens`          | Create token |
| `DELETE` | `/api/v1/admin/orchestration/agents/:id/invite-tokens/:tokenId` | Revoke token |

**POST body:**

```json
{
  "label": "Beta testers",
  "maxUses": 100,
  "expiresAt": "2026-06-01T00:00:00Z"
}
```

All fields optional. Token can only be created for agents with `visibility = 'invite_only'`.

### Consumer Usage

Pass `inviteToken` in the consumer chat request body:

```json
{
  "message": "Hello",
  "agentSlug": "my-agent",
  "inviteToken": "cmjbv4i3x00004wsloputgwum"
}
```

Token validation checks:

1. Token exists and belongs to the agent
2. Token is not revoked (`revokedAt` is null)
3. Token is not expired (if `expiresAt` is set)
4. Token has not exceeded `maxUses` (if set)

On success, the token's `useCount` is incremented.

### Error Responses

| Status | When                                                                     |
| ------ | ------------------------------------------------------------------------ |
| `403`  | Missing token, invalid/revoked token, expired token, usage limit reached |
| `404`  | Agent not found or has `internal` visibility                             |

## How It Works in Consumer Chat

The consumer chat endpoint (`POST /api/v1/chat/stream`) resolves agents with:

```
visibility IN ('public', 'invite_only')
```

- `public` agents: no token needed
- `invite_only` agents: token required and validated
- `internal` agents: not returned (404)
