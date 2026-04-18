# MCP Server v1.1 Enhancement Plan

All four enhancements have been implemented and tested. This document is retained for reference.

## Current State (v1.0)

- Protocol: MCP 2024-11-05, Streamable HTTP transport, JSON-RPC 2.0
- Capabilities: `tools`, `resources`, `prompts` (all working)
- Auth: bearer tokens (SHA-256 hashed), scoped, rate-limited
- Admin UI: 6 pages, info modals, FieldHelp on all form fields
- Audit: full logging with manual purge
- Tests: 335+ unit tests across 14 files

---

## Enhancement 1: Resource Templates (`resources/templates`)

**What:** The MCP spec supports `resources/templates` for advertising URI templates (RFC 6570). Currently `sunrise://knowledge/patterns/{number}` works via pattern matching but clients have no way to discover it.

**Why:** Clients like Claude Desktop can auto-complete parameterized URIs if they know the template. Without this, clients must hardcode or guess URI patterns.

**Scope:**

| Area                   | Change                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `protocol-handler.ts`  | Add `resources/templates` method that returns URI templates                                                       |
| `resource-registry.ts` | Add `listMcpResourceTemplates()` that queries `McpExposedResource` rows whose URIs contain `{param}` placeholders |
| `types/mcp.ts`         | Add `McpResourceTemplate` interface (`uriTemplate`, `name`, `description`, `mimeType`)                            |
| No DB changes          | Template info is derived from existing `McpExposedResource.uri` field                                             |

**Estimate:** Small. ~50 lines of code + tests.

---

## Enhancement 2: Pagination on List Methods

**What:** `tools/list` and `resources/list` currently return all items at once. The MCP spec supports optional cursor-based pagination via a `cursor` param and `nextCursor` in the response.

**Why:** Not a problem at current scale (most deployments will have <50 tools and <20 resources), but could become one if a deployment exposes hundreds of capabilities.

**Scope:**

| Area                   | Change                                                              |
| ---------------------- | ------------------------------------------------------------------- |
| `protocol-handler.ts`  | Accept optional `cursor` param in `tools/list` and `resources/list` |
| `tool-registry.ts`     | Accept pagination params, return `{ tools, nextCursor? }`           |
| `resource-registry.ts` | Accept pagination params, return `{ resources, nextCursor? }`       |
| `types/mcp.ts`         | Add cursor types                                                    |
| Cursor strategy        | Encode `offset` as opaque base64 string; decode on receipt          |

**Estimate:** Medium. ~100 lines of code + tests. Consider deferring until a deployment actually has >100 tools.

---

## Enhancement 3: SSE Change Notifications

**What:** When an admin toggles a tool or resource on/off, connected MCP clients should receive a `notifications/tools/list_changed` or `notifications/resources/list_changed` notification via the SSE stream so they can refresh their cached lists.

**Why:** Currently clients only discover changes on reconnect. This means if an admin disables a tool, clients may still try to call it until they reconnect (getting an error). Not a correctness issue (the tool call will fail gracefully) but a UX one.

**Scope:**

| Area                                  | Change                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `session-manager.ts`                  | Add a `broadcastToKey(apiKeyId, notification)` method; sessions track their SSE write stream            |
| `app/api/v1/mcp/route.ts` GET handler | Register the SSE response writer with the session manager instead of using a static keepalive generator |
| Admin tool/resource PATCH routes      | After mutation, call `sessionManager.broadcastAll(notification)`                                        |
| `index.ts`                            | Export broadcast helpers                                                                                |

**Key design decisions:**

- Broadcast to all sessions (not just the key that made the admin change, since admin auth is separate from MCP auth)
- Fire-and-forget — if a client's SSE stream is broken, the notification is lost (client will re-initialize on reconnect anyway)
- Notifications are one-way (server → client), no response expected

**Estimate:** Medium-large. ~150 lines + tests. Requires careful handling of SSE stream lifecycle and connection cleanup.

---

## Enhancement 4: Batch JSON-RPC Requests

**What:** JSON-RPC 2.0 allows sending an array of requests in a single HTTP call. The server processes them all and returns an array of responses. Currently the route handler only parses single request objects.

**Why:** Batch support is part of the JSON-RPC 2.0 spec and some clients may use it for efficiency (e.g., calling `tools/list` + `resources/list` + `prompts/list` in one request after initialize).

**Scope:**

| Area                      | Change                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `app/api/v1/mcp/route.ts` | Detect array vs object in parsed body; if array, map each to `handleMcpRequest()`, collect responses, return array |
| `lib/validations/mcp.ts`  | Update `jsonRpcRequestSchema` or add batch variant that accepts `z.array(jsonRpcRequestSchema)`                    |
| Audit                     | Each sub-request within the batch is audited individually (already handled by `handleMcpRequest`)                  |
| Rate limiting             | Each sub-request counts against the rate limit individually                                                        |

**Constraints:**

- Max batch size: 20 requests (prevent abuse)
- Notifications in a batch return no response (per spec, omit from response array)
- If entire batch is empty or all notifications, return 204

**Estimate:** Small-medium. ~60 lines + tests.

---

## Priority Order

1. **Batch requests** — smallest effort, spec compliance
2. **Resource templates** — small effort, improves client UX for parameterized resources
3. **Change notifications** — medium effort, nice-to-have for real-time admin changes
4. **List pagination** — defer until needed; current scale doesn't warrant it

## Dependencies

None of these enhancements depend on each other. They can be implemented independently in any order.
