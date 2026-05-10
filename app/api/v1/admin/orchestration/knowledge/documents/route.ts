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
import { enforceContentLengthCap } from '@/lib/api/multipart-guard';
import { validateQueryParams } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import {
  uploadDocument,
  uploadDocumentFromBuffer,
  previewDocument,
} from '@/lib/orchestration/knowledge/document-manager';
import { requiresPreview } from '@/lib/orchestration/knowledge/parsers';
import { listDocumentsQuerySchema } from '@/lib/validations/orchestration';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB (EPUBs can be large)
/**
 * Pre-parse body cap. Adds 4 KB of headroom over `MAX_UPLOAD_BYTES` for
 * multipart boundaries plus the optional `category` form field. Rejects
 * with 413 `FILE_TOO_LARGE` before `request.formData()` allocates memory.
 */
const MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES + 4 * 1024;
const MAX_LINE_COUNT = 100_000;
const MAX_LINE_LENGTH = 10_000;
const ALLOWED_EXTENSIONS = ['.md', '.markdown', '.txt', '.csv', '.epub', '.docx', '.pdf'] as const;
/** Extensions where the upload is a text file — line-length guards apply. */
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);

function hasAllowedExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function getExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

export const GET = withAdminAuth(async (request, _session) => {
  const log = await getRouteLogger(request);
  const { searchParams } = new URL(request.url);
  const { page, limit, status, scope, category, q } = validateQueryParams(
    searchParams,
    listDocumentsQuerySchema
  );
  const skip = (page - 1) * limit;

  const where: Prisma.AiKnowledgeDocumentWhereInput = {};
  if (status) where.status = status;
  if (scope) where.scope = scope;
  if (category) where.category = category;
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

  // Pre-parse body-size guard. `request.formData()` materialises the entire
  // multipart body in memory before the post-parse `file.size` check fires,
  // so a malicious admin could OOM a self-hosted Node process with a
  // multi-GB body. The guard reads `Content-Length` and rejects with 413
  // before any allocation. Same pattern as the transcribe routes and the
  // MCP transport (`app/api/v1/mcp/route.ts:76-85`).
  const oversize = enforceContentLengthCap(request, {
    maxBytes: MAX_REQUEST_BYTES,
    errorCode: 'FILE_TOO_LARGE',
    errorMessage: 'File exceeds size limit',
    details: { file: [`Maximum size is ${MAX_UPLOAD_BYTES} bytes`] },
  });
  if (oversize) return oversize;

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

  // Optional category from form field
  const categoryField = formData.get('category');
  const category =
    typeof categoryField === 'string' && categoryField.trim() ? categoryField.trim() : undefined;

  const ext = getExtension(file.name);

  // Text-based formats: read as string, apply line-length guards
  if (TEXT_EXTENSIONS.has(ext)) {
    const content = await file.text();

    const lines = content.split('\n');
    if (lines.length > MAX_LINE_COUNT) {
      throw new ValidationError('Document has too many lines', {
        file: [`Maximum ${MAX_LINE_COUNT.toLocaleString()} lines allowed`],
      });
    }
    if (lines.some((line) => line.length > MAX_LINE_LENGTH)) {
      throw new ValidationError('Document contains excessively long lines', {
        file: [`Maximum ${MAX_LINE_LENGTH.toLocaleString()} characters per line`],
      });
    }

    const document = await uploadDocument(content, file.name, session.user.id, category);

    log.info('Document uploaded (text)', {
      documentId: document.id,
      fileName: file.name,
      sizeBytes: file.size,
      category: document.category ?? 'none',
      adminId: session.user.id,
    });

    logAdminAction({
      userId: session.user.id,
      action: 'knowledge_document.create',
      entityType: 'knowledge_document',
      entityId: document.id,
      entityName: file.name,
      clientIp: clientIP,
    });

    return successResponse({ document }, undefined, { status: 201 });
  }

  // Binary formats: read as buffer, route through parser pipeline
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // PDF requires preview step
  if (requiresPreview(file.name)) {
    const extractTablesField = formData.get('extractTables');
    const extractTables =
      typeof extractTablesField === 'string' &&
      ['true', '1', 'on', 'yes'].includes(extractTablesField.toLowerCase());

    const preview = await previewDocument(buffer, file.name, session.user.id, { extractTables });

    log.info('Document preview created (PDF)', {
      documentId: preview.document.id,
      fileName: file.name,
      sizeBytes: file.size,
      extractedTextLength: preview.extractedText.length,
      warnings: preview.warnings.length,
      extractTables,
      adminId: session.user.id,
    });

    return successResponse(
      {
        document: preview.document,
        preview: {
          extractedText: preview.extractedText,
          title: preview.title,
          author: preview.author,
          sectionCount: preview.sectionCount,
          warnings: preview.warnings,
          requiresConfirmation: true,
        },
      },
      undefined,
      { status: 201 }
    );
  }

  // EPUB, DOCX: direct buffer upload
  const document = await uploadDocumentFromBuffer(buffer, file.name, session.user.id, category);

  log.info('Document uploaded (binary)', {
    documentId: document.id,
    fileName: file.name,
    format: ext,
    sizeBytes: file.size,
    category: document.category ?? 'none',
    adminId: session.user.id,
  });

  logAdminAction({
    userId: session.user.id,
    action: 'knowledge_document.create',
    entityType: 'knowledge_document',
    entityId: document.id,
    entityName: file.name,
    clientIp: clientIP,
  });

  return successResponse({ document }, undefined, { status: 201 });
});
