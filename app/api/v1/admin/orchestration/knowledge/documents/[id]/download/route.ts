/**
 * Admin Orchestration — Download a knowledge document's text
 *
 *   GET /api/v1/admin/orchestration/knowledge/documents/:id/download?variant=…
 *
 * Returns the document's text as a Markdown attachment. What text exists
 * depends on where the document is in its lifecycle:
 *
 * | Status           | cleaned            | original           | chunks            |
 * | ---------------- | ------------------ | ------------------ | ----------------- |
 * | `pending_review` | —                  | extracted PDF text | —                 |
 * | `cleaning`       | `processedContent` | `originalContent`  | —                 |
 * | `ready`          | —                  | —                  | rebuilt from rows |
 *
 * `originalContent` and `processedContent` are BOTH cleared on finalise to
 * reclaim storage (a cleanup document holds two full copies of itself until
 * then), so for a finished document the stored chunks are the only remaining
 * copy of the text. Rebuilding from them is lossy in the same way the
 * Coverage column already reports: the chunker can drop a fragment that fits
 * nowhere, so the rebuild is the ingested text, not the source file.
 *
 * `variant` picks explicitly; omitting it takes the best available for the
 * document's state (cleaned → original → chunks). The chosen variant comes
 * back in the `X-Document-Variant` header so the caller can label what it got.
 *
 * Authentication: Admin role required.
 */

import { z } from 'zod';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { errorResponse } from '@/lib/api/responses';
import { ValidationError } from '@/lib/api/errors';
import { validateQueryParams } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { cuidSchema } from '@/lib/validations/common';
import { parseDocumentMetadata } from '@/lib/orchestration/knowledge/document-manager';
import { rebuildTextFromChunks } from '@/lib/orchestration/knowledge/document-text';

const querySchema = z.object({
  variant: z.enum(['cleaned', 'original', 'chunks', 'auto']).default('auto'),
});

type Variant = 'cleaned' | 'original' | 'chunks';

export const GET = withAdminAuth<{ id: string }>(
  async (request, _session, { params }) => {
    const log = await getRouteLogger(request);
    const { id: rawId } = await params;
    const parsedId = cuidSchema.safeParse(rawId);
    if (!parsedId.success) {
      throw new ValidationError('Invalid document id', { id: ['Must be a valid CUID'] });
    }
    const documentId = parsedId.data;

    const { searchParams } = new URL(request.url);
    const { variant: requested } = validateQueryParams(searchParams, querySchema);

    const doc = await prisma.aiKnowledgeDocument.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        name: true,
        fileName: true,
        slug: true,
        status: true,
        originalContent: true,
        processedContent: true,
        metadata: true,
      },
    });
    if (!doc) {
      return errorResponse('Document not found', {
        code: 'DOCUMENT_NOT_FOUND',
        status: 404,
        details: { id: [documentId] },
      });
    }

    // PDF preview documents have not been written to originalContent yet — the
    // extracted text lives on metadata until the admin confirms.
    const previewText = parseDocumentMetadata(doc.metadata)?.extractedText ?? null;
    const original = doc.originalContent ?? previewText;

    const resolveAuto = (): Variant =>
      doc.processedContent !== null ? 'cleaned' : original !== null ? 'original' : 'chunks';
    const variant: Variant = requested === 'auto' ? resolveAuto() : requested;

    let text: string | null;
    let chunkCount: number | null = null;
    if (variant === 'cleaned') {
      text = doc.processedContent;
    } else if (variant === 'original') {
      text = original;
    } else {
      const rebuilt = await rebuildTextFromChunks(documentId);
      text = rebuilt.text;
      chunkCount = rebuilt.chunkCount;
    }

    if (text === null || text.length === 0) {
      // Not an error state to hide: say which variant was empty and what the
      // document's status is, because the two together explain why.
      return errorResponse('No text available for this document in the requested form', {
        code: 'NO_TEXT_AVAILABLE',
        status: 404,
        details: { variant: [variant], status: [doc.status] },
      });
    }

    log.info('Knowledge document text downloaded', {
      documentId,
      variant,
      status: doc.status,
      bytes: text.length,
      ...(chunkCount === null ? {} : { chunkCount }),
    });

    // The slug is already filename-safe (slugify + hash suffix); the display
    // name is not, and a quote in it would break the header.
    const filename = `${doc.slug}${variant === 'original' ? '-original' : ''}.md`;

    return new Response(text, {
      status: 200,
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'X-Document-Variant': variant,
        'Cache-Control': 'no-store',
      },
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
