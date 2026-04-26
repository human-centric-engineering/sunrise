/**
 * MCP Resource Registry
 *
 * Maps registered `sunrise://` URIs to internal handler functions.
 * No user-supplied URI ever reaches fetch() — all handlers call
 * internal Sunrise functions only.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import type { McpResourceDefinition, McpResourceContent, McpResourceTemplate } from '@/types/mcp';
import { handleKnowledgeSearch } from '@/lib/orchestration/mcp/resources/knowledge-search';
import { handlePatternDetail } from '@/lib/orchestration/mcp/resources/pattern-detail';
import { handleAgentList } from '@/lib/orchestration/mcp/resources/agent-list';
import { handleWorkflowList } from '@/lib/orchestration/mcp/resources/workflow-list';

/** Resource handler function signature */
type ResourceHandler = (
  uri: string,
  config: Record<string, unknown> | null
) => Promise<McpResourceContent>;

/** Safely narrow a Prisma JsonValue to a record or null */
function toRecordOrNull(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/** Built-in handler map keyed by resourceType */
const HANDLERS: Record<string, ResourceHandler> = {
  knowledge_search: handleKnowledgeSearch,
  pattern_detail: handlePatternDetail,
  agent_list: handleAgentList,
  workflow_list: handleWorkflowList,
};

const CACHE_TTL_MS = 5 * 60 * 1000;
let cachedResources: McpResourceDefinition[] | null = null;
let cachedAt = 0;

/**
 * List all MCP-exposed resources that are enabled.
 */
export async function listMcpResources(): Promise<McpResourceDefinition[]> {
  const now = Date.now();
  if (cachedResources && now - cachedAt < CACHE_TTL_MS) {
    return cachedResources;
  }

  const rows = await prisma.mcpExposedResource.findMany({
    where: { isEnabled: true },
  });

  cachedResources = rows.map((r) => ({
    uri: r.uri,
    name: r.name,
    description: r.description,
    mimeType: r.mimeType,
  }));

  cachedAt = Date.now();
  return cachedResources;
}

/**
 * Read a specific MCP resource by URI.
 *
 * Pattern-matches against registered resources. Returns null if the
 * URI doesn't match any enabled resource or if no handler exists.
 */
export async function readMcpResource(uri: string): Promise<McpResourceContent | null> {
  const row = await prisma.mcpExposedResource.findUnique({
    where: { uri },
  });

  if (!row || !row.isEnabled) {
    // Try pattern matching for parameterized URIs
    return readMcpResourceByPattern(uri);
  }

  const handler = HANDLERS[row.resourceType];
  if (!handler) {
    logger.warn('MCP resource: no handler for type', {
      resourceType: row.resourceType,
      uri,
    });
    return null;
  }

  try {
    const config = toRecordOrNull(row.handlerConfig);
    return await handler(uri, config);
  } catch (err) {
    logger.error('MCP resource handler failed', {
      uri,
      resourceType: row.resourceType,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      uri,
      mimeType: row.mimeType ?? 'text/plain',
      text: 'Resource handler error',
    };
  }
}

/**
 * Pattern-match parameterized URIs against registered resources.
 * For example, `sunrise://knowledge/patterns/5` matches a resource
 * with resourceType `pattern_detail`.
 */
async function readMcpResourceByPattern(uri: string): Promise<McpResourceContent | null> {
  const rows = await prisma.mcpExposedResource.findMany({
    where: { isEnabled: true },
  });

  for (const row of rows) {
    // Check if the requested URI is a parameterized version of a registered URI
    if (uri.startsWith(row.uri.replace(/\{[^}]+\}/g, '').replace(/\?.*$/, ''))) {
      const handler = HANDLERS[row.resourceType];
      if (handler) {
        try {
          const config = toRecordOrNull(row.handlerConfig);
          return await handler(uri, config);
        } catch (err) {
          logger.error('MCP resource handler failed (pattern match)', {
            uri,
            resourceType: row.resourceType,
            error: err instanceof Error ? err.message : String(err),
          });
          return {
            uri,
            mimeType: row.mimeType ?? 'text/plain',
            text: 'Resource handler error',
          };
        }
      }
    }
  }

  return null;
}

/**
 * List resource templates — resources whose URIs contain {param} placeholders.
 * Per MCP spec `resources/templates`.
 */
export async function listMcpResourceTemplates(): Promise<McpResourceTemplate[]> {
  const rows = await prisma.mcpExposedResource.findMany({
    where: { isEnabled: true },
  });

  return rows
    .filter((r) => /\{[^}]+\}/.test(r.uri) || r.uri.includes('?'))
    .map((r) => ({
      uriTemplate: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    }));
}

/** Clear resource cache (after admin mutations) */
export function clearMcpResourceCache(): void {
  cachedResources = null;
  cachedAt = 0;
}
