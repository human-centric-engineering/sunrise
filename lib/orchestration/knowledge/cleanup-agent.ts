/**
 * Helpers for the cleanup feature's bound agent.
 *
 * The cleanup conversation is created lazily by the chat-interface the first
 * time an admin sends a message. Before that, no agent is associated with
 * the document — callers must tolerate the no-agent state and fall back to
 * a conservative default.
 */

import { prisma } from '@/lib/db/client';
import { getModel } from '@/lib/orchestration/llm/model-registry';
import { hydrateFromDb as hydrateModelRegistryFromDb } from '@/lib/orchestration/llm/model-registry-db-hydrate';

// Modern frontier minimum. Used when no cleanup conversation exists yet, or
// when the bound model isn't in the registry. Under-promises rather than
// over-promises — server-side guard in /cleanup/section/refine remains the
// authoritative ceiling.
const FALLBACK_CONTEXT_WINDOW = 128_000;

/**
 * Look up the context window of the model bound to the cleanup conversation
 * for a document. Returns the fallback when no conversation exists, the
 * agent has no model configured, or the model isn't in the registry.
 */
export async function resolveCleanupAgentContextWindow(documentId: string): Promise<number> {
  const conv = await prisma.aiConversation.findFirst({
    where: { contextType: 'knowledge_document', contextId: documentId },
    orderBy: { createdAt: 'desc' },
    select: { agentId: true },
  });
  if (!conv) return FALLBACK_CONTEXT_WINDOW;

  const agent = await prisma.aiAgent.findUnique({
    where: { id: conv.agentId },
    select: { model: true },
  });
  if (!agent?.model) return FALLBACK_CONTEXT_WINDOW;

  // The refine route reaches the window through the resolver, which hydrates;
  // this page must see the same registry or the two disagree (#813).
  await hydrateModelRegistryFromDb();
  const modelInfo = getModel(agent.model);
  return modelInfo?.maxContext ?? FALLBACK_CONTEXT_WINDOW;
}
