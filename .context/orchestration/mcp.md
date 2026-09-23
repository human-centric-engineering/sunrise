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
  |-- MCP-Protocol-Version header → the revision to answer at
  v
lib/orchestration/mcp/protocol-handler.ts
  |
  |-- initialize                → answered for older clients; issues no session id
  |-- tools/list                → tool-registry.ts → McpExposedTool + AiCapability (+ annotations on 2025-06-18)
  |-- tools/call                → tool-registry.ts → capabilityDispatcher.dispatch() (+ rich content blocks)
  |-- resources/list, /templates, /read
  |                             → resource-registry.ts → sunrise:// URI handlers
  |-- prompts/list, /get        → prompt-registry.ts (DB-backed cache, legacy fallback)
  |-- completion/complete       → completion-registry.ts (static lookup only)
  v
Audit log (fire-and-forget → McpAuditLog)

GET /api/v1/mcp     → 405, Allow: POST
DELETE /api/v1/mcp  → 405, Allow: POST
```

## One transport, and it holds nothing

**Every request stands alone.** No `Mcp-Session-Id` is issued, one arriving is
ignored, `GET` and `DELETE` answer `405` with `Allow: POST`, and there is no
server-to-client stream. There is no mode switch: `MCP_SESSION_MODE` was removed
in §39 t-718 along with the stateful transport it selected.

That is the shape MCP revision
[`2026-07-28`](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
specifies. It removes protocol-level sessions, the session headers and the
`initialize` handshake; removes the GET stream and with it SSE resumability and
message redelivery; tells a modern-only server to answer `405` for GET and DELETE
and to **ignore** a legacy `Mcp-Session-Id` or `Last-Event-ID` rather than error
on one; and tells a server needing cross-call state to use explicit handles
passed as tool arguments. `initialize` is still answered, because a
`2024-11-05` or `2025-06-18` client opens with one.

### Why the other transport went

It held its sessions in a per-process `Map`, which is wrong anywhere more than
one process serves traffic — and that was not theoretical. `initialize` minted a
session on instance A and returned its id; the client's next call was
load-balanced to instance B, which looked that id up in its **own** empty map and
returned `404 Session not found or expired`. Observed in production on Vercel:
one session id, one instant, three instances, two 404s and a 200. No client retry
recovered it, because the session was not lost — it was invisible to live
siblings — so re-initialising repeated the race.

It had also become actively wrong for current clients: a `2026-07-28` client
sends no `initialize` and no session id, and got `400 Missing Mcp-Session-Id
header` for it.

Nothing was running it when it was removed. It threw at module scope on `VERCEL`
or `AWS_LAMBDA_FUNCTION_NAME`, the platform deploys to Vercel, and the owner
confirmed on 2026-09-23 that no fork ran it.

### What went with it, and where push lives now

| Gone                                                   | Replacement in revision 2026-07-28                                                  |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `GET` SSE stream                                       | `subscriptions/listen` — a stream opened from a REQUEST, with a filter              |
| `resources/subscribe` / `resources/unsubscribe`        | the `resourceSubscriptions: string[]` filter on that request                        |
| `notifications/{tools,prompts,resources}/list_changed` | the `toolsListChanged` / `promptsListChanged` / `resourcesListChanged` filter flags |
| `logging/setLevel` + `notifications/message`           | nothing — Logging is deprecated in the spec                                         |
| `notifications/progress`                               | still in the spec, but needs a stream to travel down                                |

An attempt at one of the three removed methods now gets `METHOD_NOT_FOUND`, like
any other unimplemented method. It used to get `STATELESS_UNSUPPORTED`
(`-32005`), which said "the method exists, the deployment cannot carry it" — true
while one of two transports could, and misleading now. That error code is gone
from `JsonRpcErrorCode`.

**`subscriptions/listen` is not implemented** (Hub idea #8). It is a different
design problem from the one that killed the old transport: a long-lived stream on
a function-per-request platform, rather than state shared across processes. Two
things settled on the way out are the design input for it, and are on the project
journal rather than only here:

- **A push audience is decided by what CHANGED, not by who is subscribed.** Every
  org's clients would filter on the same `sunrise://…` URI, so the URI decides
  nothing. The three `listChanged` flags concern `McpExposedTool`,
  `McpExposedPrompt`, `McpExposedResource` and `AiCapability` — all
  `GLOBAL_CONFIG_MODELS` (`lib/tenancy/classification.ts`) — so every listener
  hears them. A `resourceSubscriptions` entry over `sunrise://agents` is one
  org's contents, and only that org should hear it.
- **A session id is not a capability; the key is.** This gets easier rather than
  harder: a listen stream is a request with its own org scope, so there is no id
  for a caller to present, and nothing to check it against.

### The protocol version, per request

The version comes from the client's `MCP-Protocol-Version` header (a MUST on
every request from spec revision 2025-06-18 onward). The route delegates to
`negotiateMcpProtocolVersion`, the same function the `initialize` path uses:

| Header                             | Result                                              |
| ---------------------------------- | --------------------------------------------------- |
| missing / malformed                | oldest supported (`2024-11-05`) — most conservative |
| a version we support               | itself                                              |
| date-shaped, newer than our latest | **downgraded to our latest**, not floored           |
| date-shaped, older and unknown     | oldest supported                                    |

**A client that negotiated `2025-06-18` at `initialize` but omits the header on
later requests gets `2024-11-05` semantics, and loses tool annotations.** That is
the correct reading — the header is a MUST, so a client that omits it is
non-conforming, and nothing here remembers what it agreed to. It also fails safe:
MCP's defaults for an absent annotation are `destructiveHint: true` /
`readOnlyHint: false`, the cautious assumption.

The forward-dated row is the one that matters. A `2026-07-28` client understands
strictly more than the server does; flooring it to `2024-11-05` would mean the
newer the client, the worse it is treated — and `protocol-handler` gates tool
annotations on `>= 2025-06-18`, so the newest clients would silently lose them on
the default path. Do not re-derive this rule at a call site; delegate to the
function that already draws the distinction.

### What `initialize` advertises

`{ tools: {}, resources: {}, prompts: {}, completions: {} }`, and the four empty
objects are the point. Every capability that PROMISED A PUSH is absent:
`listChanged`, `resources.subscribe`, and `logging: {}` — which _is_ the signal
that `logging/setLevel` works, so emptying it would still have advertised it.
They are absent from the `McpCapabilities` type as well as from the response, so
re-adding one has to be deliberate; under 2026-07-28 the listen filter is a
request parameter rather than an `initialize` capability, so they would not come
back in this shape anyway.

`completions` stays: `completion/complete` is a plain request/response lookup
that pushes nothing.

**The server never advertises a capability it cannot serve.** Not advertising is
the fix rather than refusing the call, because a conforming client then never
asks.

An optional `_meta.progressToken` on `tools/call` or `resources/read` is
**ignored** — not validated, not refused. Nothing can deliver a progress
notification, so refusing a whole tool call over a field the server discards
would fail work for no gain. Same rule the spec states for a stray session
header: ignore what you no longer honour.

## Key Files

| Area          | Files                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| Core library  | `lib/orchestration/mcp/` (12 files + 4 resource handlers, platform-agnostic)                            |
| Transport     | `app/api/v1/mcp/route.ts` (POST; GET and DELETE answer 405)                                             |
| Admin API     | `app/api/v1/admin/orchestration/mcp/` (6 route trees: tools, resources, prompts, keys, settings, audit) |
| Admin UI      | `app/admin/orchestration/mcp/` (7 pages: dashboard + tools, resources, prompts, keys, settings, audit)  |
| Components    | `components/admin/orchestration/mcp/` (8 components)                                                    |
| Types         | `types/mcp.ts`                                                                                          |
| Validation    | `lib/validations/mcp.ts`                                                                                |
| Prisma models | McpServerConfig, McpExposedTool, McpExposedResource, McpExposedPrompt, McpApiKey, McpAuditLog           |

## Security Model

| Layer              | Mechanism                                                                               |
| ------------------ | --------------------------------------------------------------------------------------- |
| Auth               | Bearer token (`smcp_` prefix, SHA-256 hashed), scope-based, bound to one org (§106)     |
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
6. **Application scope carrier** — a key may carry an optional `scope` (`McpApiKey.scope`, a flat string→string map, distinct from the protocol `scopes` above). It is validated on read (`mcpKeyScopeSchema`) and folded into `CapabilityContext.scope` for every `tools/call`. That carrier is marked **authoritative**, so it may drive a capability's declared scope binding: a capability registered with `{ scopedBy: 'projectId' }` has that argument filled when the caller omits it, and a call naming a different value is refused with `scope_conflict` (step 7a re-asserts on the args `execute` actually receives, so a schema transform cannot undo it). A capability that declares no binding is untouched. See [the scope binding](./capabilities.md#the-scope-binding-scopedby-dispatch-steps-4b--7a). Core names no keys; a fork maps it to its own domain (e.g. `{ projectId }`). NULL = unscoped (unchanged behaviour). Set it as opaque JSON on create/PATCH; clearing it via PATCH uses the `Prisma.DbNull` sentinel. A malformed stored value is dropped at auth (key treated as unscoped) rather than failing authentication.
7. **Key rotation:** `POST /api/v1/admin/orchestration/mcp/keys/:id/rotate` — generates new key material, returns new plaintext once, immediately invalidates the old key. Optionally set `{ expiresAt }` in the body. The key's org is never touched.
8. **Org binding (§106)** — a key is bound at mint to the org the admin's request was acting in (`orgId`, returned on create, in the list and after a rotation), and the transport runs every request inside it: `authenticateMcpRequest` answers the key's org and `app/api/v1/mcp/route.ts` wraps each method in `runAsOrg(orgId, …, { source: 'mcp-key' })`, so tool calls, resource reads and the audit row all carry it. A key outlives its creator (`createdBy` is `SetNull`) but not its org (`Cascade`). There is no user behind a key at request time, so the org's own status is checked on the same read as the key: **a suspended org's keys are refused** (`401`) and work again once it is reinstated. A key whose `orgId` is `null` (minted before 0.13.0's backfill re-run) reads as the install org at `single` and is refused at `multi`. See [`tenancy/context.md`](../tenancy/context.md).

## Authentication & OAuth 2.1 Roadmap

The server currently authenticates clients with **bearer tokens** (the `smcp_` keys above). The 2025-06-18 MCP spec recommends OAuth 2.1 + Dynamic Client Registration (DCR) for HTTP transport but explicitly permits bearer auth, which is what Sunrise ships today.

### Bridge for 2025-spec clients

401 responses include a `WWW-Authenticate: Bearer realm="sunrise-mcp", error="invalid_token"` header (RFC 6750 / RFC 9728). 2025-spec OAuth-capable clients use this to detect that the server is bearer-only and skip OAuth discovery rather than failing on the missing `/.well-known/oauth-authorization-server` endpoint. End users keep pasting an `smcp_` key into their client config exactly as before.

This is sufficient for the common deployment shape (dev or internal use, admins distributing keys to developers they trust), and a key is bound to an org (below), so at `multi` a key acts only in the org it was minted in. What bearer auth does **not** give a multi-tenant SaaS is per-end-user identity — every caller on a key is the key — and per-org scoping of the tools and prompts a key can see (§107/§111); the first is what OAuth solves.

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
3. `tools/list` joins both tables and serves the doubly-enabled tools. When the calling key is **bound to an agent** (`scopedAgentId`), the list is filtered so discovery matches dispatch: a capability **explicitly disabled** for that agent (an `AiAgentCapability` row with `isEnabled = false`) is hidden, because `tools/call` would refuse it (step 4). Scoping is **default-allow** — a capability with no binding row stays callable and stays listed; only explicit disables are honoured (same opt-out semantics as the dispatcher). Unscoped keys see the full global list. The global list stays cached (5-min TTL); the per-agent disable filter is a small live query.
4. `tools/call` dispatches through `capabilityDispatcher.dispatch()` under the key's `scopedAgentId` when the key is bound to an agent, else the shared `mcp-system` agent — the same resolution the `resources/read` path uses, so cost/budget attribution and knowledge-base grant resolution (`resolveAgentDocumentAccess`) follow the scoped agent. It also threads the optional per-dispatch `scope` carrier (`CapabilityContext.scope`) through to `execute()`, marked authoritative so it can bind the arguments of a capability that declared `scopedBy`. A direct call to a tool disabled for the scoped agent still resolves (name lookup uses the unscoped list) and returns `capability_disabled_for_agent` — whose message deliberately names no agent id (the internal cuid stays in server logs only).
5. Full 9-step pipeline applies: validation, rate limiting, execution, cost tracking

> **A capability rename pins the advertised tool name rather than moving it (#509).** `tools/list` advertises `customName ?? functionDefinition.name`, and `tools/call` resolves an incoming call by that advertised name. Since #509 every write forces `functionDefinition.name` to equal the `slug`, which would have renamed the published tool of any capability created through the admin UI before that release (they diverged by default). The capability PATCH route therefore copies the displaced name into `customName` in the same transaction, so the external contract is pinned exactly where it was. Rows that already carry a `customName` are left alone — an operator's own choice wins. A displaced name that cannot satisfy `^[a-z][a-z0-9_]*$` is **not** pinned: it would fail validation the next time the MCP row was edited, so that rename proceeds and is logged instead.

> **`tools/list` ↔ `tools/call` parity.** Since a scoped key's `tools/list` hides capabilities explicitly disabled for its agent, everything a scoped key can discover, it can call without a `capability_disabled_for_agent` error. Default-allowed-but-unbound tools remain both listed and callable. (Whether "scoped" should ever mean allow-list-only rather than default-allow is a deliberate open question tied to per-key project scope — not this behaviour.)

> **Rate-limit bucket semantics under scoped keys.** The dispatcher rate limiter is keyed on `(capabilitySlug, agentId)`. Because step 4 resolves `agentId` from the key's `scopedAgentId`, each scoped key gets its **own** per-capability bucket, whereas all unscoped keys share the single `mcp-system` bucket per capability. So a capability's `rateLimit` acts as a **per-scoped-agent** cap for scoped traffic, not a single global MCP cap — `N` scoped keys permit up to `N ×` the configured limit in aggregate. This is intended (per-tenant fairness); size `rateLimit` accordingly for expensive tools.

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

When a URI does not match any registered resource exactly, `readMcpResource` falls back to pattern matching against all enabled resources. A row matches if the requested URI either **starts with** the template's fixed prefix (the template stripped of its `{param}`s) **or** fills the template exactly, one path segment per `{param}`. The prefix test alone only ever worked for a template whose `{param}` was the last segment — `hub://projects/{id}/plan` collapses to `hub://projects//plan`, which no concrete URI starts with — so the exact-fill test was added alongside it rather than replacing it. Pattern matching uses first-match-wins order (database insertion order). If multiple resource patterns could match the same URI, the first match is used. Both exact and pattern-match handler calls are wrapped in try-catch — handler failures return an error content block instead of propagating.

### Fork-owned resource types (`lib/app/mcp-resources.ts`)

Sunrise's four types above are built in. A fork adds its own without editing core, mirroring the capability seam:

```ts
// lib/app/mcp-resources.ts — ships empty
import { registerMcpResourceHandler } from '@/lib/orchestration/mcp/resource-registry';

export function initAppMcpResources(): void {
  registerMcpResourceHandler({
    resourceType: 'project_plan',
    uriScheme: 'hub', // → hub://projects/{id}/plan
    handler: handleProjectPlan, // (uri, config, callContext) => Promise<McpResourceContent>
  });
}
```

`resourceType` must be lower snake_case, max 64 characters — the same shape `createExposedResourceSchema` enforces, validated at registration too so a `projectPlan` fails loudly here rather than reporting dispatchable and then 400ing every create with a message that never mentions the registration.

A throwing init rolls back every registration it had already made, so a half-configured resource is never left dispatchable — this registry has the most to lose from a partial apply, because a registered handler serves reads and its scheme is accepted at create.

The registry calls `initAppMcpResources()` once, lazily, before the first dispatch **and** before the admin create route validates a row — both are route-realm reads, so a registration made from `initApp()` would fill a map the MCP route never sees.

An app type then flows through `resources/list|read|subscribe`, templates, the 5-minute cache, `resources:read` scoping, `McpExposedResource` gating and audit exactly like a core one. Rows still default to `isEnabled: false`, so this widens what an admin can turn on, not who can turn it on.

Five constraints:

| Constraint                                            | Why                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uriScheme` is required                               | A fork resource inheriting `sunrise://` advertises the starter's identity to every client that lists it. Pass `'sunrise'` explicitly if that is intended.                                                                                                                                      |
| The `uriScheme` is bound to the `resourceType`        | Checked as a PAIR at create. `sunrise://projects/x/plan` under a `project_plan` registered as `hub` passes both independent checks and then lists fork data under the platform's scheme — the inheritance `uriScheme` is required in order to prevent. Built-in types are pinned to `sunrise`. |
| A built-in `resourceType` cannot be overridden        | `resourceType` is the only link between a seeded row and its handler, so a shadowing registration would change what `sunrise://agents` returns.                                                                                                                                                |
| `http(s)`, `file`, `data`, `javascript`, … banned     | A resource URI is echoed to clients in `resources/list`; none of them should look like a fetchable web address.                                                                                                                                                                                |
| A stored URI's scheme is matched **case-sensitively** | `readMcpResource` looks a row up by exact URI, so `SUNRISE://agents` would store fine and then never dispatch. `registerMcpResourceHandler` still lowercases the scheme a fork _registers_ — forgiving about config, exact about stored data.                                                  |

Validation on create is **dispatchability**, not a constant: `POST /api/v1/admin/orchestration/mcp/resources` calls `isDispatchableMcpResourceType()` and `isAllowedMcpResourceUri()`. That is strictly stronger than the closed Zod enum it replaced — it also rejects a core type whose handler has gone missing. It lives in the route rather than in `lib/validations/mcp.ts` because that module is imported by `'use client'` components and the registry reaches whatever the fork imports in `lib/app/`.

The admin create form's type dropdown lists core types only; create an app-typed row from a seed or the API.

After creation, **`uri` and `resourceType` are immutable** — the registry routes reads by URI prefix and dispatches by `resourceType`, so changing either mid-life would orphan in-flight client subscriptions. To rename or re-type a resource, delete it and create a new one (per the dialog warning in the admin UI).

### Subscriptions, and what replaces them

**`resources/subscribe` and `resources/unsubscribe` are gone** (§39 t-718), along
with the per-URI `notifications/resources/updated` fan-out, the 50-per-session
subscription cap, and the named `resource-update-hooks` helpers that mutation
routes called. All of it delivered down one pipe — the SSE sink a stateful session
held — and there is no such sink. A call gets `METHOD_NOT_FOUND`, and `initialize`
advertises no `resources.subscribe`, so a conforming client never asks.

Under revision 2026-07-28 a client would express the same interest as a
`resourceSubscriptions: string[]` filter on a `subscriptions/listen` request. That
is not implemented — see
[What went with it, and where push lives now](#what-went-with-it-and-where-push-lives-now)
for the two design decisions carried forward, including why the audience is
decided by what changed rather than by who subscribed.

The mutation sites that used to fire an update are recoverable rather than listed
here: `git log -S notifyMcpAgentsChanged` finds all of them, which a hand-copied
table in this file would not stay accurate about.

**`clearMcpToolCache()`, `clearMcpResourceCache()` and `clearMcpPromptCache()`
stayed at every one of those sites.** Cache invalidation is what makes the next
`tools/list` correct, and has nothing to do with push.

## Progress notifications and the Logging API

**Both are gone** (§39 t-718), because both were server-push over a session's SSE
stream.

- `notifications/progress` had a reporter (`createProgressReporter`), a
  50-per-second-per-session cap and an opt-in per capability. A capability that
  wants to report progress today has nowhere to send it. An optional
  `_meta.progressToken` on `tools/call` or `resources/read` is accepted and
  ignored — see [What `initialize` advertises](#what-initialize-advertises) for
  why that is not an error.
- `logging/setLevel` and `notifications/message` had the 8 RFC 5424 levels, a
  per-session minimum severity defaulting to `warning`, and an `emitMcpLog` helper
  with its own rate caps. `emitMcpLog` never had a caller in the platform — it was
  a fork seam — and Logging is deprecated in revision 2026-07-28, so it goes
  rather than waiting for a transport that will not carry it.

Internal server-side logging is unaffected: it goes to `lib/logging`, and never
went to the MCP wire.

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

## Session management — there is none

There is no session map, no TTL, no eviction sweep, no per-key session cap and no
admin Sessions page. `GET /api/v1/admin/orchestration/mcp/sessions` and
`DELETE …/sessions/:id` are removed, and `McpServerConfig.maxSessionsPerKey` is
dropped by migration — it was read in exactly one place, the `createSession` call
on the transport that went.

Three things that were true of sessions are worth keeping, because each one is a
rule rather than a detail:

- **A session id was never a capability; the key is.** `POST`, `DELETE` and — from
  §108 t-716 — `GET` all refused a session whose `apiKeyId` was not the
  authenticated key's. `GET` was the path that attached the SSE listener, so
  before that fix a caller with any valid key could open the stream with another
  key's `Mcp-Session-Id` and receive that session's pushes while its owner
  silently stopped receiving them. Whatever replaces push must not reintroduce an
  id a caller presents; a `subscriptions/listen` request carries its own auth and
  its own org scope, which is the shape to keep.
- **A timer is stamped where it was armed, not where it fires.** The eviction
  sweep was armed through `runDetached` (§108 t-715) because the manager was a
  lazily constructed singleton, so the first MCP request after boot built it —
  inside that request's org — and an `AsyncLocalStorage` store is captured when
  `setInterval` is _called_. No timer in the tree needs detaching today; the rule
  and the primitive both remain. See
  [Tenant context](../tenancy/context.md#a-timer-is-stamped-where-it-was-armed-not-where-it-fires).
- **Liveness measured by POSTs, not by an open stream, was a design flaw.** A
  client that subscribed and then only listened was evicted at the 1-hour TTL: its
  sink was dropped, the stream went silent, and the SSE keepalive kept the
  connection looking healthy until its next POST returned 404. Anything
  long-lived that comes back has to refresh on the stream it is actually using.

## Admin Pages

| Path                                 | Purpose                                            |
| ------------------------------------ | -------------------------------------------------- |
| `/admin/orchestration/mcp`           | Dashboard: master toggle, stats, connection config |
| `/admin/orchestration/mcp/tools`     | Enable/disable capabilities as MCP tools           |
| `/admin/orchestration/mcp/resources` | Enable/disable data resources                      |
| `/admin/orchestration/mcp/prompts`   | Create/edit/disable slash-command prompt templates |
| `/admin/orchestration/mcp/keys`      | Create/revoke API keys                             |
| `/admin/orchestration/mcp/audit`     | Audit log with manual purge button                 |
| `/admin/orchestration/mcp/settings`  | Rate limits and audit retention                    |

## MCP Protocol Compliance

- Transport: Streamable HTTP
- Protocol versions: `2025-06-18` (latest) and `2024-11-05` (back-compat). Answered at `initialize`, and taken from the `MCP-Protocol-Version` header on every request, since nothing remembers a negotiation ([details](#the-protocol-version-per-request)).
- Messages: JSON-RPC 2.0 (single and batch requests)
- Capabilities advertised: `completions`, plus bare `tools` / `resources` / `prompts` objects. No `listChanged`, no `resources.subscribe`, no `logging` — each of those promises a push, and there is no stream to push down ([details](#what-initialize-advertises)). **The server never advertises a capability it cannot serve.**
- Resource templates: `resources/templates/list` advertises parameterized URI patterns
- Pagination: `tools/list` and `resources/list` support cursor-based pagination (50 items/page)
- Batch requests: JSON-RPC 2.0 array batches (max 20 requests per batch)
- Server-push: none. `GET` answers `405 Allow: POST`, no notification is ever emitted, and no listener is registered. Revision 2026-07-28 moves push to `subscriptions/listen`, which Sunrise does not implement ([details](#what-went-with-it-and-where-push-lives-now)).
- Client notifications accepted: `notifications/initialized`, `notifications/roots/list_changed`, `notifications/cancelled`
- `Mcp-Session-Id` and `Last-Event-ID`: ignored on the way in, never issued on the way out, per revision 2026-07-28

### Version negotiation

`initialize` reads the client's requested `protocolVersion` and chooses the response per these rules:

| Client sends                                        | Server responds with            | Why                                                    |
| --------------------------------------------------- | ------------------------------- | ------------------------------------------------------ |
| A supported version (`2025-06-18` or `2024-11-05`)  | The same version                | Honour explicit choice                                 |
| No `protocolVersion` field                          | Oldest supported (`2024-11-05`) | Conservative default — likely a pre-negotiation client |
| A forward-dated unknown version (e.g. `2099-01-01`) | Latest supported (`2025-06-18`) | Graceful downgrade for newer clients                   |
| Any other unknown / malformed value                 | `INVALID_PARAMS` error          | Surface mismatch rather than silently misbehave        |

Nothing is stored. The table above governs `initialize`'s own response, and every request — including that one — derives the version it is answered at from the `MCP-Protocol-Version` header ([details](#the-protocol-version-per-request)). The value reaches per-call handlers as `HandlerContext.protocolVersion`, for branching on features that exist only in newer revisions; it replaced a whole session object, which was the only thing any handler read off one. The legacy `MCP_PROTOCOL_VERSION` export still resolves to the oldest supported version so downstream imports keep working.

### Authentication challenge (WWW-Authenticate)

401 responses include `WWW-Authenticate: Bearer realm="sunrise-mcp", error="invalid_token"` (RFC 6750 / RFC 9728). 2025-spec MCP clients use this to detect that the server is bearer-only and skip the OAuth discovery dance. OAuth 2.1 + DCR is captured as a separate roadmap item (see "Authentication" section below — to be added in Phase 7).

### Error codes

| Code   | Name             | Meaning                                                                                                  |
| ------ | ---------------- | -------------------------------------------------------------------------------------------------------- |
| -32700 | PARSE_ERROR      | Body is not valid JSON, or body exceeds the 1 MB size cap                                                |
| -32600 | INVALID_REQUEST  | JSON-RPC envelope is malformed, batch is empty / too large, or `initialize` is mixed with other requests |
| -32601 | METHOD_NOT_FOUND | Unknown method                                                                                           |
| -32602 | INVALID_PARAMS   | Method-specific param validation failed                                                                  |
| -32603 | INTERNAL_ERROR   | Unhandled server error (no internals leaked)                                                             |
| -32001 | UNAUTHORIZED     | Missing / invalid bearer token (paired with HTTP 401 + `WWW-Authenticate`)                               |
| -32003 | SERVER_DISABLED  | Master `isEnabled` toggle is off                                                                         |
| -32004 | RATE_LIMITED     | Per-key or global rate limit exceeded — client should back off and retry                                 |

`-32002 SESSION_NOT_FOUND` and `-32005 STATELESS_UNSUPPORTED` were removed with
the stateful transport (§39 t-718). Nothing can emit either, so they are gone from
`JsonRpcErrorCode` rather than left as constants a fork might still switch on. A
call to one of the three removed methods answers `-32601 METHOD_NOT_FOUND`.

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
