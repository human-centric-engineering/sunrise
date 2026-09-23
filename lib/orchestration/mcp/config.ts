/**
 * MCP Server Config Loader
 *
 * Singleton settings loader for MCP server configuration.
 *
 * Still upsert-on-read behind the cache below. `AiOrchestrationSettings` was
 * the same shape until #442 moved it to read-first, and this row should follow
 * — but its miss path runs far less often, so the change is not urgent enough
 * to make here without the tests to match.
 *
 * Platform-agnostic: no Next.js imports.
 *
 * Tenancy posture: global-config — the McpServerConfig singleton
 * (lib/tenancy/process-state.ts).
 */

import { prisma } from '@/lib/db/client';
import type { McpServerState } from '@/lib/orchestration/mcp/types';
import { SUNRISE_VERSION } from '@/lib/sunrise-version';

/**
 * Five minutes, not the one minute this used to be. At 60s the TTL matched the
 * maintenance tick's own interval exactly, so the retention sweep's call landed
 * on a coin-flip — and the miss path below is an `upsert`, i.e. a write taking a
 * row lock, roughly every other tick for a row that changes when an admin edits
 * it (#442). Invalidation is explicit, so a longer TTL costs nothing.
 */
const CACHE_TTL_MS = 5 * 60_000;

let cached: McpServerState | null = null;
let cachedAt = 0;

/**
 * Load the MCP server config singleton, upserting if it doesn't exist.
 * Cached for `CACHE_TTL_MS`; admin mutations call `invalidateMcpConfigCache()`.
 */
export async function getMcpServerConfig(): Promise<McpServerState> {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL_MS) {
    return cached;
  }

  const row = await prisma.mcpServerConfig.upsert({
    where: { slug: 'global' },
    create: {
      slug: 'global',
      isEnabled: false,
      serverName: 'Sunrise MCP Server',
      // Sunrise IS the MCP server implementation here, so serverVersion
      // tracks SUNRISE_VERSION (the platform version), not the fork's app
      // version. Operators bumping Sunrise releases get an automatic
      // serverVersion bump on the next upsert; existing rows are preserved
      // by the `update: {}` clause so an admin's manual override is sticky.
      serverVersion: SUNRISE_VERSION,
      globalRateLimit: 60,
      auditRetentionDays: 90,
    },
    update: {},
  });

  cached = {
    isEnabled: row.isEnabled,
    serverName: row.serverName,
    serverVersion: row.serverVersion,
    globalRateLimit: row.globalRateLimit,
    auditRetentionDays: row.auditRetentionDays,
  };
  cachedAt = Date.now();

  return cached;
}

/** Invalidate the config cache (after admin mutations) */
export function invalidateMcpConfigCache(): void {
  cached = null;
  cachedAt = 0;
}
