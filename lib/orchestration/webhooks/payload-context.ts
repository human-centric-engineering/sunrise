/**
 * Webhook payload context helpers.
 *
 * Small lookups for human-readable identifiers (user names, workflow
 * names) that webhook receivers expect alongside their opaque IDs.
 * Each helper:
 *   - swallows DB errors and returns `undefined` (a missing display
 *     name should never block an outbound event)
 *   - uses a narrow `select` so we don't pull whole rows for one column
 *   - is intended to be called from inside a fire-and-forget dispatch
 *     chain — never await one of these from a synchronous event factory
 */

import { prisma } from '@/lib/db/client';

export async function resolveUserDisplayName(
  userId: string | null | undefined
): Promise<string | undefined> {
  if (!userId) return undefined;
  try {
    const row = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });
    return row?.name ?? undefined;
  } catch {
    return undefined;
  }
}

export interface WorkflowDisplay {
  slug?: string;
  name?: string;
}

export async function resolveWorkflowDisplay(
  workflowId: string | null | undefined
): Promise<WorkflowDisplay> {
  if (!workflowId) return {};
  try {
    const row = await prisma.aiWorkflow.findUnique({
      where: { id: workflowId },
      select: { slug: true, name: true },
    });
    if (!row) return {};
    return { slug: row.slug, name: row.name };
  } catch {
    return {};
  }
}

export interface AgentDisplay {
  slug?: string;
  name?: string;
}

export async function resolveAgentDisplay(
  agentId: string | null | undefined
): Promise<AgentDisplay> {
  if (!agentId) return {};
  try {
    const row = await prisma.aiAgent.findUnique({
      where: { id: agentId },
      select: { slug: true, name: true },
    });
    if (!row) return {};
    return { slug: row.slug, name: row.name };
  } catch {
    return {};
  }
}
