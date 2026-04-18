/**
 * MCP Server Config Loader
 *
 * Singleton settings loader for MCP server configuration,
 * following the AiOrchestrationSettings upsert-on-read pattern.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { prisma } from '@/lib/db/client';
import type { McpServerState } from '@/lib/orchestration/mcp/types';

const CACHE_TTL_MS = 60_000; // 1 minute

let cached: McpServerState | null = null;
let cachedAt = 0;

/**
 * Load the MCP server config singleton, upserting if it doesn't exist.
 * Caches for 1 minute to avoid hitting the DB on every MCP request.
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
      serverVersion: '1.0.0',
      maxSessionsPerKey: 5,
      globalRateLimit: 60,
      auditRetentionDays: 90,
    },
    update: {},
  });

  cached = {
    isEnabled: row.isEnabled,
    serverName: row.serverName,
    serverVersion: row.serverVersion,
    maxSessionsPerKey: row.maxSessionsPerKey,
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
