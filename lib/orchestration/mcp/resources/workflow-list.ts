/**
 * MCP Resource Handler: Workflow List
 *
 * URI: sunrise://workflows
 * Returns active workflows (name, slug, description only).
 *
 * Platform-agnostic: no Next.js imports.
 */

import { prisma } from '@/lib/db/client';
import type { McpResourceContent } from '@/types/mcp';

export async function handleWorkflowList(
  uri: string,
  _config: Record<string, unknown> | null,
  _callContext: import('@/lib/orchestration/mcp/resource-registry').ResourceCallContext
): Promise<McpResourceContent> {
  const workflows = await prisma.aiWorkflow.findMany({
    where: { isActive: true },
    select: {
      name: true,
      slug: true,
      description: true,
      isTemplate: true,
    },
    orderBy: { name: 'asc' },
  });

  return {
    uri,
    mimeType: 'application/json',
    text: JSON.stringify({ workflows }),
  };
}
