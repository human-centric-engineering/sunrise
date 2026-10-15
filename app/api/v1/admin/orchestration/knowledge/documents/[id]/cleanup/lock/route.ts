/**
 * Admin Orchestration — Document Clean Up edit lock
 *
 *   GET    /api/v1/admin/orchestration/knowledge/documents/:id/cleanup/lock
 *   POST   ...                                                  /cleanup/lock   — acquire / refresh
 *   DELETE ...                                                  /cleanup/lock   — release
 *
 * Cooperative single-writer lock for the cleanup co-authoring surface.
 * Same admin can re-acquire across tabs; a different admin is blocked
 * within the 5-minute TTL. See lib/orchestration/knowledge/edit-lock.ts.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import {
  acquireEditLock,
  getEditLockState,
  releaseEditLock,
  LOCK_TTL_MS,
} from '@/lib/orchestration/knowledge/edit-lock';
import { cuidSchema } from '@/lib/validations/common';

function parseDocumentId(raw: string): string {
  const parsed = cuidSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid document id', { id: ['Must be a valid CUID'] });
  }
  return parsed.data;
}

export const GET = withAdminAuth<{ id: string }>(
  async (_request, _session, { params }) => {
    const { id: rawId } = await params;
    const documentId = parseDocumentId(rawId);
    const state = await getEditLockState(documentId);
    return successResponse({
      heldBy: state.heldBy,
      acquiredAt: state.acquiredAt,
      active: state.active,
      ttlMs: LOCK_TTL_MS,
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

export const POST = withAdminAuth<{ id: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id: rawId } = await params;
    const documentId = parseDocumentId(rawId);

    // Only the document's own uploader may acquire (or refresh) its lock —
    // otherwise any admin could grab and perpetually renew the lock on a
    // document they'll never actually be able to save an edit to, locking
    // out the real owner.
    const doc = await prisma.aiKnowledgeDocument.findFirst({
      where: { id: documentId, uploadedBy: session.user.id, status: 'cleaning' },
      select: { id: true },
    });
    if (!doc) {
      throw new ValidationError(
        'Document not found, not owned by this user, or not in cleaning status'
      );
    }

    const result = await acquireEditLock(documentId, session.user.id);
    if (!result.acquired) {
      return errorResponse('Document is being edited by another admin', {
        code: 'LOCK_HELD',
        status: 423,
        details: { heldBy: [result.heldBy ?? 'unknown'] },
      });
    }

    log.info('Cleanup edit lock acquired', { documentId, adminId: session.user.id });

    return successResponse({
      acquired: true,
      heldBy: session.user.id,
      acquiredAt: result.acquiredAt,
      ttlMs: LOCK_TTL_MS,
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

export const DELETE = withAdminAuth<{ id: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id: rawId } = await params;
    const documentId = parseDocumentId(rawId);

    await releaseEditLock(documentId, session.user.id);
    log.info('Cleanup edit lock released', { documentId, adminId: session.user.id });

    return successResponse({ released: true });
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
