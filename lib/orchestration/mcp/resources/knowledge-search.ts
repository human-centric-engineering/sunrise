/**
 * MCP Resource Handler: Knowledge Search
 *
 * URI pattern: sunrise://knowledge/search?q={query}
 * Delegates to the knowledge base search service.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { searchKnowledge } from '@/lib/orchestration/knowledge/search';
import type { McpResourceContent } from '@/types/mcp';

export async function handleKnowledgeSearch(
  uri: string,
  _config: Record<string, unknown> | null
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

  const results = await searchKnowledge(query, undefined, 10);

  const simplified = results.map((r) => ({
    content: r.chunk.content,
    chunkType: r.chunk.chunkType,
    patternNumber: r.chunk.patternNumber,
    patternName: r.chunk.patternName,
    category: r.chunk.category,
    similarity: r.similarity,
  }));

  return {
    uri,
    mimeType: 'application/json',
    text: JSON.stringify({ results: simplified }),
  };
}
