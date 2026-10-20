/**
 * Rebuild a PDF preview from a `pending_review` document as stored.
 *
 * The upload route hands the preview modal its data once, in the upload
 * response. If the operator closes the modal, the document stays in
 * `pending_review`; `previewDocument()` has already saved the extracted text and
 * parse results to the document's `metadata`, so the **Review** button reads
 * them back from `GET /knowledge/documents/:id` and reopens the same modal
 * (#807).
 *
 * @see components/admin/orchestration/knowledge/pdf-preview-modal.tsx
 * @see lib/orchestration/knowledge/document-manager.ts — `previewDocument()` writes the metadata
 */

import { z } from 'zod';

import type { PdfPreviewData } from '@/components/admin/orchestration/knowledge/document-upload-zone';

const storedDocumentResponseSchema = z.object({
  data: z.object({
    document: z.object({
      id: z.string(),
      name: z.string(),
      fileName: z.string(),
      status: z.string(),
      metadata: z
        .object({
          extractedText: z.string(),
          parsedTitle: z.string().nullable().optional(),
          parsedAuthor: z.string().nullable().optional(),
          sectionCount: z.number().nullable().optional(),
          warnings: z.array(z.string()).optional(),
          pages: z
            .array(z.object({ num: z.number(), charCount: z.number(), hasText: z.boolean() }))
            .nullable()
            .optional(),
          runCleanup: z.boolean().optional(),
        })
        .nullable(),
    }),
  }),
});

/**
 * Parse a `GET /knowledge/documents/:id` response body into the preview modal's
 * data. Returns null when the body is not a `pending_review` document carrying
 * its extracted text, so the caller can say the preview cannot be rebuilt.
 */
export function pdfPreviewFromStoredDocument(body: unknown): PdfPreviewData | null {
  const parsed = storedDocumentResponseSchema.safeParse(body);
  if (!parsed.success) return null;

  const { metadata, ...document } = parsed.data.data.document;
  if (document.status !== 'pending_review' || !metadata) return null;

  return {
    document,
    preview: {
      extractedText: metadata.extractedText,
      title: metadata.parsedTitle ?? null,
      author: metadata.parsedAuthor ?? null,
      sectionCount: metadata.sectionCount ?? 0,
      warnings: metadata.warnings ?? [],
      pages: metadata.pages ?? null,
      requiresConfirmation: true,
    },
    runCleanup: metadata.runCleanup === true,
  };
}
