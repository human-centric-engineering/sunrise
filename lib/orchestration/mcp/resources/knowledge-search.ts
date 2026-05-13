/**
 * MCP Resource Handler: Knowledge Search
 *
 * URI pattern: sunrise://knowledge/search?q={query}
 *
 * Routes through the agent knowledge-access resolver when the caller's API key is
 * bound to an agent (`McpApiKey.scopedAgentId`). Unscoped service keys still receive
 * a system-wide search but the broad-access usage is audit-logged so operators can
 * see when an unscoped key is being used against the KB.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { logger } from '@/lib/logging';
import { searchKnowledge, type SearchFilters } from '@/lib/orchestration/knowledge/search';
import { resolveAgentDocumentAccess } from '@/lib/orchestration/knowledge/resolveAgentDocumentAccess';
import type { McpResourceContent } from '@/types/mcp';
import type { ResourceCallContext } from '@/lib/orchestration/mcp/resource-registry';

export async function handleKnowledgeSearch(
  uri: string,
  _config: Record<string, unknown> | null,
  callContext: ResourceCallContext
): Promise<McpResourceContent> {
  let query = '';
  try {
    const url = new URL(uri.replace('sunrise://', 'https://placeholder/'));
    query = url.searchParams.get('q') ?? '';
  } catch {
    return {
      uri,
      mimeType: 'application/json',
      text: JSON.stringify({ error: 'Malformed URI — could not parse query parameters' }),
    };
  }

  if (!query.trim()) {
    return {
      uri,
      mimeType: 'application/json',
      text: JSON.stringify({ results: [], message: 'No query provided' }),
    };
  }

  let filters: SearchFilters | undefined;
  if (callContext.scopedAgentId) {
    const access = await resolveAgentDocumentAccess(callContext.scopedAgentId);
    if (access.mode === 'restricted') {
      filters = {
        documentIds: access.documentIds,
        includeSystemScope: access.includeSystemScope,
      };
    }
  } else {
    logger.info('MCP knowledge search via unscoped service key', {
      apiKeyId: callContext.apiKeyId,
    });
  }

  const results = await searchKnowledge(query, filters, 10);

  const simplified = results.map((r) => ({
    content: r.chunk.content,
    chunkType: r.chunk.chunkType,
    patternNumber: r.chunk.patternNumber,
    patternName: r.chunk.patternName,
    similarity: r.similarity,
  }));

  return {
    uri,
    mimeType: 'application/json',
    text: JSON.stringify({ results: simplified }),
  };
}
