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
import { initAppKnowledgeAccessContributors } from '@/lib/app/knowledge-access-contributors';

export type AgentDocumentAccess =
  | { mode: 'full' }
  | {
      mode: 'restricted';
      /** Explicit doc IDs the agent may search (union of doc grants and tag-grant expansion). */
      documentIds: string[];
      /** When true, the search layer should also pass through `d.scope = 'system'` chunks. */
      includeSystemScope: true;
    };

// ─── Access-contributor seam ──────────────────────────────────────────────
//
// A fork can widen a *restricted* agent's searchable document set from a
// relationship it owns (module membership, team ACL, per-tenant grant) —
// composed live at resolve time instead of materialising derived grants onto
// the per-agent pivot (which has no provenance column, so a copy-down scheme is
// clobber-or-leak). Mirrors `registerContextContributor`: a keyed registry the
// fork fills from `lib/app/knowledge-access-contributors.ts`, run-once-lazily.

/** A live source of extra documents/tags for a restricted agent. */
export interface AgentAccessContribution {
  /** Document IDs to add to the agent's searchable set. */
  documentIds?: string[];
  /** Tag IDs to add — expanded to their documents by the resolver, like a tag grant. */
  tagIds?: string[];
}

export type AgentAccessContributor = (agentId: string) => Promise<AgentAccessContribution>;

const accessContributors = new Map<string, AgentAccessContributor>();

/** Whether the auto-wired app contributor init has run. */
let appAccessContributorsInited = false;

/**
 * Register a knowledge access contributor. Lets a fork add documents to a
 * **restricted** agent's searchable set without materialising grants or editing
 * the resolver. Idempotent by key: re-registering the same key replaces the
 * prior contributor (mirrors `registerContextContributor`). Contributors run
 * only in the `restricted` branch (so a `full` agent is never touched) and can
 * only *widen* access. Call at module-import time from
 * `lib/app/knowledge-access-contributors.ts`.
 *
 * @see .context/orchestration/knowledge.md — the app-author guide
 */
export function registerAgentAccessContributor(
  key: string,
  contributor: AgentAccessContributor
): void {
  accessContributors.set(key, contributor);
}

/**
 * Run the fork's auto-wired contributor init exactly once, lazily, before the
 * first resolve. Mirrors `ensureAppContributorsInited` in the chat context
 * builder: latch BEFORE running so a throwing init neither retries on every
 * resolve nor propagates out of `resolveAgentDocumentAccess` (which is
 * documented as always-safe-to-call). An init failure degrades to "no app
 * contributors".
 */
function ensureAppAccessContributorsInited(): void {
  if (appAccessContributorsInited) return;
  appAccessContributorsInited = true;
  try {
    initAppKnowledgeAccessContributors();
  } catch (err) {
    logger.error(
      'resolveAgentDocumentAccess: initAppKnowledgeAccessContributors threw — app access contributors disabled',
      { error: err instanceof Error ? err.message : String(err) }
    );
  }
}

/**
 * Consult every registered access contributor for one agent, in parallel.
 * Never throws: a contributor that rejects OR throws synchronously is logged
 * and contributes nothing, preserving the resolver's always-safe contract.
 * Returns flattened `documentIds` / `tagIds` (may contain duplicates; the
 * caller dedups).
 */
async function collectAccessContributions(
  agentId: string
): Promise<{ documentIds: string[]; tagIds: string[] }> {
  if (accessContributors.size === 0) return { documentIds: [], tagIds: [] };

  const results = await Promise.all(
    Array.from(accessContributors.entries()).map(async ([key, contributor]) => {
      try {
        return await contributor(agentId);
      } catch (err) {
        logger.error('resolveAgentDocumentAccess: access contributor threw — ignoring', {
          agentId,
          contributorKey: key,
          error: err instanceof Error ? err.message : String(err),
        });
        return { documentIds: [], tagIds: [] } satisfies AgentAccessContribution;
      }
    })
  );

  const documentIds: string[] = [];
  const tagIds: string[] = [];
  for (const contribution of results) {
    // `Array.isArray` (not just truthy) so a fork returning a malformed shape
    // that violates the `string[]` type — a bare number (`.push(...123)` would
    // throw `not iterable`) or a string (which would silently spread into
    // single chars) — is ignored rather than crashing the resolver or poisoning
    // the set. Keeps the "never throws" contract literally true.
    if (Array.isArray(contribution?.documentIds)) documentIds.push(...contribution.documentIds);
    if (Array.isArray(contribution?.tagIds)) tagIds.push(...contribution.tagIds);
  }
  return { documentIds, tagIds };
}

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
 * Test-only: drop all registered access contributors and re-arm the one-shot
 * app init so each test starts from a known state.
 */
export function __resetAgentAccessContributorsForTests(): void {
  accessContributors.clear();
  appAccessContributorsInited = false;
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

  // Restricted branch only — contributors run after the `full` short-circuit
  // above, so they can only WIDEN a restricted agent (never narrow, never touch
  // a `full` agent). Consulted in parallel with the core grant queries.
  ensureAppAccessContributorsInited();

  const [docGrants, tagGrants, contributions] = await Promise.all([
    prisma.aiAgentKnowledgeDocument.findMany({
      where: { agentId },
      select: { documentId: true },
    }),
    prisma.aiAgentKnowledgeTag.findMany({
      where: { agentId },
      select: { tagId: true },
    }),
    collectAccessContributions(agentId),
  ]);

  // Contributed tagIds join the existing tag→doc expansion (deduped so a tag
  // both operator-granted and contributed doesn't widen the `IN` list twice).
  const grantedTagIds = Array.from(
    new Set<string>([...tagGrants.map((g) => g.tagId), ...contributions.tagIds])
  );
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
      ...contributions.documentIds,
    ])
  );

  const value: AgentDocumentAccess = {
    mode: 'restricted',
    documentIds,
    includeSystemScope: true,
  };
  // Cached unconditionally, even if a contributor errored (degrading to fewer
  // docs). Intentional and distinct from the chat context seam, which leaves an
  // errored result uncached to self-heal: for an *access* decision the narrower
  // set is the safe direction, so a transient contributor blip costing an agent
  // its contributed docs for ≤1 TTL is acceptable, and re-composing on every
  // resolve would defeat the cache the hot search path depends on.
  cache.set(agentId, { expiresAt: now + CACHE_TTL_MS, value });
  return value;
}
