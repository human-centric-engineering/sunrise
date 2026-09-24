-- The MCP session cap goes with the sessions (§39 t-718).
--
-- `mcp_server_config."maxSessionsPerKey"` — camelCase and quoted, as the DDL
-- below and the baseline both have it — was read in exactly one place: the
-- `createSession` call on the stateful transport, which enforced it per API key.
-- That transport is gone — MCP revision 2026-07-28 removes protocol-level
-- sessions outright, and the mode that held them threw on any platform serving
-- traffic from more than one process — so nothing consults this column and
-- nothing can. Leaving it would leave an admin a number to set that changes
-- nothing, which is worse than leaving them one fewer.
--
-- Destructive and deliberate. The value is an operator preference (default 5),
-- not a record of anything, and it is meaningless without the feature it capped.
-- Breaking for a fork that reads `McpServerConfig.maxSessionsPerKey` or sends it
-- to `PATCH /api/v1/admin/orchestration/mcp/settings`; see CHANGELOG `Removed`.

ALTER TABLE "mcp_server_config" DROP COLUMN "maxSessionsPerKey";
