/**
 * Admin Orchestration — Fetch Document from URL
 *
 * POST /api/v1/admin/orchestration/knowledge/documents/fetch-url
 *
 * Fetches a document from a remote URL and imports it into the
 * knowledge base. Includes SSRF protection and size limits.
 *
 * Authentication: Admin role required.
 */

import { z } from 'zod';
import { withAdminAuth } from '@/lib/auth/guards';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { fetchDocumentFromUrl } from '@/lib/orchestration/knowledge/url-fetcher';
import {
  uploadDocument,
  uploadDocumentFromBuffer,
} from '@/lib/orchestration/knowledge/document-manager';
import { requiresPreview } from '@/lib/orchestration/knowledge/parsers';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

const fetchUrlSchema = z.object({
  url: z.string().url().max(2000),
  category: z.string().max(100).optional(),
});

export const POST = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, fetchUrlSchema);

  const fetched = await fetchDocumentFromUrl(body.url);

  let document;
  const isText =
    fetched.fileName.endsWith('.md') ||
    fetched.fileName.endsWith('.markdown') ||
    fetched.fileName.endsWith('.txt');

  if (requiresPreview(fetched.fileName)) {
    const ext = fetched.fileName.split('.').pop()?.toUpperCase() ?? 'This file';
    return errorResponse(
      `${ext} files require the preview step. Download the file and upload it via the document upload form.`,
      { code: 'PREVIEW_REQUIRED', status: 422 }
    );
  } else if (isText) {
    const content = fetched.content.toString('utf-8');
    document = await uploadDocument(
      content,
      fetched.fileName,
      session.user.id,
      body.category,
      body.url
    );
  } else {
    document = await uploadDocumentFromBuffer(
      fetched.content,
      fetched.fileName,
      session.user.id,
      body.category,
      body.url
    );
  }

  logAdminAction({
    userId: session.user.id,
    action: 'knowledge_document.create',
    entityType: 'knowledge_document',
    entityId: document.id,
    entityName: document.name,
    metadata: { sourceUrl: body.url, fileName: fetched.fileName },
    clientIp: clientIP,
  });

  log.info('Document fetched from URL', {
    url: body.url,
    documentId: document.id,
    fileName: fetched.fileName,
  });

  return successResponse(document, undefined, { status: 201 });
});
