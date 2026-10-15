/**
 * Admin Orchestration — Read one pending LLM-rewrite proposal
 *
 *   GET /api/v1/admin/orchestration/knowledge/documents/:id/cleanup/changes/:changeId
 *
 * Returns a single pending change so the cleanup diff modal can render it.
 * Exists so the modal doesn't have to fetch the whole document: each proposal
 * carries a full before + after copy of the text, and the document route is
 * re-fetched after every chat turn, capability result, section save and
 * restore.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { cuidSchema } from '@/lib/validations/common';

export const GET = withAdminAuth<{ id: string; changeId: string }>(
  async (request, _session, { params }) => {
    const log = await getRouteLogger(request);

    const { id: rawId, changeId: rawChangeId } = await params;
    const parsedId = cuidSchema.safeParse(rawId);
    const parsedChangeId = cuidSchema.safeParse(rawChangeId);
    if (!parsedId.success) {
      throw new ValidationError('Invalid document id', { id: ['Must be a valid CUID'] });
    }
    if (!parsedChangeId.success) {
      throw new ValidationError('Invalid change id', { changeId: ['Must be a valid CUID'] });
    }
    const documentId = parsedId.data;
    const changeId = parsedChangeId.data;

    const change = await prisma.aiKnowledgeDocumentPendingChange.findFirst({
      where: { id: changeId, documentId },
      select: {
        id: true,
        source: true,
        beforeContent: true,
        afterContent: true,
        sectionMarker: true,
        instructions: true,
        createdAt: true,
      },
    });
    if (!change) {
      return errorResponse('Pending change not found', {
        code: 'CHANGE_NOT_FOUND',
        status: 404,
        details: { changeId: [changeId] },
      });
    }

    log.info('Cleanup pending change fetched', { documentId, changeId });

    return successResponse({ change });
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
