/**
 * Admin Orchestration — Read one cleanup revision
 *
 *   GET /api/v1/admin/orchestration/knowledge/documents/:id/cleanup/revisions/:version
 *
 * Returns a single AiKnowledgeDocumentRevision's full content, plus the
 * content of the revision immediately before it. The pair is what the history
 * view needs to answer "what did THIS step change?" without a second round
 * trip — the list endpoint deliberately sends metadata only, because every
 * revision row stores the whole document.
 *
 * `previous` is null for version 1, and also for the oldest revision still
 * held after retention pruning — in which case `previousPruned` is true so the
 * UI can say the predecessor is gone rather than implying the document
 * started there.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse, errorResponse } from '@/lib/api/responses';
import { ValidationError } from '@/lib/api/errors';
import { cuidSchema } from '@/lib/validations/common';

export const GET = withAdminAuth<{ id: string; version: string }>(
  async (_request, _session, { params }) => {
    const { id: rawId, version: rawVersion } = await params;
    const parsedId = cuidSchema.safeParse(rawId);
    if (!parsedId.success) {
      throw new ValidationError('Invalid document id', { id: ['Must be a valid CUID'] });
    }
    const versionNum = Number.parseInt(rawVersion, 10);
    if (!Number.isInteger(versionNum) || versionNum < 1) {
      throw new ValidationError('Invalid version', { version: ['Must be a positive integer'] });
    }
    const documentId = parsedId.data;

    const revision = await prisma.aiKnowledgeDocumentRevision.findUnique({
      where: { documentId_version: { documentId, version: versionNum } },
    });
    if (!revision) {
      return errorResponse('Revision not found', {
        code: 'REVISION_NOT_FOUND',
        status: 404,
        details: { version: [String(versionNum)] },
      });
    }

    // Immediately-prior surviving revision — not `version - 1`, which may have
    // been pruned or (after a future gap) never have existed.
    const previous = await prisma.aiKnowledgeDocumentRevision.findFirst({
      where: { documentId, version: { lt: versionNum } },
      orderBy: { version: 'desc' },
      select: { version: true, content: true },
    });

    return successResponse({
      revision: {
        version: revision.version,
        content: revision.content,
        source: revision.source,
        actorId: revision.actorId,
        sectionMarker: revision.sectionMarker,
        instructions: revision.instructions,
        createdAt: revision.createdAt,
      },
      previous,
      // True when this is the oldest revision we still hold but not the first
      // the document ever had — its predecessor was pruned by retention.
      previousPruned: previous === null && revision.version > 1,
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
