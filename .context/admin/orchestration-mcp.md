# Orchestration — MCP Server Admin UI

Admin interface for managing the Model Context Protocol (MCP) server that exposes orchestration capabilities to external AI clients.

## Architecture

The MCP server uses **JSON-RPC 2.0** over **Streamable HTTP** transport (protocol version `2024-11-05`). External AI clients (Claude Desktop, Cursor, etc.) connect via bearer token authentication.

**Security model:** Default-deny. Nothing is exposed until explicitly added and enabled.

### Page Structure

```
/admin/orchestration/mcp/
├── page.tsx          → Dashboard (toggle, quick links, config snippet)
├── tools/page.tsx    → Exposed tools management
├── resources/page.tsx → Exposed resources management
├── keys/page.tsx     → API key management
├── audit/page.tsx    → Audit log with filters + pagination
└── settings/page.tsx → Server configuration form
```

## Dashboard (`mcp-dashboard.tsx`)

- **Master toggle** — enables/disables the MCP server via `apiClient.patch`
- **Quick links** — cards linking to Tools, Resources, Prompts, Keys, Audit, Settings
- **Client config snippet** — shown when server is enabled; copy-paste JSON for MCP clients
- **Getting started wizard** — shown when no tools and no keys are configured

## Exposed Tools (`mcp-tools-list.tsx`)

Maps orchestration capabilities to MCP tool endpoints.

- **Add tool** — select from unused capabilities, added as disabled by default
- **Enable/disable toggle** — per-tool via `apiClient.patch`
- **Inline edit dialog** — edit custom name, custom description, rate limit per key, required scope
- **Remove** — removes tool exposure via `apiClient.delete`

### Edit Fields

| Field              | Purpose                                                      |
| ------------------ | ------------------------------------------------------------ |
| Custom Name        | Override the MCP tool name (must be lowercase + underscores) |
| Custom Description | Override what clients see when deciding to call the tool     |
| Rate Limit Per Key | Per-tool rate limit (requests/min per key), overrides global |
| Required Scope     | Additional scope beyond `tools:execute` for sensitive tools  |

## Resources (`mcp-resources-list.tsx`)

Exposes read-only data endpoints to MCP clients.

- **4 resource types**: Knowledge Search, Agent List, Workflow List, Pattern Detail
- **Create dialog** — type selector auto-populates example URI
- **Enable/disable toggle** and **Remove** per resource
- Uses `apiClient` for all operations

## API Keys (`mcp-keys-list.tsx`)

Self-service API key management with SHA-256 hashing.

### Create Dialog Fields

| Field               | Required | Notes                                                           |
| ------------------- | -------- | --------------------------------------------------------------- |
| Name                | Yes      | Descriptive label (e.g. "Claude Desktop")                       |
| Scopes              | Yes (≥1) | `tools:list`, `tools:execute`, `resources:read`, `prompts:read` |
| Expiry              | No       | Optional datetime; expired keys are auto-rejected               |
| Rate Limit Override | No       | Per-key requests/min override                                   |

### Table Columns

Name, Key Prefix, Scopes, Status (Active/Revoked/Expired), Expires, Rate Limit, Last Used, Created

### Actions

- **Rotate** — generates new key material via `POST .../keys/:id/rotate`; shows one-time plaintext in dialog
- **Revoke** — permanently disables key via `PATCH { isActive: false }`

**Plaintext display:** Key material is shown exactly once on creation or rotation, then never stored or retrievable.

## Sessions — the page is gone

There was a Sessions page listing in-memory MCP sessions, and it has been removed
(§39 t-718) along with `mcp-sessions-list.tsx`, `GET …/mcp/sessions` and
`DELETE …/sessions/:id`. There are no sessions: every MCP request stands alone.

Under the default session mode the page was **permanently empty** and said so in
an explanatory panel, because `getActiveSessions()` could never return a row.
That panel was the tell. See
[One transport, and it holds nothing](../orchestration/mcp.md#one-transport-and-it-holds-nothing).

## Audit Log (`mcp-audit-log.tsx`)

Every MCP operation is logged with method, target, status, duration, API key, and client IP.

### Filters

| Filter    | Type       | Values                                                                                                              |
| --------- | ---------- | ------------------------------------------------------------------------------------------------------------------- |
| Method    | Select     | `initialize`, `tools/list`, `tools/call`, `resources/list`, `resources/read`, `prompts/list`, `prompts/get`, `ping` |
| Status    | Select     | `success`, `error`, `rate_limited`                                                                                  |
| Date From | Date input | ISO date                                                                                                            |
| Date To   | Date input | ISO date                                                                                                            |

### Pagination

Server-side pagination (50 entries per page) with Previous/Next controls. Total count shown.

### Purge

"Purge Old Logs" deletes entries older than the retention period configured in Settings.

## Settings (`mcp-settings-form.tsx`)

Server configuration form using `react-hook-form` + Zod validation.

| Field                | Type   | Range       | Default              |
| -------------------- | ------ | ----------- | -------------------- |
| Server Name          | string | 1-100 chars | "Sunrise MCP Server" |
| Server Version       | string | 1-20 chars  | "1.0.0"              |
| Global Rate Limit    | int    | 1-10,000    | 60                   |
| Audit Retention Days | int    | 0-3,650     | 90                   |

There used to be a **Max Sessions Per Key** field here, annotated "no effect on
this deployment" under the default session mode — a setting that validated, saved
and was never consulted. Both it and the `McpServerConfig.maxSessionsPerKey`
column behind it are gone (§39 t-718). A fork that PATCHes the field now gets a
400: zod strips the unknown key, leaving a body with no settable field in it.

- **isDirty tracking** — Save button disabled when pristine
- **Error display** — API errors shown inline; generic fallback for non-API errors
- **Saved indicator** — "Saved" text shown for 3 seconds after successful save

## API Client Pattern

All components use `apiClient` from `@/lib/api/client` (not raw `fetch`). The client:

- Auto-serializes JSON request bodies
- Extracts `data` from `{ success: true, data: ... }` responses
- Throws `APIClientError` on failures with structured error info

## Key Endpoints

| Endpoint                                      | Purpose                                    |
| --------------------------------------------- | ------------------------------------------ |
| `API.ADMIN.ORCHESTRATION.MCP_SETTINGS`        | Settings singleton PATCH                   |
| `API.ADMIN.ORCHESTRATION.MCP_TOOLS`           | List/create exposed tools                  |
| `API.ADMIN.ORCHESTRATION.mcpToolById(id)`     | PATCH/DELETE individual tool               |
| `API.ADMIN.ORCHESTRATION.MCP_RESOURCES`       | List/create resources                      |
| `API.ADMIN.ORCHESTRATION.mcpResourceById(id)` | PATCH/DELETE individual resource           |
| `API.ADMIN.ORCHESTRATION.MCP_KEYS`            | List/create API keys                       |
| `API.ADMIN.ORCHESTRATION.mcpKeyById(id)`      | PATCH individual key                       |
| `API.ADMIN.ORCHESTRATION.mcpKeyRotate(id)`    | POST to rotate key                         |
| `API.ADMIN.ORCHESTRATION.MCP_AUDIT`           | GET (filtered) / DELETE (purge) audit logs |

## Test Coverage

Component tests in `tests/unit/components/admin/orchestration/mcp/`:

- `mcp-dashboard.test.tsx` — toggle, quick links, config snippet, getting started
- `mcp-settings-form.test.tsx` — form fields, validation, submission, error handling
- `mcp-keys-list.test.tsx` — create, revoke, rotate, expiry, rate limit
- `mcp-tools-list.test.tsx` — add, toggle, remove, edit dialog
- `mcp-audit-log.test.tsx` — filters, pagination, purge
