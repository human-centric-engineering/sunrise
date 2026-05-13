/**
 * Agent Knowledge-Access Resolver
 *
 * Maps an agent → the effective set of knowledge documents it may search.
 *
 * Two modes mirror the `AiAgent.knowledgeAccessMode` column:
 *   - `full`        → no document filter (search the whole KB).
 *   - `restricted`  → effective doc set =
 *                       (explicitly granted docs)
 *                     ∪ (docs carrying any granted tag)
 *                     ∪ (system-scoped docs — see note below)
 *
 * System-scoped documents (`AiKnowledgeDocument.scope = 'system'`) are always
 * accessible. They're shared platform seed data (the bundled Agentic Design
 * Patterns reference) and gating them per agent would surprise operators —
 * this is documented on the agent form FieldHelp. The flag is returned as
 * part of the result so callers can propagate it into `SearchFilters`.
 *
 * Caching: results are memoised in a process-wide LRU with a short TTL so the
 * hot `search_knowledge` path doesn't load three sets per chat turn. Admin
 * mutations that change grants (tag/grant CRUD, agent edits) MUST call
 * `invalidateAgentAccess(agentId)` to evict the stale entry — otherwise UI
 * changes won't apply until the TTL expires.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

export type AgentDocumentAccess =
  | { mode: 'full' }
  | {
      mode: 'restricted';
      /** Explicit doc IDs the agent may search (union of doc grants and tag-grant expansion). */
      documentIds: string[];
      /** When true, the search layer should also pass through `d.scope = 'system'` chunks. */
      includeSystemScope: true;
    };

interface CacheEntry {
  expiresAt: number;
  value: AgentDocumentAccess;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

/** Invalidate the cached access decision for one agent (call after grant mutations). */
export function invalidateAgentAccess(agentId: string): void {
  cache.delete(agentId);
}

/** Invalidate the entire cache (call after bulk operations or schema-shaped changes). */
export function invalidateAllAgentAccess(): void {
  cache.clear();
}

/**
 * Resolve the effective document-access set for an agent. Always safe to call
 * — never throws on missing agents (treats them as `restricted` with no grants,
 * so the agent sees only system docs).
 */
export async function resolveAgentDocumentAccess(agentId: string): Promise<AgentDocumentAccess> {
  const now = Date.now();
  const cached = cache.get(agentId);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const agent = await prisma.aiAgent.findUnique({
    where: { id: agentId },
    select: { knowledgeAccessMode: true },
  });

  if (!agent) {
    logger.warn('resolveAgentDocumentAccess: agent not found, defaulting to restricted/empty', {
      agentId,
    });
    const value: AgentDocumentAccess = {
      mode: 'restricted',
      documentIds: [],
      includeSystemScope: true,
    };
    cache.set(agentId, { expiresAt: now + CACHE_TTL_MS, value });
    return value;
  }

  if (agent.knowledgeAccessMode !== 'restricted') {
    const value: AgentDocumentAccess = { mode: 'full' };
    cache.set(agentId, { expiresAt: now + CACHE_TTL_MS, value });
    return value;
  }

  const [docGrants, tagGrants] = await Promise.all([
    prisma.aiAgentKnowledgeDocument.findMany({
      where: { agentId },
      select: { documentId: true },
    }),
    prisma.aiAgentKnowledgeTag.findMany({
      where: { agentId },
      select: { tagId: true },
    }),
  ]);

  const grantedTagIds = tagGrants.map((g) => g.tagId);
  const tagExpandedDocs =
    grantedTagIds.length === 0
      ? []
      : await prisma.aiKnowledgeDocumentTag.findMany({
          where: { tagId: { in: grantedTagIds } },
          select: { documentId: true },
        });

  const documentIds = Array.from(
    new Set<string>([
      ...docGrants.map((g) => g.documentId),
      ...tagExpandedDocs.map((d) => d.documentId),
    ])
  );

  const value: AgentDocumentAccess = {
    mode: 'restricted',
    documentIds,
    includeSystemScope: true,
  };
  cache.set(agentId, { expiresAt: now + CACHE_TTL_MS, value });
  return value;
}
