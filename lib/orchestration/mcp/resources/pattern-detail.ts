/**
 * MCP Resource Handler: Pattern Detail
 *
 * URI pattern: sunrise://knowledge/patterns/{number}
 * Returns all chunks for a specific pattern number.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { prisma } from '@/lib/db/client';
import type { McpResourceContent } from '@/types/mcp';

export async function handlePatternDetail(
  uri: string,
  _config: Record<string, unknown> | null,
  _callContext: import('@/lib/orchestration/mcp/resource-registry').ResourceCallContext
): Promise<McpResourceContent> {
  const match = uri.match(/patterns\/(\d+)/);
  const patternNumber = match ? parseInt(match[1], 10) : null;

  if (patternNumber === null || !Number.isSafeInteger(patternNumber) || patternNumber < 1) {
    return {
      uri,
      mimeType: 'application/json',
      text: JSON.stringify({ error: 'Invalid pattern number' }),
    };
  }

  const chunks = await prisma.aiKnowledgeChunk.findMany({
    where: { patternNumber },
    orderBy: { chunkKey: 'asc' },
    select: {
      content: true,
      chunkType: true,
      section: true,
      patternName: true,
    },
  });

  if (chunks.length === 0) {
    return {
      uri,
      mimeType: 'application/json',
      text: JSON.stringify({ error: `Pattern ${patternNumber} not found` }),
    };
  }

  return {
    uri,
    mimeType: 'application/json',
    text: JSON.stringify({
      patternNumber,
      patternName: chunks[0].patternName,
      sections: chunks.map((c) => ({
        section: c.section,
        chunkType: c.chunkType,
        content: c.content,
      })),
    }),
  };
}
