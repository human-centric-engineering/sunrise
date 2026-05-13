/**
 * Admin Orchestration — Knowledge documents (list + upload)
 *
 * GET  /api/v1/admin/orchestration/knowledge/documents
 *   Paginated list with optional status + text filters.
 *
 * POST /api/v1/admin/orchestration/knowledge/documents
 *   Multipart upload. Extension whitelist is the source of truth
 *   (`ALLOWED_EXTENSIONS`). Caller-supplied MIME type is advisory —
 *   browsers often omit it for .md. 50 MB hard cap (EPUBs can be
 *   large); pre-parse `Content-Length` guard short-circuits oversize
 *   bodies before allocation.
 *
 * Authentication: Admin role required.
 */

import type { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { errorResponse, paginatedResponse, successResponse } from '@/lib/api/responses';
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
  parseDocumentMetadata,
} from '@/lib/orchestration/knowledge/document-manager';
import { requiresPreview } from '@/lib/orchestration/knowledge/parsers';
import { listDocumentsQuerySchema } from '@/lib/validations/orchestration';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { invalidateAllAgentAccess } from '@/lib/orchestration/knowledge/resolveAgentDocumentAccess';
import { cuidSchema } from '@/lib/validations/common';

/**
 * Parse `tagIds` repeated form fields (multipart) into a deduped list of valid
 * CUIDs. Unknown/malformed entries are dropped silently — the agent operator
 * doesn't need an error storm if the picker round-trips an outdated id; the
 * resolver's all-or-nothing model means dropped tags are recoverable from the
 * chunks-modal tag editor.
 */
function parseTagIdsFromForm(formData: FormData): string[] {
  const raw = formData.getAll('tagIds');
  const out = new Set<string>();
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const parsed = cuidSchema.safeParse(v);
    if (parsed.success) out.add(parsed.data);
  }
  return [...out];
}

/**
 * Apply tag grants to a freshly-created document. Skips on empty input.
 * Wrapped in try/catch so an upload doesn't fail wholesale if (say) a tag was
 * deleted between the picker fetch and the upload submit.
 */
async function applyDocumentTags(documentId: string, tagIds: string[]): Promise<number> {
  if (tagIds.length === 0) return 0;
  try {
    const result = await prisma.aiKnowledgeDocumentTag.createMany({
      data: tagIds.map((tagId) => ({ documentId, tagId })),
      skipDuplicates: true,
    });
    invalidateAllAgentAccess();
    return result.count;
  } catch {
    return 0;
  }
}

/**
 * Maximum decoded file size accepted from a multipart upload, in bytes.
 *
 * 50 MB sized for EPUB / PDF inputs — typical text documents are well
 * under 1 MB but textbook-grade PDFs and complete EPUBs land in the
 * 10–40 MB range. Raising this further pushes the post-parse memory
 * footprint into territory that would benefit from streaming ingestion.
 *
 * Synced with documentation in `.context/api/orchestration-endpoints.md`
 * (the "Max size: 50 MB" row of the POST /knowledge/documents table) —
 * keep both in step when changing.
 */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
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

  const [rawDocuments, total] = await Promise.all([
    prisma.aiKnowledgeDocument.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: {
        _count: { select: { chunks: true } },
        tags: { include: { tag: { select: { id: true, slug: true, name: true } } } },
      },
    }),
    prisma.aiKnowledgeDocument.count({ where }),
  ]);

  // Flatten the tag join rows into an inline `tags` array. The doc list page
  // renders these as chips in the table — agents granted any of these tags
  // can search this document when running in restricted mode.
  const documents = rawDocuments.map((d) => {
    const { tags, ...rest } = d;
    return {
      ...rest,
      tags: tags.map((t) => ({ id: t.tag.id, slug: t.tag.slug, name: t.tag.name })),
    };
  });

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
    // Mirrors the pre-parse `Content-Length` guard above: same code, same
    // status, same envelope shape. The post-parse path catches the case
    // where the client sent a small/missing Content-Length but a body
    // that turned out to be oversize after parsing (chunked encoding, or
    // a lying header).
    return errorResponse('File exceeds size limit', {
      code: 'FILE_TOO_LARGE',
      status: 413,
      details: { file: [`Maximum size is ${MAX_UPLOAD_BYTES} bytes`] },
    });
  }

  if (!hasAllowedExtension(file.name)) {
    return errorResponse('Unsupported file type', {
      code: 'INVALID_FILE_TYPE',
      status: 400,
      details: { file: [`Allowed extensions: ${ALLOWED_EXTENSIONS.join(', ')}`] },
    });
  }

  // Optional category from form field (legacy free-text — kept while
  // chunk.category still exists; Phase 6 drops it). Tags are the canonical
  // organisation surface.
  const categoryField = formData.get('category');
  const category =
    typeof categoryField === 'string' && categoryField.trim() ? categoryField.trim() : undefined;

  // Optional display name override — when set, replaces the filename-derived
  // doc name. Trimmed; empty strings fall back to the filename.
  const nameField = formData.get('name');
  const displayName =
    typeof nameField === 'string' && nameField.trim().length > 0 ? nameField.trim() : undefined;

  const tagIds = parseTagIdsFromForm(formData);

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

    const document = await uploadDocument(
      content,
      file.name,
      session.user.id,
      category,
      undefined,
      displayName
    );
    const tagsApplied = await applyDocumentTags(document.id, tagIds);

    log.info('Document uploaded (text)', {
      documentId: document.id,
      fileName: file.name,
      sizeBytes: file.size,
      category: document.category ?? 'none',
      tagsApplied,
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
    // Attach tags eagerly so they survive the preview→confirm round trip. If
    // the operator rejects the preview, the doc row (and its tag links) are
    // deleted via the existing reject flow.
    const tagsApplied = await applyDocumentTags(preview.document.id, tagIds);

    log.info('Document preview created (PDF)', {
      documentId: preview.document.id,
      fileName: file.name,
      sizeBytes: file.size,
      extractedTextLength: preview.extractedText.length,
      warnings: preview.warnings.length,
      extractTables,
      tagsApplied,
      adminId: session.user.id,
    });

    const meta = parseDocumentMetadata(preview.document.metadata);
    const pages = meta?.pages ?? null;

    return successResponse(
      {
        document: preview.document,
        preview: {
          extractedText: preview.extractedText,
          title: preview.title,
          // DocumentPreview.author is `string | undefined`; JSON serialises
          // `undefined` as the key being absent. The client Zod schema
          // declares author `.nullable()` (string | null) and rejects
          // undefined with "Invalid input: expected string, received
          // undefined". Coerce here so the wire format matches the
          // schema's contract.
          author: preview.author ?? null,
          sectionCount: preview.sectionCount,
          warnings: preview.warnings,
          pages,
          requiresConfirmation: true,
        },
      },
      undefined,
      { status: 201 }
    );
  }

  // EPUB, DOCX: direct buffer upload
  const document = await uploadDocumentFromBuffer(
    buffer,
    file.name,
    session.user.id,
    category,
    undefined,
    displayName
  );
  const tagsApplied = await applyDocumentTags(document.id, tagIds);

  log.info('Document uploaded (binary)', {
    documentId: document.id,
    fileName: file.name,
    format: ext,
    sizeBytes: file.size,
    category: document.category ?? 'none',
    tagsApplied,
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
