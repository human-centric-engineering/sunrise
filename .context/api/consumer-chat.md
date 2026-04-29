# Consumer Chat API

End-user-facing chat endpoints for interacting with publicly visible AI agents. These endpoints are separate from the admin orchestration API and provide a minimal, safe surface for authenticated consumers.

**Base path:** `/api/v1/chat`
**Authentication:** Every endpoint requires an authenticated session (`withAuth` in `lib/auth/guards.ts`). Any role is accepted (not admin-only). Unauthenticated callers get `401`.
**Agent visibility:** Agents with `visibility = 'public'` or `'invite_only'` (with valid invite token) and `isActive = true` are accessible. Internal agents return `404`.
**Rate limiting:** Chat stream uses `consumerChatLimiter` (10 msg/min per user) + `apiLimiter` (100 req/min per IP). Other endpoints use `apiLimiter` for mutations only.

## Quick reference

| Endpoint                                           | Method | Purpose                         |
| -------------------------------------------------- | ------ | ------------------------------- |
| `/chat/stream`                                     | POST   | Streaming chat turn (SSE)       |
| `/chat/agents`                                     | GET    | List publicly available agents  |
| `/chat/agents/:slug/validate-token`                | POST   | Validate an invite token        |
| `/chat/conversations`                              | GET    | List user's own conversations   |
| `/chat/conversations/search`                       | GET    | Search conversations by content |
| `/chat/conversations/:id`                          | GET    | Single conversation detail      |
| `/chat/conversations/:id`                          | DELETE | Delete own conversation         |
| `/chat/conversations/:id/messages`                 | GET    | Messages for a conversation     |
| `/chat/conversations/:id/messages/:messageId/rate` | POST   | Rate an assistant message       |

## Endpoints

### POST `/chat/stream`

Start or continue a streaming chat conversation with a public agent.

**Request body** (`consumerChatRequestSchema`):

```jsonc
{
  "message": "string (1–50000 chars, required)",
  "agentSlug": "string (required — must match a public, active agent)",
  "conversationId": "string (optional — CUID of existing conversation to continue)",
  "inviteToken": "string (optional — required for invite_only agents)",
  "attachments": "[{ name, mediaType, data }] (optional — max 10, base64, 10MB per item)",
}
```

**Response:** `text/event-stream` (SSE). Events follow the same shape as the admin chat stream:

| Event type           | Payload                                          | Description                                |
| -------------------- | ------------------------------------------------ | ------------------------------------------ |
| `start`              | `{ conversationId, messageId }`                  | Conversation created/resumed               |
| `content`            | `{ delta }`                                      | Text chunk from the agent                  |
| `status`             | `{ message }`                                    | Progress indication (e.g. tool running)    |
| `capability_result`  | `{ capabilitySlug, result }`                     | Single capability returned data            |
| `capability_results` | `{ results: [{ capabilitySlug, result }, ...] }` | Parallel capabilities returned data        |
| `content_reset`      | `{ reason }`                                     | Provider fallback — clear accumulated text |
| `done`               | `{ tokenUsage, costUsd, provider?, model? }`     | Turn complete                              |
| `warning`            | `{ code, message }`                              | Budget warning, input guard flag           |
| `error`              | `{ code, message }`                              | Unrecoverable error                        |

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

### POST `/chat/conversations/:id/messages/:messageId/rate`

Submit feedback on an assistant message (thumbs up/down). Only assistant messages in the user's own conversations with publicly visible agents can be rated.

**Request body** (`rateMessageSchema`):

```jsonc
{
  "rating": 1, // 1 = thumbs up, -1 = thumbs down
}
```

**Response:** `{ "success": true, "data": { "message": { "id": "cuid", "rating": 1, "ratedAt": "..." } } }`

Returns `404` if the conversation doesn't belong to the user, the agent is no longer public/active, or the message doesn't exist or isn't an assistant message. Rate limited via `apiLimiter`.

**Key file:** `app/api/v1/chat/conversations/[id]/messages/[messageId]/rate/route.ts`

---

### GET `/chat/conversations/search`

Search the authenticated user's conversations by message content.

**Query parameters** (`consumerConversationSearchSchema`):

| Param   | Type   | Default | Description                         |
| ------- | ------ | ------- | ----------------------------------- |
| `q`     | string | —       | Search term (1–200 chars, required) |
| `page`  | number | 1       | Page number                         |
| `limit` | number | 20      | Items per page                      |

Searches `AiMessage.content` via case-insensitive `contains` (lexical substring match) for the user's conversations. Returns paginated conversations with agent info, same shape as `/chat/conversations`. Unlike the admin search endpoint, this does not use pgvector semantic search.

**Rate limiting:** `chatLimiter` (per IP).

**Key file:** `app/api/v1/chat/conversations/search/route.ts`

---

### POST `/chat/agents/:slug/validate-token`

Check whether an invite token is valid for the given agent before attempting to chat.

**Request body:**

```jsonc
{
  "inviteToken": "string (required)",
}
```

**Response:**

```jsonc
// Valid
{ "success": true, "data": { "valid": true } }

// Invalid
{ "success": true, "data": { "valid": false, "reason": "Token has expired" } }
```

Checks: agent exists and is `invite_only`, token exists, not revoked, not expired, not past `maxUses`.

**Rate limiting:** `chatLimiter` (per IP).

**Key file:** `app/api/v1/chat/agents/[slug]/validate-token/route.ts`

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
- `consumerConversationSearchSchema` — query params for `/chat/conversations/search`
- `agentVisibilitySchema` — `z.enum(['internal', 'public', 'invite_only'])`

## Rate Limiting

| Limiter               | Scope       | Limit   | Used by                                                           |
| --------------------- | ----------- | ------- | ----------------------------------------------------------------- |
| `consumerChatLimiter` | Per user ID | 10/min  | `/chat/stream`                                                    |
| `apiLimiter`          | Per IP      | 100/min | `/chat/stream`, DELETE operations                                 |
| `chatLimiter`         | Per IP      | —       | `/chat/conversations/search`, `/chat/agents/:slug/validate-token` |

Defined in `lib/security/rate-limit.ts`. Consumer chat is deliberately stricter than admin chat (10 vs 20 msgs/min) to protect against cost abuse by end-users.

### Per-Agent Rate Limiting

Agents with `rateLimitRpm` set (nullable Int on `AiAgent`) override the global `consumerChatLimiter` default. The per-agent limit is keyed by `${agentId}:${userId}`. When `rateLimitRpm` is null, the global limit applies.
