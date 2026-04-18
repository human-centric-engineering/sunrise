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
  |-- tools/list  → tool-registry.ts → McpExposedTool + AiCapability
  |-- tools/call  → tool-registry.ts → capabilityDispatcher.dispatch()
  |-- resources/* → resource-registry.ts → sunrise:// URI handlers
  |-- prompts/*   → prompt-registry.ts → hardcoded templates
  v
Audit log (fire-and-forget → McpAuditLog)
```

## Key Files

| Area          | Files                                                                       |
| ------------- | --------------------------------------------------------------------------- |
| Core library  | `lib/orchestration/mcp/` (11 files, platform-agnostic)                      |
| Transport     | `app/api/v1/mcp/route.ts` (POST/GET/DELETE)                                 |
| Admin API     | `app/api/v1/admin/orchestration/mcp/` (10 route files)                      |
| Admin UI      | `app/admin/orchestration/mcp/` (6 pages)                                    |
| Components    | `components/admin/orchestration/mcp/` (7 components)                        |
| Types         | `types/mcp.ts`                                                              |
| Validation    | `lib/validations/mcp.ts`                                                    |
| Prisma models | McpServerConfig, McpExposedTool, McpExposedResource, McpApiKey, McpAuditLog |

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

## API Key Lifecycle

1. Admin creates key via UI or `POST /api/v1/admin/orchestration/mcp/keys`
2. Plaintext returned **once** (format: `smcp_<base62>`), SHA-256 hash stored
3. Client uses `Authorization: Bearer smcp_...` header
4. Scopes control access: `tools:list`, `tools:execute`, `resources:read`, `prompts:read`
5. Keys can be revoked immediately; `expiresAt` for automatic expiry

## Tool Exposure Flow

1. Admin enables a capability as an MCP tool via the Tools page
2. `McpExposedTool` row links to `AiCapability` with `isEnabled: true`
3. `tools/list` joins both tables, serves only doubly-enabled tools
4. `tools/call` dispatches through `capabilityDispatcher.dispatch()` using the `mcp-system` agent
5. Full 9-step pipeline applies: validation, rate limiting, execution, cost tracking

## Resource Handlers

| Type               | URI Pattern                             | Handler                          |
| ------------------ | --------------------------------------- | -------------------------------- |
| `knowledge_search` | `sunrise://knowledge/search?q={query}`  | Delegates to `searchKnowledge()` |
| `pattern_detail`   | `sunrise://knowledge/patterns/{number}` | Queries AiKnowledgeChunk         |
| `agent_list`       | `sunrise://agents`                      | Active agents list               |
| `workflow_list`    | `sunrise://workflows`                   | Active workflows list            |

## Session Management

- In-memory `Map<string, McpSession>`, 1hr TTL
- Created on `initialize`, identified by `Mcp-Session-Id` header
- `maxSessionsPerKey` enforced per API key
- Sessions lost on restart (clients re-initialize per MCP spec)

## Admin Pages

| Path                                 | Purpose                                            |
| ------------------------------------ | -------------------------------------------------- |
| `/admin/orchestration/mcp`           | Dashboard: master toggle, stats, connection config |
| `/admin/orchestration/mcp/tools`     | Enable/disable capabilities as MCP tools           |
| `/admin/orchestration/mcp/resources` | Enable/disable data resources                      |
| `/admin/orchestration/mcp/keys`      | Create/revoke API keys                             |
| `/admin/orchestration/mcp/audit`     | Audit log with manual purge button                 |
| `/admin/orchestration/mcp/settings`  | Rate limits, session limits, retention             |

## MCP Protocol Compliance

- Transport: Streamable HTTP (2024-11-05 spec)
- Messages: JSON-RPC 2.0 (single and batch requests)
- Capabilities: `tools`, `resources`, `prompts`
- Resource templates: `resources/templates/list` advertises parameterized URI patterns
- Pagination: `tools/list` and `resources/list` support cursor-based pagination (50 items/page)
- Batch requests: JSON-RPC 2.0 array batches (max 20 requests per batch)
- SSE notifications: `notifications/tools/list_changed` and `notifications/resources/list_changed` pushed to connected clients when admin toggles tools/resources
- Client notifications accepted: `notifications/initialized`, `notifications/roots/list_changed`, `notifications/cancelled`
- Error codes: Standard JSON-RPC (-32700, -32600, -32601, -32602, -32603)

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
