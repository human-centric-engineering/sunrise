# Consumer Chat API

End-user-facing chat endpoints for interacting with publicly visible AI agents. These endpoints are separate from the admin orchestration API and provide a minimal, safe surface for authenticated consumers.

**Base path:** `/api/v1/chat`
**Authentication:** Every endpoint requires an authenticated session (`withAuth` in `lib/auth/guards.ts`). Any role is accepted (not admin-only). Unauthenticated callers get `401`.
**Agent visibility:** Agents with `visibility = 'public'` or `'invite_only'` (with valid invite token) and `isActive = true` are accessible. Internal agents return `404`.
**Rate limiting:** Chat stream uses `consumerChatLimiter` (10 msg/min per user) + `apiLimiter` (100 req/min per IP). Other endpoints use `apiLimiter` for mutations only.

## Quick reference

| Endpoint                           | Method | Purpose                        |
| ---------------------------------- | ------ | ------------------------------ |
| `/chat/stream`                     | POST   | Streaming chat turn (SSE)      |
| `/chat/agents`                     | GET    | List publicly available agents |
| `/chat/conversations`              | GET    | List user's own conversations  |
| `/chat/conversations/:id`          | GET    | Single conversation detail     |
| `/chat/conversations/:id`          | DELETE | Delete own conversation        |
| `/chat/conversations/:id/messages` | GET    | Messages for a conversation    |

## Endpoints

### POST `/chat/stream`

Start or continue a streaming chat conversation with a public agent.

**Request body** (`consumerChatRequestSchema`):

```jsonc
{
  "message": "string (1–50000 chars, required)",
  "agentSlug": "string (required — must match a public, active agent)",
  "conversationId": "string (optional — CUID of existing conversation to continue)",
}
```

**Response:** `text/event-stream` (SSE). Events follow the same shape as the admin chat stream:

| Event type          | Payload                    | Description                      |
| ------------------- | -------------------------- | -------------------------------- |
| `start`             | `{ conversationId }`       | Conversation created/resumed     |
| `content`           | `{ delta }`                | Text chunk from the agent        |
| `tool_call`         | `{ capabilitySlug, args }` | Agent invoked a capability       |
| `capability_result` | `{ slug, result }`         | Capability returned data         |
| `end`               | `{ messageId, usage }`     | Turn complete                    |
| `warning`           | `{ code, message }`        | Budget warning, input guard flag |
| `error`             | `{ code, message }`        | Unrecoverable error              |

**Errors:**

| Code                  | Status | When                                              |
| --------------------- | ------ | ------------------------------------------------- |
| `NOT_FOUND`           | 404    | Agent slug doesn't match any public, active agent |
| `RATE_LIMIT_EXCEEDED` | 429    | IP or user rate limit exceeded                    |
| `VALIDATION_ERROR`    | 400    | Invalid request body                              |
| `UNAUTHORIZED`        | 401    | No session                                        |

**Key files:** `app/api/v1/chat/stream/route.ts`, `lib/orchestration/chat/streaming-handler.ts`

---

### GET `/chat/agents`

List all agents available for consumer chat.

**Response:**

```jsonc
{
  "success": true,
  "data": {
    "agents": [
      {
        "id": "cuid",
        "name": "Book Advisor",
        "slug": "book-advisor",
        "description": "Ask me anything about the book",
      },
    ],
  },
}
```

Only returns `id`, `name`, `slug`, `description` — no system instructions, provider config, or other internal details are exposed.

**Key file:** `app/api/v1/chat/agents/route.ts`

---

### GET `/chat/conversations`

List the authenticated user's own conversations. Only conversations with public, active agents are returned.

**Query parameters** (`consumerConversationsQuerySchema`):

| Param       | Type   | Default | Description          |
| ----------- | ------ | ------- | -------------------- |
| `page`      | number | 1       | Page number          |
| `limit`     | number | 20      | Items per page       |
| `agentSlug` | string | —       | Filter by agent slug |

**Response:** Paginated list with `agent { id, name, slug }` and `_count { messages }`.

**Key file:** `app/api/v1/chat/conversations/route.ts`

---

### GET `/chat/conversations/:id`

Fetch a single conversation owned by the authenticated user. Returns `404` (not `403`) for conversations owned by other users or linked to non-public agents.

**Key file:** `app/api/v1/chat/conversations/[id]/route.ts`

---

### DELETE `/chat/conversations/:id`

Delete a conversation owned by the authenticated user. Messages cascade-delete via the foreign key relation. Rate limited via `apiLimiter`.

**Response:** `{ "success": true, "data": { "deleted": true } }`

**Key file:** `app/api/v1/chat/conversations/[id]/route.ts`

---

### GET `/chat/conversations/:id/messages`

Fetch messages for a conversation. Only returns safe fields: `id`, `role`, `content`, `createdAt`. Internal metadata (token counts, cost, latency) is not exposed to consumers.

**Response:**

```jsonc
{
  "success": true,
  "data": {
    "messages": [
      { "id": "cuid", "role": "user", "content": "...", "createdAt": "..." },
      { "id": "cuid", "role": "assistant", "content": "...", "createdAt": "..." },
    ],
  },
}
```

**Key file:** `app/api/v1/chat/conversations/[id]/messages/route.ts`

---

## Agent Visibility Model

The `AiAgent` model has a `visibility` field with three values:

| Value         | Description                                  | Consumer access  |
| ------------- | -------------------------------------------- | ---------------- |
| `internal`    | Admin-only (default for all existing agents) | No               |
| `public`      | Visible to all authenticated users           | Yes              |
| `invite_only` | Accessible with a valid invite token         | Yes (with token) |

Admins set visibility when creating or updating agents via the admin API. The consumer endpoints filter on `visibility IN ('public', 'invite_only')`. For `invite_only` agents, the chat stream validates the invite token (not revoked, not expired, within `maxUses`).

## Validation Schemas

All consumer schemas live in `lib/validations/orchestration.ts`:

- `consumerChatRequestSchema` — POST body for `/chat/stream`
- `consumerConversationsQuerySchema` — query params for `/chat/conversations`
- `agentVisibilitySchema` — `z.enum(['internal', 'public', 'invite_only'])`

## Rate Limiting

| Limiter               | Scope       | Limit   | Used by                           |
| --------------------- | ----------- | ------- | --------------------------------- |
| `consumerChatLimiter` | Per user ID | 10/min  | `/chat/stream`                    |
| `apiLimiter`          | Per IP      | 100/min | `/chat/stream`, DELETE operations |

Defined in `lib/security/rate-limit.ts`. Consumer chat is deliberately stricter than admin chat (10 vs 20 msgs/min) to protect against cost abuse by end-users.

### Per-Agent Rate Limiting

Agents with `rateLimitRpm` set (nullable Int on `AiAgent`) override the global `consumerChatLimiter` default. The per-agent limit is keyed by `${agentId}:${userId}`. When `rateLimitRpm` is null, the global limit applies.
