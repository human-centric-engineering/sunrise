/**
 * Admin Orchestration — Embedding status
 *
 * GET /api/v1/admin/orchestration/knowledge/embedding-status
 *
 * Returns how many chunks have embeddings, and whether this install can
 * actually embed right now, and whether the provider it would use is local.
 *
 * NOT lightweight, and deliberately so. `hasActiveProvider` runs the embedding
 * resolver — up to four more queries plus one eligibility evaluation per arm
 * tried — because the cheap row count it replaced answered a different
 * question ("does a provider exist?") and the two stopped agreeing once the
 * embedding chain started consulting the provider-eligibility rule. This is a
 * polling snapshot behind the knowledge Manage tab; keep it off any per-request
 * path, as `resolveEmbeddingAvailability`'s own JSDoc says.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { prisma } from '@/lib/db/client';
import { resolveEmbeddingStatus } from '@/lib/orchestration/knowledge/embedder';

export const GET = withAdminAuth(
  async (request) => {
    // `?providerOnly=true`: just the provider fields, without the two counts
    // over the chunk table. The privacy settings page reads `providerIsLocal`
    // on every load and has no use for them (§127).
    if (new URL(request.url).searchParams.get('providerOnly') === 'true') {
      const status = await resolveEmbeddingStatus();
      return successResponse({
        hasActiveProvider: status.availability === 'ok',
        providerState: status.availability,
        providerIsLocal: status.providerIsLocal,
        providerSetupMessage: status.setupMessage,
      });
    }
    const [total, embeddedRows, status] = await Promise.all([
      prisma.aiKnowledgeChunk.count(),
      prisma.$queryRaw<[{ count: bigint }]>`
      SELECT COUNT(*) as count FROM ai_knowledge_chunk WHERE embedding IS NOT NULL
    `,
      // Ask the resolver, not the row count. This used to be
      // `!!activeProviderRow || !!process.env.OPENAI_API_KEY`, which answered
      // "does a provider exist?" — the same question as "can we embed?" only
      // until the embedding chain started consulting the provider-eligibility
      // rule. On a fork whose rule refuses every arm, the row check reports
      // `true` and the admin UI enables "Generate Embeddings" for a run that
      // cannot succeed.
      resolveEmbeddingStatus(),
    ]);
    const providerState = status.availability;

    const embedded = Number(embeddedRows[0]?.count ?? 0);

    return successResponse({
      total,
      embedded,
      pending: total - embedded,
      // Kept, and kept meaning "embedding will run" — every existing consumer
      // gates an affordance on it. `providerState` is additive and carries the
      // WHY, because "no provider is set up" and "your policy refuses the ones
      // that are" need opposite remedies and the boolean prints only the first.
      hasActiveProvider: providerState === 'ok',
      providerState,
      // Whether that provider is marked local; `null` when none resolves. The
      // privacy settings warn when protection is on and it is not (§127).
      providerIsLocal: status.providerIsLocal,
      // The step left to take when embedding is set up but cannot run yet (a
      // local provider whose model is not picked, say); `null` otherwise. The
      // banner shows it in place of "add a provider" (t-1011).
      providerSetupMessage: status.setupMessage,
    });
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
