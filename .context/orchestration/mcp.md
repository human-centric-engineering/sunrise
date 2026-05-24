# MCP Server

Model Context Protocol (MCP) server that lets external AI clients (Claude Desktop, Cursor, custom agents) connect to Sunrise and use its tools, data, and prompts.

## Architecture

```
Client (Claude Desktop / Cursor / custom)
  |
  | JSON-RPC 2.0 over HTTP
  v
POST /api/v1/mcp           ← Streamable HTTP transport
  |
  |-- IP rate limit (apiLimiter)
  |-- Bearer auth (smcp_ key → SHA-256 → McpApiKey lookup)
  |-- isEnabled check (McpServerConfig singleton)
  |-- JSON-RPC envelope validation
  |-- Session management (Mcp-Session-Id header)
  v
lib/orchestration/mcp/protocol-handler.ts
  |
  |-- tools/list                → tool-registry.ts → McpExposedTool + AiCapability (+ annotations on 2025-06-18)
  |-- tools/call                → tool-registry.ts → capabilityDispatcher.dispatch() (+ rich content blocks)
  |-- resources/list, /templates, /read
  |                             → resource-registry.ts → sunrise:// URI handlers
  |-- resources/subscribe, /unsubscribe
  |                             → session-manager.ts subscriptionsBySession map
  |-- prompts/list, /get        → prompt-registry.ts (DB-backed cache, legacy fallback)
  |-- logging/setLevel          → session-manager.ts setLogLevel
  |-- completion/complete       → completion-registry.ts (static lookup only)
  v
Audit log (fire-and-forget → McpAuditLog)
SSE push (notifications/{tools,resources,prompts}/list_changed,
          notifications/resources/updated, /message, /progress)
```

## Key Files

| Area          | Files                                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------------- |
| Core library  | `lib/orchestration/mcp/` (16 files, platform-agnostic)                                                            |
| Transport     | `app/api/v1/mcp/route.ts` (POST/GET/DELETE)                                                                       |
| Admin API     | `app/api/v1/admin/orchestration/mcp/` (7 route trees: tools, resources, prompts, keys, sessions, settings, audit) |
| Admin UI      | `app/admin/orchestration/mcp/` (7 pages: dashboard + tools, resources, prompts, keys, sessions, settings, audit)  |
| Components    | `components/admin/orchestration/mcp/` (9 components)                                                              |
| Types         | `types/mcp.ts`                                                                                                    |
| Validation    | `lib/validations/mcp.ts`                                                                                          |
| Prisma models | McpServerConfig, McpExposedTool, McpExposedResource, McpExposedPrompt, McpApiKey, McpAuditLog                     |

## Security Model

| Layer              | Mechanism                                                                               |
| ------------------ | --------------------------------------------------------------------------------------- |
| Auth               | Bearer token (`smcp_` prefix, SHA-256 hashed), scope-based                              |
| Master switch      | `McpServerConfig.isEnabled` — 503 when off                                              |
| Default-deny       | Everything disabled by default; each tool/resource must be explicitly enabled           |
| Rate limiting      | IP-level (100/min) -> per-key (configurable) -> per-tool (via dispatcher)               |
| Input validation   | JSON-RPC envelope (Zod) -> tool args (JSON Schema + Zod in dispatcher)                  |
| SSRF prevention    | Resource URIs pattern-matched against registered set; no user URL reaches `fetch()`     |
| Audit              | Every MCP call logged with IP, duration, method, result code. Manual purge via admin UI |
| Error sanitization | JSON-RPC errors never leak internals in production                                      |
| Body size limit    | POST bodies &gt; 1MB (via `content-length`) → 413 before JSON parsing                   |

### Body size limit (413)

`app/api/v1/mcp/route.ts` rejects POST bodies whose `content-length` header exceeds 1 MB with a 413 and a JSON-RPC error envelope, before any JSON parsing runs. This branch is **covered by integration/e2e tests only**: jsdom treats `content-length` as a forbidden request header when it doesn't match the body length and strips it, so a unit test cannot observe the real HTTP server behaviour. The unit test file parks this case as `it.todo` with a `// SOURCE DECISION: Document` marker pointing back here.

## API Key Lifecycle

1. Admin creates key via UI or `POST /api/v1/admin/orchestration/mcp/keys`
2. Plaintext returned **once** (format: `smcp_<base62>`), SHA-256 hash stored
3. Client uses `Authorization: Bearer smcp_...` header
4. Scopes control access: `tools:list`, `tools:execute`, `resources:read`, `prompts:read`
5. Keys can be revoked immediately; `expiresAt` for automatic expiry
6. **Key rotation:** `POST /api/v1/admin/orchestration/mcp/keys/:id/rotate` — generates new key material, returns new plaintext once, immediately invalidates the old key. Optionally set `{ expiresAt }` in the body.

## Authentication & OAuth 2.1 Roadmap

The server currently authenticates clients with **bearer tokens** (the `smcp_` keys above). The 2025-06-18 MCP spec recommends OAuth 2.1 + Dynamic Client Registration (DCR) for HTTP transport but explicitly permits bearer auth, which is what Sunrise ships today.

### Bridge for 2025-spec clients

401 responses include a `WWW-Authenticate: Bearer realm="sunrise-mcp", error="invalid_token"` header (RFC 6750 / RFC 9728). 2025-spec OAuth-capable clients use this to detect that the server is bearer-only and skip OAuth discovery rather than failing on the missing `/.well-known/oauth-authorization-server` endpoint. End users keep pasting an `smcp_` key into their client config exactly as before.

This is sufficient for the common deployment shape (single org, dev or internal use, admins distributing keys to developers they trust). It is **not** sufficient for multi-tenant SaaS where end-users connect their own MCP clients with their own identity — that's what OAuth solves.

### When OAuth becomes necessary

| Symptom                                                                | OAuth required?                         |
| ---------------------------------------------------------------------- | --------------------------------------- |
| Single org, devs paste keys into Claude Desktop / Cursor configs       | No — bearer is fine                     |
| Audit log needs per-end-user identity, not per-key                     | Yes                                     |
| Want to revoke a single user without kicking everyone on a shared key  | Yes                                     |
| SOC 2 / SAML / SSO buyers ask "how are individual users authenticated" | Yes                                     |
| Future MCP client refuses bearer auth                                  | Yes (no current client does as of 2026) |

### Roadmap — what a full OAuth 2.1 + DCR implementation needs

When this becomes load-bearing, the work splits into six pieces. Captured here so a future contributor has the full picture without spec spelunking:

1. **Authorization Server Metadata (RFC 8414).** Static JSON at `/.well-known/oauth-authorization-server` advertising `issuer`, `authorization_endpoint`, `token_endpoint`, `registration_endpoint`, `scopes_supported`, `response_types_supported: ["code"]`, `code_challenge_methods_supported: ["S256"]`. ~30 lines.

2. **Dynamic Client Registration (RFC 7591).** `POST /oauth/register` accepting `{ client_name, redirect_uris, grant_types }` and returning a `client_id` (+ optional `client_secret` for confidential clients). Without DCR, the OAuth flow is dead on arrival for desktop MCP clients — users won't pre-register apps with your admin. **Risk:** anyone on the internet can register. Mitigations: rate-limit the register endpoint, expose an admin list of registered clients with revoke, optional "trusted client_id allowlist" for auto-approved consent.

3. **Authorization endpoint** `/oauth/authorize` with **PKCE mandatory** (`code_challenge` + `code_challenge_method=S256` required). The client makes up a random verifier, sends its hash to the authorize endpoint, sends the verifier to the token endpoint. Stops an attacker who intercepts the authorization code from redeeming it. ~50 lines including hash comparison.

4. **Token endpoint** `/oauth/token` with `authorization_code` + `refresh_token` grants. Rotating refresh tokens (rotate-on-use). Bind tokens to **resource indicators (RFC 8707)** — clients pass `resource=https://your-app/api/v1/mcp` at auth + token endpoints; server enforces the audience claim on validation so a token issued for Sunrise MCP can't be replayed against some other API.

5. **Consent UI** at `/oauth/consent` — a styled page where end-users approve scope grants. Skip the screen entirely for "first-party" trusted `client_id`s (whitelisted via env / admin UI).

6. **Auth middleware change**: replace `authenticateMcpRequest` in `lib/orchestration/mcp/auth.ts` with a function that accepts EITHER an `smcp_` bearer key OR an OAuth JWT bearer, validating JWT signature, expiry, audience, and scope. Both auth paths resolve into the same `McpAuthContext` shape so per-method handlers don't branch on auth source.

### Prisma models needed

```
OAuthClient                  // DCR-registered or admin-registered apps
OAuthAuthorizationCode       // single-use, ~10 min TTL
OAuthAccessToken             // can be stateless JWT instead
OAuthRefreshToken            // long-lived, rotates on each use
OAuthConsent                 // per-user, per-client, per-scope grants
```

### Honest sizing

Rough estimate: 2–3 weeks of one engineer for a production-ready implementation including the admin UI for registered clients + consent UX. No partial credit available — DCR-less OAuth is unusable for desktop MCP clients, so the work has to ship together. Bearer auth keeps every current client working in the meantime.

## Tool Exposure Flow

1. Admin enables a capability as an MCP tool via the Tools page
2. `McpExposedTool` row links to `AiCapability` with `isEnabled: true`
3. `tools/list` joins both tables, serves only doubly-enabled tools
4. `tools/call` dispatches through `capabilityDispatcher.dispatch()` using the `mcp-system` agent
5. Full 9-step pipeline applies: validation, rate limiting, execution, cost tracking

If `capabilityDispatcher.dispatch()` throws an unexpected exception (as opposed to returning `{ success: false }`), `callMcpTool` catches it and returns an MCP error content block (`isError: true`) with a generic message rather than escalating to a JSON-RPC protocol error.

### Tool result content blocks (MCP 2025-06-18)

Capabilities return one of two shapes from `dispatch()`:

1. **Legacy**: any JSON value. The registry wraps it as a single `text` content block via `JSON.stringify`.
2. **Opt-in rich content**: an object `{ contentBlocks: [...] }`. Each block must be one of:

| Type       | Shape                                                 | Use for                                                                    |
| ---------- | ----------------------------------------------------- | -------------------------------------------------------------------------- |
| `text`     | `{ type, text }`                                      | Plain text                                                                 |
| `image`    | `{ type, data, mimeType }` (base64)                   | Generated images, screenshots                                              |
| `audio`    | `{ type, data, mimeType }` (base64)                   | Speech, audio clips                                                        |
| `resource` | `{ type, resource: { uri, mimeType, text?, blob? } }` | Embedded `resources/read`-shaped payload (exactly one of `text` or `blob`) |

Server-enforced caps in `callMcpTool`:

| Cap                                   | Value |
| ------------------------------------- | ----- |
| Blocks per response                   | 50    |
| Image / audio block (decoded)         | 5 MB  |
| Total payload (text + decoded binary) | 10 MB |

Violations return `{ isError: true }` with a generic message — the specifics are server-logged so a misbehaving capability cannot probe the caps. Base64 is length-checked without full decoding so cap enforcement does not allocate the entire buffer. Embedded resources must have exactly one of `text` or `blob`; both or neither returns an error. Unknown `type` values are rejected.

### Tool annotations (MCP 2025-06-18)

Each `McpExposedTool` row carries five optional annotation overrides (`customTitle`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) that surface on `tools/list` results when the session negotiated `2025-06-18`. **These are advisory only** — the MCP spec is explicit that compliant clients must still treat every tool as untrusted. They inform UX (e.g. surface a "confirm before destructive call" dialog) but never enforce behaviour.

Tri-state per spec: `true`, `false`, or omitted ("no opinion"). The admin UI exposes each as a select with `unset / true / false` so a null override is distinguishable from an explicit "no". `idempotentHint` inherits from `AiCapability.isIdempotent` when the row override is null, but a non-null row override always wins — the same capability can be marked idempotent internally but non-idempotent when called via MCP if its external side-effects differ.

For older protocol negotiations (`2024-11-05`) the annotations field is omitted entirely from the wire response, since pre-2025 clients have no spec definition for it.

## Resource Handlers

| Type               | URI Pattern                             | Handler                          |
| ------------------ | --------------------------------------- | -------------------------------- |
| `knowledge_search` | `sunrise://knowledge/search?q={query}`  | Delegates to `searchKnowledge()` |
| `pattern_detail`   | `sunrise://knowledge/patterns/{number}` | Queries AiKnowledgeChunk         |
| `agent_list`       | `sunrise://agents`                      | Active agents list               |
| `workflow_list`    | `sunrise://workflows`                   | Active workflows list            |

Each `McpExposedResource` has an optional `handlerConfig` JSON field passed to the resource handler as its second argument, allowing per-resource configuration (e.g., custom search parameters, filters). Stored as Prisma JSON and validated as `Record<string, unknown> | null`.

When a URI does not match any registered resource exactly, `readMcpResource` falls back to pattern matching against all enabled resources. Pattern matching uses first-match-wins order (database insertion order). If multiple resource patterns could match the same URI, the first match is used. Both exact and pattern-match handler calls are wrapped in try-catch — handler failures return an error content block instead of propagating.

After creation, **`uri` and `resourceType` are immutable** — the registry routes reads by URI prefix and dispatches by `resourceType`, so changing either mid-life would orphan in-flight client subscriptions. To rename or re-type a resource, delete it and create a new one (per the dialog warning in the admin UI).

### Subscriptions

MCP clients can call `resources/subscribe { uri }` to receive `notifications/resources/updated { uri }` whenever the underlying data changes. `resources/unsubscribe { uri }` removes the subscription. The server advertises `resources: { subscribe: true }` in `initialize` so clients know the methods are supported.

Limits and rules (enforced in the protocol handler / session manager):

- **Concrete URIs only.** Subscribing to a template URI (`sunrise://patterns/{id}`) is rejected with `INVALID_PARAMS` — subscribe to concrete instances (`sunrise://patterns/5`) instead. The check rejects on `{` or `}` before any registry lookup so clients cannot probe what's registered.
- **Registered URIs only.** Subscribing to a URI the registry doesn't know about is rejected — ghost subscriptions would never receive an update notification anyway.
- **50 subscriptions per session.** Excess returns `INVALID_REQUEST` with a "Subscription limit exceeded" message. Unsubscribe first.
- **Idempotent.** Duplicate subscribe / unsubscribe returns `ok` with no side effect.
- **Tied to session lifetime.** Subscriptions are cleared on `destroySession` and on session-expiry eviction (1 h TTL). Clients that lose their session re-subscribe after re-initialise.
- **Per-session fan-out.** `broadcastMcpResourceUpdated(uri)` only delivers to sessions subscribed to that URI, not to every connected client.

What fires an updated notification:

| Mutation                                                    | Fires for URI                |
| ----------------------------------------------------------- | ---------------------------- |
| Admin `PATCH /api/v1/admin/orchestration/mcp/resources/:id` | the row's `uri`              |
| Knowledge document POST / confirm / PATCH / DELETE          | `sunrise://knowledge/search` |
| Agent POST / PATCH / DELETE                                 | `sunrise://agents`           |
| Workflow POST / PATCH / DELETE                              | `sunrise://workflows`        |

The wiring lives in `lib/orchestration/mcp/resource-update-hooks.ts` as named helpers (`notifyMcpAgentsChanged`, `notifyMcpWorkflowsChanged`, `notifyMcpKnowledgeChanged`). Mutation routes import the named helper rather than hard-coding the URI string — one place to change if a resource URI ever moves.

**Known limit — multi-process deploys:** the subscription map is per-Node.js-process, so a mutation on instance A doesn't notify subs on instance B. Acceptable for the common single-instance deploy; horizontally-scaled production would need a Redis pub/sub layer (captured as a future improvement).

## Progress notifications

Long-running `tools/call` and `resources/read` requests can carry an optional `_meta.progressToken` (string or number, max 256 chars, must be finite). The server validates the token shape on dispatch and rejects malformed tokens with `INVALID_PARAMS` rather than ignoring them silently.

A capability that opts into progress reporting receives a `report(progress, total?)` callback wired through `createProgressReporter` in `lib/orchestration/mcp/progress-tracker.ts`. The reporter:

- Pushes `notifications/progress { progressToken, progress, total? }` to **only the originating session** (not broadcast to other clients).
- Rate-limits to **50 notifications per session per second** (sliding 1 s window). Excess is silently dropped — progress is a UX hint, never a correctness signal, so the underlying operation must never block on backpressure.
- Drops notifications safely after session expiry or SSE disconnect.

Capabilities that don't opt in get a no-op reporter (`NOOP_PROGRESS_REPORTER`) so they can always call `progress(...)` without guarding.

## Logging API

Clients call `logging/setLevel { level }` to set the minimum severity they want pushed via `notifications/message`. The session-level filter defaults to `warning` so clients that never call `setLevel` don't get flooded with `info`/`debug` chatter. The 8 levels per RFC 5424:

| Level       | Rank | Typical use                                           |
| ----------- | ---- | ----------------------------------------------------- |
| `debug`     | 0    | Diagnostic detail (resource handler fallbacks)        |
| `info`      | 1    | Normal operational events                             |
| `notice`    | 2    | Notable conditions (e.g. cost-cap hit on a tool call) |
| `warning`   | 3    | Recoverable issues — default                          |
| `error`     | 4    | Operation failed                                      |
| `critical`  | 5    | Component failure                                     |
| `alert`     | 6    | Immediate action required                             |
| `emergency` | 7    | System unusable                                       |

Server-side calls into `emitMcpLog(sessionId, level, logger?, data)` (or `null` to broadcast to every session that passes its filter) push `notifications/message { level, logger?, data }`. Caps applied per session:

| Cap                                  | Value                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Notifications per second per session | 100 (sliding window; excess silently dropped)                                                                                  |
| `logger` field length                | 64 chars (truncated)                                                                                                           |
| `data` payload                       | 4 KB serialised — overlong payloads are replaced with `{ truncated: true, reason: '...' }` so clients still see a notification |

Use sparingly — this is for events the client genuinely cares about (cost-cap hits, resource handler fallbacks). Internal server-side logging continues to go to `lib/logging`, not the MCP wire.

## Completion API

`completion/complete` lets clients ask the server for autocomplete candidates for a prompt argument or a resource URI template variable, given a partial value the user has typed.

```
client → completion/complete {
  ref: { type: "ref/prompt", name: "analyze-pattern" },
  argument: { name: "pattern_number", value: "1" }
}
server → { completion: { values: ["1", "10", …], hasMore: false, total: 11 } }
```

**Hard rule: completion lookups are purely static.** They never invoke a tool, never read a resource, never call an LLM. This bounds the cost of every autocomplete keystroke and prevents accidental recursion (a completion that triggers a tool that triggers another completion lookup…). Admins supply candidate lists upfront:

- **For prompts**: the `completionsSpec` JSON column on `McpExposedPrompt` — shape `{ [argName: string]: string[] }`. Editable per-arg in the prompts admin UI (Phase 6 UI work captured in Phase 2's `completionsSpec` column).
- **For resources**: the `completionsSpec` key inside `handlerConfig` — same shape.
- **Special case**: `sunrise://knowledge/patterns/{number}` enumerates 1-21 dynamically without admin maintenance.

### Limits

| Limit                                 | Value                                      |
| ------------------------------------- | ------------------------------------------ |
| Max stored candidates per argument    | 500 (excess truncated server-side)         |
| Max returned candidates per request   | 100 (with `hasMore: true` when more match) |
| Max `argument.value` (partial) length | 1024 chars (excess → `INVALID_PARAMS`)     |

### Scope enforcement

| Ref type       | Required scope   | Why                                                                              |
| -------------- | ---------------- | -------------------------------------------------------------------------------- |
| `ref/prompt`   | `prompts:read`   | Completion is metadata about a prompt the client must already be allowed to read |
| `ref/resource` | `resources:read` | Same logic for resources                                                         |

Without this gate, completion would be a free side-channel around the scope check on `prompts/list` and `resources/list`. The scope is checked per-request inside `handleCompletionComplete`.

### Edge behaviour

- Prefix match is case-insensitive (`f` matches `France` and `finland`).
- Empty partial returns all candidates (subject to the 100/500 cap).
- Unknown prompt name / unknown resource URI returns an empty completion (`values: []`) rather than an error — clients should show "no suggestions" UX.
- Non-string entries in admin-saved candidate lists are silently skipped (defensive narrowing).

## Prompts

Prompts are admin-editable slash-command templates surfaced by MCP clients to end users. They are **not** auto-invoked by the model — a human picks them from a menu (e.g. typing `/analyze-pattern` in Claude Desktop). The distinction matters for design:

| Primitive | Triggered by             | Used for                                               |
| --------- | ------------------------ | ------------------------------------------------------ |
| Tool      | Model decides to call    | Functions the model can invoke (send email, run query) |
| Resource  | Model or client browses  | Read-only context data (knowledge, agent list)         |
| Prompt    | End user picks from menu | Slash-command templates the user runs deliberately     |

### Storage and registry

`McpExposedPrompt` rows back the registry; `prompt-registry.ts` caches the enabled set for 5 minutes (matching the resource registry). On admin mutations the cache is cleared and `notifications/prompts/list_changed` is broadcast to connected clients.

For freshly installed deployments that haven't run seed `015-mcp-prompts` yet, the registry falls back to two hardcoded legacy prompts (`analyze-pattern`, `search-knowledge`) so clients see something useful immediately. DB rows always take precedence over the fallback.

### Template syntax (server-side enforcement)

Templates use `{{argument_name}}` substitution. The MCP protocol does not specify a templating engine — every server picks its own. Sunrise's engine is intentionally minimal and the rules below are **server-side guarantees**, not protocol-level ones (a different MCP server may behave differently):

- **Only argument names declared in `argumentsSpec` are interpolated.** Stray placeholders like `{{database_url}}` render literally. This is the security boundary that prevents an admin from accidentally (or maliciously) leaking server state. Other MCP server implementations may evaluate undeclared placeholders differently — write templates as if only declared names are safe.
- Whitespace inside placeholders is tolerated (`{{ name }}` works).
- Undefined optional args render as empty strings.
- Required args missing from `prompts/get` arguments cause `INVALID_PARAMS` (`Missing required argument(s): ...`).
- **Unknown args** passed by the client are silently ignored at render time (lenient toward clients that pass legacy fields). They are not rejected, but they are also not interpolated unless declared.
- Rendered output is capped at **64 KB** — anything bigger causes `INVALID_PARAMS`.

No helpers, no partials, no conditionals, no lambdas. If the prompt-set needs templating power, add it explicitly with a security review — don't reach for Handlebars.

### Limits

- Max **200 enabled prompts** per server. Create / re-enable beyond the cap returns HTTP 409 with `code: PROMPT_CAP_EXCEEDED`. Cap exists so MCP clients showing a slash-command menu don't drown in options.
- Template max **10,000 characters** at the source; rendered max **64 KB**.
- Max **20 arguments per prompt**.

### Treating prompt identity as a stable API contract

MCP itself does not formally require prompt names to be immutable, but clients cache prompt identifiers, users build workflows around them, and end-users bookmark slash commands. In practice **prompt names and argument schemas are an API contract**. Sunrise enforces this at the schema layer — `name` is not in `updatePromptSchema`, so the admin UI cannot rename a prompt in place. To evolve a prompt's behaviour, **add a new versioned name** rather than mutating the existing one:

```
analyse-pattern-v1   (the original)
analyse-pattern-v2   (next iteration — added required `language` arg)
```

Existing clients keep working against `-v1`; new clients adopt `-v2` on their own schedule. When `-v1` is no longer in active use, delete it.

### Backward compatibility matrix

What's safe to change on a deployed prompt and what isn't:

| Change                                    | Compatibility            | Notes                                                                                                                                                                                                                                                                                |
| ----------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Add an optional argument                  | Usually safe             | Existing clients omit it; engine renders empty                                                                                                                                                                                                                                       |
| Add a required argument                   | **Breaking**             | Existing invocations get `INVALID_PARAMS`. Add as optional first, then promote later.                                                                                                                                                                                                |
| Remove an argument                        | **Potentially breaking** | Sunrise tolerates clients still passing the removed name (renders nothing), but: any template still referencing `{{removed}}` will render that placeholder literally — visible to users. Other MCP servers may reject unknown args outright. Update the template at the same commit. |
| Rename an argument                        | **Breaking**             | A rename is "remove + add" from every client's perspective. Equivalent to a new required arg.                                                                                                                                                                                        |
| Rename the prompt                         | **Breaking**             | Every client / bookmark / saved workflow breaks. Use a versioned new name instead.                                                                                                                                                                                                   |
| Change semantics of the template silently | **Breaking in practice** | Wire format is identical but the meaning changes — users see surprising behaviour. Version the prompt rather than rewriting in place.                                                                                                                                                |
| Change `description`                      | Safe                     | Display-only.                                                                                                                                                                                                                                                                        |
| Toggle `isEnabled`                        | Safe at protocol level   | `notifications/prompts/list_changed` fires; well-behaved clients re-list.                                                                                                                                                                                                            |

### Prompts vs Tools — common misuse

A common temptation is to use prompts as "lightweight tools" — admin types a template that asks the model to do something. This breaks the primitive separation:

- **Prompt**: a user-facing UX surface. The end user has to deliberately select it.
- **Tool**: a machine-callable function. The model decides when to invoke.

Heuristic: if the server is expected to execute logic, call APIs, mutate state, or compute results autonomously, it belongs in a **tool**, not a prompt. Prompts are templates the user runs; tools are functions the model runs.

## Session Management

- In-memory `Map<string, McpSession>`, 1hr TTL
- Created on `initialize`, identified by `Mcp-Session-Id` header
- `maxSessionsPerKey` enforced per API key
- Sessions lost on restart (clients re-initialize per MCP spec)
- Expired sessions are evicted lazily on `getSession()` access, not by a proactive timer — an expired session may still appear in the admin sessions list until it is next accessed or the list is refreshed
- Admin can force-terminate sessions via `DELETE /api/v1/admin/orchestration/mcp/sessions/:id` or the Sessions page UI

## Admin Pages

| Path                                 | Purpose                                            |
| ------------------------------------ | -------------------------------------------------- |
| `/admin/orchestration/mcp`           | Dashboard: master toggle, stats, connection config |
| `/admin/orchestration/mcp/tools`     | Enable/disable capabilities as MCP tools           |
| `/admin/orchestration/mcp/resources` | Enable/disable data resources                      |
| `/admin/orchestration/mcp/prompts`   | Create/edit/disable slash-command prompt templates |
| `/admin/orchestration/mcp/keys`      | Create/revoke API keys                             |
| `/admin/orchestration/mcp/audit`     | Audit log with manual purge button                 |
| `/admin/orchestration/mcp/settings`  | Rate limits, session limits, retention             |

## MCP Protocol Compliance

- Transport: Streamable HTTP
- Protocol versions: `2025-06-18` (latest) and `2024-11-05` (back-compat). Negotiated per session during `initialize`.
- Messages: JSON-RPC 2.0 (single and batch requests)
- Capabilities advertised: `tools.listChanged`, `resources.listChanged`. `prompts.listChanged`, `resources.subscribe`, `logging`, and `completions` land in subsequent phases — the server never advertises a capability it cannot serve.
- Resource templates: `resources/templates/list` advertises parameterized URI patterns
- Pagination: `tools/list` and `resources/list` support cursor-based pagination (50 items/page)
- Batch requests: JSON-RPC 2.0 array batches (max 20 requests per batch)
- SSE notifications: `notifications/tools/list_changed` and `notifications/resources/list_changed` pushed to connected clients when admin toggles tools/resources
- Client notifications accepted: `notifications/initialized`, `notifications/roots/list_changed`, `notifications/cancelled`

### Version negotiation

`initialize` reads the client's requested `protocolVersion` and chooses the response per these rules:

| Client sends                                        | Server responds with            | Why                                                    |
| --------------------------------------------------- | ------------------------------- | ------------------------------------------------------ |
| A supported version (`2025-06-18` or `2024-11-05`)  | The same version                | Honour explicit choice                                 |
| No `protocolVersion` field                          | Oldest supported (`2024-11-05`) | Conservative default — likely a pre-negotiation client |
| A forward-dated unknown version (e.g. `2099-01-01`) | Latest supported (`2025-06-18`) | Graceful downgrade for newer clients                   |
| Any other unknown / malformed value                 | `INVALID_PARAMS` error          | Surface mismatch rather than silently misbehave        |

The negotiated version is stored on the session (`McpSession.protocolVersion`) and is available to per-call handlers for branching on features that exist only in newer revisions. The legacy `MCP_PROTOCOL_VERSION` export still resolves to the oldest supported version so downstream imports keep working.

### Authentication challenge (WWW-Authenticate)

401 responses include `WWW-Authenticate: Bearer realm="sunrise-mcp", error="invalid_token"` (RFC 6750 / RFC 9728). 2025-spec MCP clients use this to detect that the server is bearer-only and skip the OAuth discovery dance. OAuth 2.1 + DCR is captured as a separate roadmap item (see "Authentication" section below — to be added in Phase 7).

### Error codes

| Code   | Name              | Meaning                                                                                                  |
| ------ | ----------------- | -------------------------------------------------------------------------------------------------------- |
| -32700 | PARSE_ERROR       | Body is not valid JSON, or body exceeds the 1 MB size cap                                                |
| -32600 | INVALID_REQUEST   | JSON-RPC envelope is malformed, batch is empty / too large, or `initialize` is mixed with other requests |
| -32601 | METHOD_NOT_FOUND  | Unknown method                                                                                           |
| -32602 | INVALID_PARAMS    | Method-specific param validation failed                                                                  |
| -32603 | INTERNAL_ERROR    | Unhandled server error (no internals leaked)                                                             |
| -32001 | UNAUTHORIZED      | Missing / invalid bearer token (paired with HTTP 401 + `WWW-Authenticate`)                               |
| -32002 | SESSION_NOT_FOUND | Unknown / expired `Mcp-Session-Id`, or session belongs to a different key                                |
| -32003 | SERVER_DISABLED   | Master `isEnabled` toggle is off                                                                         |
| -32004 | RATE_LIMITED      | Per-key or global rate limit exceeded — client should back off and retry                                 |

## Client Configuration

Claude Desktop example (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "sunrise": {
      "url": "https://your-app.com/api/v1/mcp",
      "headers": {
        "Authorization": "Bearer smcp_your_key_here"
      }
    }
  }
}
```

## No External Dependencies

JSON-RPC 2.0 is hand-rolled (~100 lines of types). Crypto uses Node.js built-in `crypto`. SSE reuses `lib/api/sse.ts`. Rate limiting reuses `lib/security/rate-limit.ts`.
