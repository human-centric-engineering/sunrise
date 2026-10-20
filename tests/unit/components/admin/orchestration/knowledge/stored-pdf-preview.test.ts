/**
 * pdfPreviewFromStoredDocument — rebuilds the PDF preview modal's data from a
 * pending_review document as `GET /knowledge/documents/:id` returns it (#807).
 *
 * @see components/admin/orchestration/knowledge/stored-pdf-preview.ts
 */

import { describe, it, expect } from 'vitest';

import { pdfPreviewFromStoredDocument } from '@/components/admin/orchestration/knowledge/stored-pdf-preview';

function body(document: Record<string, unknown>) {
  return {
    success: true,
    data: {
      document: {
        id: 'doc-1',
        name: 'Handbook',
        fileName: 'handbook.pdf',
        status: 'pending_review',
        // Fields the route also returns, which the preview ignores.
        slug: 'handbook-a3f9c1b2',
        tagIds: [],
        ...document,
      },
    },
  };
}

describe('pdfPreviewFromStoredDocument', () => {
  it('maps the metadata previewDocument() stores onto the modal data', () => {
    const result = pdfPreviewFromStoredDocument(
      body({
        metadata: {
          extractedText: 'Full text',
          parsedTitle: 'Handbook',
          parsedAuthor: 'HR',
          sectionCount: 4,
          warnings: ['Low text on page 2'],
          pages: [{ num: 1, charCount: 900, hasText: true }],
          runCleanup: true,
        },
      })
    );

    expect(result).toEqual({
      document: {
        id: 'doc-1',
        name: 'Handbook',
        fileName: 'handbook.pdf',
        status: 'pending_review',
      },
      preview: {
        extractedText: 'Full text',
        title: 'Handbook',
        author: 'HR',
        sectionCount: 4,
        warnings: ['Low text on page 2'],
        pages: [{ num: 1, charCount: 900, hasText: true }],
        requiresConfirmation: true,
      },
      runCleanup: true,
    });
  });

  it('fills defaults for optional fields and treats a missing runCleanup as false', () => {
    const result = pdfPreviewFromStoredDocument(body({ metadata: { extractedText: 'Text' } }));

    expect(result?.preview).toEqual({
      extractedText: 'Text',
      title: null,
      author: null,
      sectionCount: 0,
      warnings: [],
      pages: null,
      requiresConfirmation: true,
    });
    expect(result?.runCleanup).toBe(false);
  });

  it.each([
    ['no metadata', body({ metadata: null })],
    ['metadata without the extracted text', body({ metadata: { parsedTitle: 'x' } })],
    [
      'a document no longer pending review',
      body({ status: 'ready', metadata: { extractedText: 'x' } }),
    ],
    ['an error envelope', { success: false, error: { code: 'NOT_FOUND', message: 'gone' } }],
    ['a non-object body', null],
  ])('returns null for %s', (_label, input) => {
    expect(pdfPreviewFromStoredDocument(input)).toBeNull();
  });
});
