# Embeddable Chat Widget

The embed system lets you surface an AI agent as a chat bubble on any external website without exposing admin credentials. Access is controlled by per-agent embed tokens with optional CORS origin restrictions.

## Architecture

```
app/api/v1/embed/
├── widget.js/route.ts    — GET: serves the JavaScript loader (public)
└── chat/stream/route.ts  — POST: SSE streaming chat (token-authenticated)

lib/embed/auth.ts          — resolveEmbedToken(), isOriginAllowed()

components/admin/orchestration/agents/embed-config-panel.tsx
app/api/v1/admin/orchestration/agents/[id]/embed-tokens/route.ts
app/api/v1/admin/orchestration/agents/[id]/embed-tokens/[tokenId]/route.ts
```

## Embed tokens

Each agent can have multiple embed tokens. A token controls:

- Which website origins can send chat requests (`allowedOrigins`)
- Whether the token is active (`isActive`)

Token management endpoints:

```
GET    /api/v1/admin/orchestration/agents/:id/embed-tokens
POST   /api/v1/admin/orchestration/agents/:id/embed-tokens
PATCH  /api/v1/admin/orchestration/agents/:id/embed-tokens/:tokenId
DELETE /api/v1/admin/orchestration/agents/:id/embed-tokens/:tokenId
```

Token shape:

```typescript
{
  id:             string;
  token:          string;          // random secret, shown once
  label?:         string | null;   // e.g. "Marketing site"
  allowedOrigins: string[];        // empty = wildcard (any origin)
  isActive:       boolean;
  createdAt:      string;
  creator:        { id: string; name: string };
}
```

## Widget loader

```
GET /api/v1/embed/widget.js
Public — no authentication required
Cache-Control: public, max-age=300
Access-Control-Allow-Origin: *
Content-Type: application/javascript; charset=utf-8
```

Usage on any external site:

```html
<script
  src="https://your-app.com/api/v1/embed/widget.js"
  data-token="YOUR_EMBED_TOKEN"
  data-position="bottom-right"
  data-theme="light"
></script>
```

Data attributes:

- `data-token` (required) — embed token value
- `data-position` — `bottom-right` | `bottom-left` | `top-right` | `top-left` (default: `bottom-right`)
- `data-theme` — `light` | `dark` (default: `light`)

The loader script uses Shadow DOM for style isolation. The `apiBase` URL is baked in at serve time from the request's `origin`.

## Chat stream endpoint

```
POST /api/v1/embed/chat/stream
Authentication: X-Embed-Token header (not session)
Rate limit: embedChatLimiter
```

### Authentication flow

1. `X-Embed-Token` header extracted
2. `resolveEmbedToken(token, clientIp)` looks up `AiAgentEmbedToken` — checks `isActive` and `agent.isActive`
3. Deterministic anonymous user ID computed: `embed_` + first 16 hex chars of `sha256("embed:{tokenId}:{clientIp}")`
4. `isOriginAllowed(requestOrigin, allowedOrigins)` — empty `allowedOrigins` = wildcard bypass

### Error responses

| Scenario                     | Status | Code                  |
| ---------------------------- | ------ | --------------------- |
| Missing `X-Embed-Token`      | 401    | `MISSING_TOKEN`       |
| Invalid/inactive token       | 401    | `INVALID_TOKEN`       |
| Rate limited                 | 429    | `RATE_LIMIT_EXCEEDED` |
| Origin not in allowedOrigins | 403    | `ORIGIN_DENIED`       |
| Invalid message body         | 400    | `VALIDATION_ERROR`    |

### CORS headers

CORS is applied dynamically based on the token's `allowedOrigins`:

- `allowedOrigins: []` → `Access-Control-Allow-Origin: *`
- `allowedOrigins: ["https://example.com"]` → `Access-Control-Allow-Origin: https://example.com` (only if request origin matches)

OPTIONS preflight requests return 204 with appropriate CORS headers.

### SSE response

On success, reuses `streamChat()` from the orchestration chat handler and returns an SSE stream identical to the admin chat endpoint. Conversation ID is created or continued via the `conversationId` field in the request body.

## Admin UI — EmbedConfigPanel

`components/admin/orchestration/agents/embed-config-panel.tsx`

Located in the agent edit form's embed tab. Displays:

- All tokens for the agent (label or "Untitled", active/inactive badge, token value, allowed origins)
- Embed snippet code block: `<script src="{appUrl}/api/v1/embed/widget.js" data-token="{token}"></script>`
- Copy snippet button
- Activate/Deactivate toggle (PATCH `isActive`)
- Delete token button

Create token form:

- Optional label (e.g. "Marketing site")
- Allowed origins textarea: comma-separated URLs, parsed into `string[]` on submit
- Empty label → not sent in POST body
