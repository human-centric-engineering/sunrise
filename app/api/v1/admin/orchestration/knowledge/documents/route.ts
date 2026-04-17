/**
 * Admin Orchestration — Knowledge documents (list + upload)
 *
 * GET  /api/v1/admin/orchestration/knowledge/documents
 *   Paginated list with optional status + text filters.
 *
 * POST /api/v1/admin/orchestration/knowledge/documents
 *   Multipart upload. Text-only this session — extension whitelist is
 *   the source of truth (.md / .markdown / .txt). Caller-supplied MIME
 *   type is advisory; browsers often omit it for .md. 10 MB hard cap.
 *
 * Authentication: Admin role required.
 */

import type { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { paginatedResponse, successResponse } from '@/lib/api/responses';
import { ValidationError } from '@/lib/api/errors';
import { validateQueryParams } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { uploadDocument } from '@/lib/orchestration/knowledge/document-manager';
import { listDocumentsQuerySchema } from '@/lib/validations/orchestration';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_EXTENSIONS = ['.md', '.markdown', '.txt'] as const;

function hasAllowedExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export const GET = withAdminAuth(async (request, _session) => {
  const log = await getRouteLogger(request);
  const { searchParams } = new URL(request.url);
  const { page, limit, status, scope, q } = validateQueryParams(
    searchParams,
    listDocumentsQuerySchema
  );
  const skip = (page - 1) * limit;

  const where: Prisma.AiKnowledgeDocumentWhereInput = {};
  if (status) where.status = status;
  if (scope) where.scope = scope;
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { fileName: { contains: q, mode: 'insensitive' } },
    ];
  }

  const [documents, total] = await Promise.all([
    prisma.aiKnowledgeDocument.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: { _count: { select: { chunks: true } } },
    }),
    prisma.aiKnowledgeDocument.count({ where }),
  ]);

  log.info('Documents listed', { count: documents.length, total });

  return paginatedResponse(documents, { page, limit, total });
});

export const POST = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    throw new ValidationError('Expected multipart/form-data body');
  }

  const file = formData.get('file');
  if (!(file instanceof File)) {
    throw new ValidationError('Missing or invalid file field', {
      file: ['A file must be supplied in the `file` form field'],
    });
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    throw new ValidationError('File too large', {
      file: [`Maximum size is ${MAX_UPLOAD_BYTES} bytes`],
    });
  }

  if (!hasAllowedExtension(file.name)) {
    throw new ValidationError('Unsupported file type', {
      file: [`Allowed extensions: ${ALLOWED_EXTENSIONS.join(', ')}`],
    });
  }

  // Advisory MIME check: must start with `text/` or be empty (browsers
  // often omit the content-type for .md). Extension is the real gate.
  if (file.type && !file.type.startsWith('text/')) {
    throw new ValidationError('Unsupported file type', {
      file: ['Only text files are accepted'],
    });
  }

  const content = await file.text();

  const document = await uploadDocument(content, file.name, session.user.id);

  log.info('Document uploaded', {
    documentId: document.id,
    fileName: file.name,
    sizeBytes: file.size,
    adminId: session.user.id,
  });

  return successResponse({ document }, undefined, { status: 201 });
});
