/**
 * Admin Orchestration — List cleanup revisions
 *
 *   GET /api/v1/admin/orchestration/knowledge/documents/:id/cleanup/revisions
 *
 * Returns the most recent N (default 50, max 200) AiKnowledgeDocumentRevision
 * rows for the doc, newest first. Powers the History drawer in the cleanup
 * page. Each row includes content + char delta vs. the immediately-prior
 * revision so the drawer can render a per-row summary without re-fetching.
 *
 * Authentication: Admin role required.
 */

import { z } from 'zod';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { ValidationError } from '@/lib/api/errors';
import { validateQueryParams } from '@/lib/api/validation';
import { cuidSchema } from '@/lib/validations/common';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const GET = withAdminAuth<{ id: string }>(
  async (request, _session, { params }) => {
    const { id: rawId } = await params;
    const parsedId = cuidSchema.safeParse(rawId);
    if (!parsedId.success) {
      throw new ValidationError('Invalid document id', { id: ['Must be a valid CUID'] });
    }
    const documentId = parsedId.data;

    const { searchParams } = new URL(request.url);
    const { limit } = validateQueryParams(searchParams, querySchema);

    const revisions = await prisma.aiKnowledgeDocumentRevision.findMany({
      where: { documentId },
      orderBy: { version: 'desc' },
      take: limit,
    });

    // Compute per-row char delta against the immediately-prior version. Since
    // we order newest-first, "prior" is the next item in the array.
    const augmented = revisions.map((rev, idx) => {
      const prior = revisions[idx + 1];
      const charsDelta = prior ? rev.content.length - prior.content.length : rev.content.length;
      return {
        id: rev.id,
        version: rev.version,
        source: rev.source,
        actorId: rev.actorId,
        sectionMarker: rev.sectionMarker,
        instructions: rev.instructions,
        createdAt: rev.createdAt,
        contentLength: rev.content.length,
        charsDelta,
      };
    });

    return successResponse({ revisions: augmented });
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
