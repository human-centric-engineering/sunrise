/**
 * Admin Orchestration — Cleanup per-section edit
 *
 *   POST /api/v1/admin/orchestration/knowledge/documents/:id/cleanup/section
 *
 * Body: { sectionId: string, content: string, expectedFingerprint: string }
 *
 * Per-section inline edit. Looks up the section by its detectSections id,
 * asserts the section body hashes to expectedFingerprint, splices the new
 * body in, writes a `human_section` revision.
 *
 * Addressed by id, never by marker: markers are human-facing labels and are
 * not unique (two `## Introduction` headings, repeated speaker turns, a
 * `(preamble)`), so marker lookup would splice over the first match.
 *
 * Same auth + lock semantics as the whole-doc endpoint: 423 LOCK_HELD
 * when another admin owns the lock; 409 CONTENT_MISMATCH when the
 * section's content has moved on since edit-mode began.
 *
 * Authentication: Admin role required.
 */

import { createHash } from 'crypto';
import { z } from 'zod';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { writeCleanupContent } from '@/lib/orchestration/capabilities/built-in/document-cleanup/context';
import { getEditLockState } from '@/lib/orchestration/knowledge/edit-lock';
import { detectSections, spliceSection } from '@/lib/orchestration/knowledge/section-detection';
import { cuidSchema } from '@/lib/validations/common';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

const bodySchema = z.object({
  sectionId: z.string().min(1).max(64),
  content: z.string().max(5_000_000),
  expectedFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/, 'expectedFingerprint must be a SHA-256 hex digest'),
});

function fingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export const POST = withAdminAuth<{ id: string }>(
  async (request, session, { params }) => {
    const clientIP = getClientIP(request);
    const log = await getRouteLogger(request);

    const { id: rawId } = await params;
    const parsedId = cuidSchema.safeParse(rawId);
    if (!parsedId.success) {
      throw new ValidationError('Invalid document id', { id: ['Must be a valid CUID'] });
    }
    const documentId = parsedId.data;

    const body = await validateRequestBody(request, bodySchema);

    // Lock check first.
    const lockState = await getEditLockState(documentId);
    if (lockState.active && lockState.heldBy !== session.user.id) {
      return errorResponse('Document is being edited by another admin', {
        code: 'LOCK_HELD',
        status: 423,
        details: { heldBy: [lockState.heldBy ?? 'unknown'] },
      });
    }

    const doc = await prisma.aiKnowledgeDocument.findFirst({
      where: { id: documentId, uploadedBy: session.user.id, status: 'cleaning' },
      select: { processedContent: true, originalContent: true, fileName: true },
    });
    if (!doc) {
      throw new ValidationError(
        'Document not found, not owned by this user, or not in cleaning status'
      );
    }

    const currentContent = doc.processedContent ?? doc.originalContent ?? '';
    const sections = detectSections(currentContent);
    const section = sections.find((s) => s.id === body.sectionId) ?? null;
    if (!section) {
      return errorResponse('Section not found', {
        code: 'SECTION_NOT_FOUND',
        status: 404,
        details: { sectionId: [body.sectionId] },
      });
    }

    const sectionFingerprint = fingerprint(section.body);
    if (sectionFingerprint !== body.expectedFingerprint) {
      return errorResponse('Section has changed since edit began', {
        code: 'CONTENT_MISMATCH',
        status: 409,
        details: {
          currentBody: [section.body],
          currentFingerprint: [sectionFingerprint],
        },
      });
    }

    const nextContent = spliceSection(currentContent, section, body.content);

    await writeCleanupContent(documentId, nextContent, {
      source: 'human_section',
      actorId: session.user.id,
      sectionMarker: section.marker,
    });

    log.info('Cleanup section edit applied', {
      documentId,
      adminId: session.user.id,
      sectionMarker: section.marker,
      sectionId: section.id,
      charsAfter: nextContent.length,
    });

    logAdminAction({
      userId: session.user.id,
      action: 'knowledge_document.cleanup_edit',
      entityType: 'knowledge_document',
      entityId: documentId,
      entityName: doc.fileName,
      metadata: { scope: 'section', sectionMarker: section.marker },
      clientIp: clientIP,
    });

    return successResponse({
      documentId,
      sectionId: section.id,
      sectionMarker: section.marker,
      fingerprint: fingerprint(body.content),
      documentFingerprint: fingerprint(nextContent),
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
