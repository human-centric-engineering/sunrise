/**
 * MCP Resource Handler: Agent List
 *
 * URI: sunrise://agents
 * Returns active agents (name, slug, description only — no sensitive config).
 *
 * Platform-agnostic: no Next.js imports.
 */

import { prisma } from '@/lib/db/client';
import type { McpResourceContent } from '@/types/mcp';

export async function handleAgentList(
  uri: string,
  _config: Record<string, unknown> | null,
  _callContext: import('@/lib/orchestration/mcp/resource-registry').ResourceCallContext
): Promise<McpResourceContent> {
  const agents = await prisma.aiAgent.findMany({
    where: { isActive: true },
    select: {
      name: true,
      slug: true,
      description: true,
      model: true,
      provider: true,
    },
    orderBy: { name: 'asc' },
  });

  return {
    uri,
    mimeType: 'application/json',
    text: JSON.stringify({ agents }),
  };
}
