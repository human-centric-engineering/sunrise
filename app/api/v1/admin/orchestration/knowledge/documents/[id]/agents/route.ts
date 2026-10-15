/**
 * Admin Orchestration — Agents with access to a knowledge document
 *
 * GET /api/v1/admin/orchestration/knowledge/documents/:id/agents
 *
 * Returns every active agent that can search this document, with the path
 * that grants access. Mirrors the resolver in
 * `lib/orchestration/knowledge/resolveAgentDocumentAccess.ts`:
 *   - `full`        — agent has unrestricted KB access (no per-doc filter)
 *   - `direct`      — restricted agent with a direct doc grant
 *   - `tag`         — restricted agent granted a tag that this doc carries
 *   - `system`      — restricted agent + `document.scope = 'system'`
 *
 * One agent may have multiple paths (e.g. both a direct grant and a tag);
 * the response surfaces all of them so the operator can see the full
 * picture and remove redundant grants.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { cuidSchema } from '@/lib/validations/common';

export type AgentAccessPath =
  | { kind: 'full' }
  | { kind: 'direct' }
  | { kind: 'tag'; tagId: string; tagName: string; tagSlug: string }
  | { kind: 'system' };

export interface DocumentAgentRow {
  id: string;
  name: string;
  slug: string;
  kind: string;
  knowledgeAccessMode: string;
  paths: AgentAccessPath[];
}

export const GET = withAdminAuth<{ id: string }>(
  async (request, _session, { params }) => {
    const log = await getRouteLogger(request);
    const { id: rawId } = await params;
    const parsed = cuidSchema.safeParse(rawId);
    if (!parsed.success) {
      throw new ValidationError('Invalid document id', { id: ['Must be a valid CUID'] });
    }
    const id = parsed.data;

    const document = await prisma.aiKnowledgeDocument.findUnique({
      where: { id },
      select: { id: true, scope: true },
    });
    if (!document) throw new NotFoundError(`Document ${id} not found`);

    // Pull the four populations in parallel:
    //   - fullAgents:       any active agent with `knowledgeAccessMode = 'full'`
    //   - restrictedActive: every active restricted agent (used for the
    //                       system-scope path)
    //   - directGrants:     `AiAgentKnowledgeDocument` rows on this doc
    //   - tagMatches:       agents granted a tag that this doc also carries
    // The merge walks each population and writes one or more paths into a
    // shared map keyed by agentId. Inactive agents are silently dropped so
    // the count matches the admin "Uses" column.
    const docTagIds = await prisma.aiKnowledgeDocumentTag.findMany({
      where: { documentId: id },
      select: { tagId: true },
    });
    const tagIds = docTagIds.map((t) => t.tagId);

    // Soft-deleted agents (`deletedAt != null`) still satisfy `isActive = true`
    // until the deletion job flips both flags — filter on both so the count
    // matches the user-visible agent list.
    const activeFilter = { isActive: true, deletedAt: null } as const;

    const [fullAgents, directGrants, tagGrants, restrictedActive] = await Promise.all([
      prisma.aiAgent.findMany({
        where: { ...activeFilter, knowledgeAccessMode: 'full' },
        select: { id: true, name: true, slug: true, kind: true, knowledgeAccessMode: true },
      }),
      prisma.aiAgentKnowledgeDocument.findMany({
        where: { documentId: id, agent: activeFilter },
        select: {
          agent: {
            select: { id: true, name: true, slug: true, kind: true, knowledgeAccessMode: true },
          },
        },
      }),
      tagIds.length === 0
        ? Promise.resolve(
            [] as Array<{
              tagId: string;
              tag: { id: string; name: string; slug: string };
              agent: {
                id: string;
                name: string;
                slug: string;
                kind: string;
                knowledgeAccessMode: string;
              };
            }>
          )
        : prisma.aiAgentKnowledgeTag.findMany({
            where: { tagId: { in: tagIds }, agent: activeFilter },
            select: {
              tagId: true,
              tag: { select: { id: true, name: true, slug: true } },
              agent: {
                select: { id: true, name: true, slug: true, kind: true, knowledgeAccessMode: true },
              },
            },
          }),
      document.scope === 'system'
        ? prisma.aiAgent.findMany({
            where: { ...activeFilter, knowledgeAccessMode: 'restricted' },
            select: { id: true, name: true, slug: true, kind: true, knowledgeAccessMode: true },
          })
        : Promise.resolve(
            [] as Array<{
              id: string;
              name: string;
              slug: string;
              kind: string;
              knowledgeAccessMode: string;
            }>
          ),
    ]);

    const agents = new Map<string, DocumentAgentRow>();
    const upsert = (
      agent: {
        id: string;
        name: string;
        slug: string;
        kind: string;
        knowledgeAccessMode: string;
      },
      path: AgentAccessPath
    ): void => {
      const existing = agents.get(agent.id);
      if (existing) {
        existing.paths.push(path);
        return;
      }
      agents.set(agent.id, { ...agent, paths: [path] });
    };

    for (const a of fullAgents) upsert(a, { kind: 'full' });
    for (const g of directGrants) upsert(g.agent, { kind: 'direct' });
    for (const g of tagGrants) {
      upsert(g.agent, {
        kind: 'tag',
        tagId: g.tag.id,
        tagName: g.tag.name,
        tagSlug: g.tag.slug,
      });
    }
    for (const a of restrictedActive) upsert(a, { kind: 'system' });

    const list = Array.from(agents.values()).sort((a, b) => a.name.localeCompare(b.name));

    log.info('Document agents fetched', { documentId: id, agentCount: list.length });
    return successResponse({ agents: list, documentScope: document.scope });
  },
  {
    tier: 'org',
    ownership: {
      decidedBy: 'nothing',
      because:
        'Knowledge documents, their chunks and embeddings are the org’s, not anyone’s personal rows; row isolation bounds them to the entered org.',
    },
  }
);
