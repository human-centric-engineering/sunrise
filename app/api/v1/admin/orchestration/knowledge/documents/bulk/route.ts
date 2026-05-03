/**
 * Admin Orchestration — Bulk document upload
 *
 * POST /api/v1/admin/orchestration/knowledge/documents/bulk
 *
 * Accepts multipart FormData with multiple files (max 10 per batch).
 * Processes each sequentially through the standard upload pipeline.
 * Returns per-file results.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import {
  uploadDocument,
  uploadDocumentFromBuffer,
} from '@/lib/orchestration/knowledge/document-manager';
import { requiresPreview } from '@/lib/orchestration/knowledge/parsers';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { logger } from '@/lib/logging';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB per file
const MAX_FILES_PER_BATCH = 10;
const ALLOWED_EXTENSIONS = ['.md', '.markdown', '.txt', '.csv', '.pdf', '.docx', '.epub'];
const MAX_TEXT_LINES = 100_000;
const MAX_LINE_LENGTH = 10_000;

function hasAllowedExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function isTextFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.txt');
}

interface FileResult {
  fileName: string;
  status: 'success' | 'skipped_pdf' | 'error';
  documentId?: string;
  error?: string;
}

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

  const files = formData.getAll('files').filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    throw new ValidationError('No files provided', {
      files: ['At least one file must be supplied in the `files` form field'],
    });
  }

  if (files.length > MAX_FILES_PER_BATCH) {
    throw new ValidationError(`Maximum ${MAX_FILES_PER_BATCH} files per batch`, {
      files: [`Received ${files.length} files, limit is ${MAX_FILES_PER_BATCH}`],
    });
  }

  const category = formData.get('category');
  const categoryStr =
    typeof category === 'string' && category.trim().length > 0 ? category.trim() : undefined;

  const results: FileResult[] = [];

  for (const file of files) {
    if (file.size > MAX_UPLOAD_BYTES) {
      results.push({ fileName: file.name, status: 'error', error: 'File too large (50 MB max)' });
      continue;
    }

    if (!hasAllowedExtension(file.name)) {
      results.push({
        fileName: file.name,
        status: 'error',
        error: `Unsupported extension. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`,
      });
      continue;
    }

    try {
      if (isTextFile(file.name)) {
        const content = await file.text();
        const lines = content.split('\n');
        if (lines.length > MAX_TEXT_LINES) {
          results.push({ fileName: file.name, status: 'error', error: 'File has too many lines' });
          continue;
        }
        if (lines.some((l) => l.length > MAX_LINE_LENGTH)) {
          results.push({
            fileName: file.name,
            status: 'error',
            error: 'File contains lines exceeding max length',
          });
          continue;
        }

        const doc = await uploadDocument(content, file.name, session.user.id, categoryStr);
        results.push({ fileName: file.name, status: 'success', documentId: doc.id });
      } else if (requiresPreview(file.name)) {
        // PDFs need preview flow — skip in bulk, return status so UI can handle individually
        results.push({ fileName: file.name, status: 'skipped_pdf' });
      } else {
        // EPUB, DOCX
        const buffer = Buffer.from(await file.arrayBuffer());
        const doc = await uploadDocumentFromBuffer(buffer, file.name, session.user.id, categoryStr);
        results.push({ fileName: file.name, status: 'success', documentId: doc.id });
      }
    } catch (err) {
      logger.error('Bulk upload: file processing failed', {
        fileName: file.name,
        error: err instanceof Error ? err.message : String(err),
      });
      results.push({
        fileName: file.name,
        status: 'error',
        error: err instanceof Error ? err.message : 'Upload failed',
      });
    }
  }

  const successCount = results.filter((r) => r.status === 'success').length;

  log.info('Bulk document upload', {
    total: files.length,
    success: successCount,
    errors: results.filter((r) => r.status === 'error').length,
    skippedPdf: results.filter((r) => r.status === 'skipped_pdf').length,
    adminId: session.user.id,
  });

  if (successCount > 0) {
    logAdminAction({
      userId: session.user.id,
      action: 'knowledge_document.bulk_create',
      entityType: 'knowledge_document',
      metadata: {
        fileCount: files.length,
        successCount,
        fileNames: results.filter((r) => r.status === 'success').map((r) => r.fileName),
      },
      clientIp: clientIP,
    });
  }

  return successResponse({ results }, undefined, { status: 201 });
});
