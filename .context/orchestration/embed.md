# Embeddable Chat Widget

The embed system lets you surface an AI agent as a chat bubble on any external website without exposing admin credentials. Access is controlled by per-agent embed tokens with optional CORS origin restrictions.

## Architecture

```
app/api/v1/embed/
├── widget.js/route.ts        — GET: serves the JavaScript loader (public)
├── widget-config/route.ts    — GET: per-agent appearance + copy (token-authenticated)
└── chat/stream/route.ts      — POST: SSE streaming chat (token-authenticated)

lib/embed/auth.ts              — resolveEmbedToken(), isOriginAllowed()
lib/validations/orchestration  — widgetConfigSchema, DEFAULT_WIDGET_CONFIG, resolveWidgetConfig

components/admin/orchestration/agents/embed-config-panel.tsx       — composes both sections
components/admin/orchestration/agents/widget-appearance-section.tsx — colours + copy + starters
app/api/v1/admin/orchestration/agents/[id]/embed-tokens/...          — tokens CRUD
app/api/v1/admin/orchestration/agents/[id]/widget-config/route.ts    — appearance read/update
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

### Per-agent appearance — `/widget-config`

On boot, the loader fetches `GET /api/v1/embed/widget-config` with the same `X-Embed-Token` header used for the chat stream. The response carries the agent's resolved `WidgetConfig` (defaults merged with the stored partial). The widget then assigns CSS custom properties on the host element so the Shadow DOM tree picks them up via `var(--sw-*)`, and substitutes the copy strings via `textContent` / `setAttribute('placeholder', …)` — never `innerHTML` for admin-saved values.

If the fetch fails or returns an unexpected shape the widget falls back to `DEFAULT_WIDGET_CONFIG` (defined alongside the schema in `lib/validations/orchestration.ts`) and still mounts. There is no client-side caching beyond browser default — admin updates propagate on the next page load.

```typescript
interface WidgetConfig {
  primaryColor: string; // 6-digit hex; bubble + send button + user bubbles + cite chips
  surfaceColor: string; // chat panel background
  textColor: string; // body text colour
  fontFamily: string; // CSS font stack; allowlist regex blocks { } ; ( )
  headerTitle: string; // 1–60 chars
  headerSubtitle: string; // 0–100 chars; row hides when empty
  inputPlaceholder: string; // 1–80 chars
  sendLabel: string; // 1–30 chars
  conversationStarters: string[]; // 0–4 chips, 1–200 chars each
  footerText: string; // 0–80 chars; row hides when empty
}
```

The CSS custom properties set on the host: `--sw-primary`, `--sw-surface`, `--sw-text`, `--sw-border`, `--sw-surface-muted`, `--sw-input-bg`, `--sw-status`, `--sw-font`. Future loader-side themes can extend this set without changing the API contract.

#### Conversation starters

When the panel opens and the message list is empty, up to four chip buttons render above the input area populated from `conversationStarters`. Click → drops the text into the input and fires the same `send()` path as a typed message. Chips disappear on the first message. The chips are a soft-prompt UX — they do not bypass any rate limit or guard.

#### Input focus retention

`endStream()` calls `input.focus()` after every turn so the cursor returns to the input box and the user can keep typing without clicking back in. Click-to-send moves focus to the send button, so without this the focus would be left there. Enter-key submissions already keep focus on the input, so the call is a no-op in that path. The new-chat button and voice-input completion paths also call `input.focus()` for the same reason.

#### XSS posture

- Colour fields validated by `^#[0-9a-fA-F]{6}$` before being assigned to CSS variables.
- `fontFamily` validated by `^[\w\s,'"-]+$` — blocks `{` / `}` / `;` / parentheses so a stored value cannot escape the CSS declaration.
- All copy fields rendered via `textContent` or `setAttribute('placeholder', …)` — admin-saved strings cannot inject HTML into the partner page.

### Citation rendering

When the SSE stream emits a `citations` event (see [Streaming Chat — Citations](./chat.md#citations)), the widget rebuilds the assistant bubble: `[N]` markers in the streamed text become superscript chips, and a sources panel is appended below the bubble with each marker's document name, optional section, and excerpt. Hallucinated markers (no matching citation) get an amber `cite-bad` style.

All citation rendering uses `createElement` + `textContent` — model output is never passed through `innerHTML`, so a hostile knowledge document cannot inject DOM into the host page through the widget.

### Voice input

The `/widget-config` response includes a `voiceInputEnabled: boolean` flag computed server-side. It is `true` only when:

1. The agent's per-agent toggle (`AiAgent.enableVoiceInput`) is on.
2. The org-wide kill switch (`AiOrchestrationSettings.voiceInputGloballyEnabled`) is on.
3. At least one configured `AiProviderModel` row has the `'audio'` capability and a healthy provider behind it.

When all three hold, the widget renders a microphone button in the input row. Clicking it requests `getUserMedia({ audio: true })`, records via `MediaRecorder`, and POSTs the resulting blob to `POST /api/v1/embed/speech-to-text`. The transcript replaces / appends to the input field; the existing send path is unchanged.

**Two more guards** apply client-side before the button renders, even when `voiceInputEnabled` is true:

- **Secure context.** The page must be on HTTPS or `localhost` / `127.0.0.1`. `getUserMedia` rejects on plain HTTP.
- **Browser support.** `window.MediaRecorder` and `navigator.mediaDevices.getUserMedia` must both exist.

Failed checks silently hide the button — there's no degraded "voice unavailable" state because partner pages are heterogeneous and a half-rendered control is worse than no control.

**Permissions-Policy caveat.** The widget mounts on the partner site via `<script>` injection — it inherits the parent site's `Permissions-Policy`, and Sunrise cannot override it. If the partner page sends `Permissions-Policy: microphone=()` (or no policy on a cross-origin iframe), `getUserMedia` rejects with `NotAllowedError` and the widget surfaces "Microphone disabled by your browser or this site." inline. Iframe embedders need `allow="microphone"` on the iframe element. Document this in the partner integration guide.

**MIME selection.** The widget runtime-detects what `MediaRecorder.isTypeSupported(...)` returns and uses, in order: `audio/webm;codecs=opus` → `audio/webm` → `audio/mp4;codecs=mp4a.40.2` → `audio/mp4` → browser default. iOS Safari produces `audio/mp4`; Chrome/Firefox produce `audio/webm`. The picked MIME is forwarded as the upload's content type so the server validates correctly.

**Recording cap.** A 3-minute client-side timer auto-stops the recorder so users don't upload audio that the 25 MB server cap will reject after a long pause.

**Error mapping.** Server error codes (`VOICE_DISABLED`, `NO_AUDIO_PROVIDER`, `AUDIO_TOO_LARGE`, `AUDIO_INVALID_TYPE`, `RATE_LIMITED`) map to friendly inline messages in `voiceErrEl`. The transcribe endpoint never persists audio — only the transcript becomes part of the conversation, via the standard chat send.

#### Platform body-size limits

The 25 MB cap documented above is Sunrise's server-side limit. The **effective** maximum upload depends on where the fork is deployed:

| Platform                   | Effective body cap                              | Approx. recording length (Opus @ 64 kbps) |
| -------------------------- | ----------------------------------------------- | ----------------------------------------- |
| Self-hosted Node / Docker  | 25 MB (Sunrise cap)                             | ~50 minutes                               |
| Vercel Hobby               | **4.5 MB** (platform default, before our route) | ~9 minutes                                |
| Vercel Pro / Enterprise    | 4.5 MB default; configurable via plan settings  | varies                                    |
| Cloudflare Workers / Pages | 100 MB (platform), capped to 25 MB by us        | ~50 minutes                               |

On Vercel, requests over the platform cap are rejected by the edge **before** Sunrise's route runs — the user sees a generic gateway error, not the friendly `AUDIO_TOO_LARGE` envelope. The 3-minute client-side recording cap (~1.4 MB at 64 kbps Opus) keeps every typical recording well under the 4.5 MB ceiling, so this only bites on long uploads from `<input type="file">`-style integrations or fork-customised widgets that loosen the recorder limit.

A pre-parse `Content-Length` guard in the route also rejects oversized bodies on self-hosted Node before the multipart parser allocates memory — so even malformed clients can't OOM the server.

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

Located in the agent edit form's Embed tab. The panel stacks two cards:

### Appearance & copy (top)

`components/admin/orchestration/agents/widget-appearance-section.tsx`. Edits the per-agent `widgetConfig` JSON column on `AiAgent`. Layout: a form column on the left and a static live-preview pane on the right (desktop) so admins can iterate on colours without saving and reloading a partner site.

- Three colour pickers (primary / surface / text) — native `<input type="color">` paired with a hex text input.
- Font-family stack (one line, 200 chars).
- Header title (1–60), subtitle (0–100, row hides when empty).
- Input placeholder (1–80), send-button label (1–30) — these are the localisation surface for non-English deployments.
- Conversation-starter list editor (add up to 4 chips, trash to remove).
- Footer caption (0–80, row hides when empty).
- "Save appearance" → `PATCH /api/v1/admin/orchestration/agents/:id/widget-config`. "Reset to defaults" restores `DEFAULT_WIDGET_CONFIG` locally without saving.
- Every field has a `<FieldHelp>` popover with what / when / default.

The save scope is independent of the main agent form's dirty tracking — the appearance section saves immediately via its own button, mirroring how the tokens card already works.

### Tokens (bottom)

Token CRUD — unchanged from before the appearance section was added. Displays:

- All tokens for the agent (label or "Untitled", active/inactive badge, token value, allowed origins)
- Embed snippet code block: `<script src="{appUrl}/api/v1/embed/widget.js" data-token="{token}"></script>`
- Copy snippet button
- Activate/Deactivate toggle (PATCH `isActive`)
- Delete token button

Create token form:

- Optional label (e.g. "Marketing site")
- Allowed origins textarea: comma-separated URLs, parsed into `string[]` on submit
- Empty label → not sent in POST body

## Admin endpoints — widget config

```
GET   /api/v1/admin/orchestration/agents/:id/widget-config
PATCH /api/v1/admin/orchestration/agents/:id/widget-config
```

Both require admin auth + `adminLimiter`. PATCH validates the body via `updateWidgetConfigSchema` (a `partial()` of `widgetConfigSchema` that requires at least one known field) and merges over the current resolved config before writing. An audit row is written under action `agent.widget_config.update` with per-field `from` / `to` deltas.

The PATCH response returns the resolved config (defaults filled in) so the UI can rebind to the canonical shape after saving.

## In-chat approvals

When the agent triggers a workflow (via the `run_workflow` capability) that pauses on a `human_approval` step, the widget renders an Approve / Reject card inside the conversation. The card is built with `createElement` + `textContent` only (no `innerHTML`), inherits the per-agent theme via the existing `--sw-*` CSS custom properties, and submits to the channel-specific public sub-routes.

| What                  | Where                                                             |
| --------------------- | ----------------------------------------------------------------- |
| SSE event branch      | `evt.type === 'approval_required'` in the widget consumer switch  |
| Render function       | `renderApprovalCard` inside `app/api/v1/embed/widget.js/route.ts` |
| Approve POST          | `/api/v1/orchestration/approvals/:id/approve/embed?token=…`       |
| Reject POST           | `/api/v1/orchestration/approvals/:id/reject/embed?token=…`        |
| Status poll           | `/api/v1/orchestration/approvals/:id/status?token=…`              |
| CORS allowlist source | `OrchestrationSettings.embedAllowedOrigins` (Json column)         |

The `/approve/embed` and `/reject/embed` routes enforce CORS against `OrchestrationSettings.embedAllowedOrigins`. **Admins must populate this allowlist with the partner-site origin** before the embed widget can submit approvals — the default empty array means every embed-channel POST is rejected with a 403. Origin `null` is always rejected (sandboxed iframes, file:// loads).

Wildcard `'*'` is intentionally not supported on these routes. Both the write-side Zod schema (`lib/validations/orchestration.ts`) and the read-side parser (`parseEmbedAllowedOrigins` in `lib/orchestration/settings.ts`) reject any entry that fails `new URL().origin` normalisation. The exact-match-only posture forces every fork to think about origins explicitly. Forks that genuinely need wildcard CORS for these endpoints must change all three sites together (write schema, read parser, and `allowlistCorsHeaders`); adding wildcard at one site alone produces dead code.

The `/status` endpoint uses permissive CORS (`*`) so the widget can poll from any partner origin. Token authentication is the gate: anyone with a valid HMAC token can read execution state, matching the audience model where the recipient is the end user themselves.

After a terminal poll state, the card writes a synthesised follow-up message into the existing input field and triggers `send()` — the LLM gets a fresh turn carrying the workflow output as if the user typed `Workflow approved. Result: { … }` themselves.

### embedAllowedOrigins setting

`OrchestrationSettings.embedAllowedOrigins: Json` — array of origin strings (`https://` URLs, plus `http://localhost` and `http://127.0.0.1` for development). Read at the top of every `/embed` POST and validated against the request `Origin` header. Malformed entries are dropped at hydration time so a corrupt setting can't crash the approval routes; each drop emits a `logger.warn` with the offending value, index, and reason so operators can spot a misconfigured allowlist in the logs.

Configure via the global orchestration settings UI; updates take effect on the next request (no caching).
