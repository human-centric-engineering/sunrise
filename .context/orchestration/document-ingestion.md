# Document Ingestion Pipeline

Multi-format document parsing for the knowledge base. Converts uploaded files into chunked, embedded text for RAG retrieval.

## Supported Formats

| Format      | Extension | Reliability | Parser           | Notes                                                        |
| ----------- | --------- | ----------- | ---------------- | ------------------------------------------------------------ |
| Markdown    | `.md`     | ~95%        | Passthrough      | Existing `chunkMarkdownDocument()` handles splitting         |
| Plain text  | `.txt`    | ~90%        | `txt-parser.ts`  | Splits on ALL CAPS headings and underline-style headings     |
| EPUB        | `.epub`   | ~85%        | `epub-parser.ts` | Best format for books. Extracts chapters via XHTML structure |
| DOCX        | `.docx`   | ~80%        | `docx-parser.ts` | Uses `mammoth` for markdown conversion, then heading split   |
| PDF         | `.pdf`    | 40-70%      | `pdf-parser.ts`  | **Requires preview step.** Uses `pdf-parse` v2               |
| Scanned PDF | N/A       | N/A         | Not supported    | Instruct clients to provide digital-native formats           |

## Architecture

```
Upload (multipart form)
  │
  ├─ .md / .txt ──────────────► uploadDocument() ──► chunk ──► embed ──► store
  │
  ├─ .epub / .docx ──────────► parseDocument() ──► uploadDocumentFromBuffer() ──► chunk ──► embed ──► store
  │
  └─ .pdf ────────────────────► previewDocument() ──► admin reviews text
                                                       │
                                                       └─► confirmPreview() ──► chunk ──► embed ──► store
                                                            (optionally with corrected text)
```

## Key Files

| File                                                 | Purpose                                                               |
| ---------------------------------------------------- | --------------------------------------------------------------------- |
| `lib/orchestration/knowledge/parsers/index.ts`       | Format router, `parseDocument()`, `requiresPreview()`                 |
| `lib/orchestration/knowledge/parsers/txt-parser.ts`  | Plain text → sections                                                 |
| `lib/orchestration/knowledge/parsers/docx-parser.ts` | DOCX → markdown → sections                                            |
| `lib/orchestration/knowledge/parsers/epub-parser.ts` | EPUB → chapters → sections                                            |
| `lib/orchestration/knowledge/parsers/pdf-parser.ts`  | PDF → pages → sections                                                |
| `lib/orchestration/knowledge/parsers/types.ts`       | `ParsedDocument`, `ParsedSection` types                               |
| `lib/orchestration/knowledge/document-manager.ts`    | `uploadDocumentFromBuffer()`, `previewDocument()`, `confirmPreview()` |
| `lib/orchestration/knowledge/chunker.ts`             | Markdown chunking (downstream of parsers)                             |

## API Endpoints

### Upload (existing, updated)

`POST /api/v1/admin/orchestration/knowledge/documents`

Multipart form upload. Now accepts `.md`, `.txt`, `.epub`, `.docx`, `.pdf` (was `.md`/`.txt` only).

- **Text files** (`.md`, `.txt`): Read as string, line-length guards apply, direct chunk+embed
- **Binary files** (`.epub`, `.docx`): Read as buffer, parsed, then chunk+embed
- **PDF**: Read as buffer, parsed, returns preview response with `requiresConfirmation: true`

Max size: 50 MB (increased from 10 MB to accommodate EPUBs).

**PDF response includes:**

```jsonc
{
  "document": { "id": "...", "status": "pending_review" },
  "preview": {
    "extractedText": "...",
    "title": "Book Title",
    "author": "Author Name",
    "sectionCount": 42,
    "warnings": ["..."],
    "requiresConfirmation": true,
  },
}
```

### Confirm Preview (new)

`POST /api/v1/admin/orchestration/knowledge/documents/:id/confirm`

Confirms a `pending_review` document and proceeds with chunking + embedding.

```jsonc
{
  "documentId": "cuid (must match URL param)",
  "correctedContent": "optional — replaces auto-extracted text",
  "category": "optional — category override",
}
```

## PDF Preview Flow

1. Admin uploads PDF via the documents endpoint
2. API returns extracted text + warnings for review
3. Admin reviews in the UI:
   - If text looks good → confirm as-is
   - If text has issues → edit/correct the text, then confirm with `correctedContent`
   - If text is garbage → re-upload in a better format (EPUB, DOCX)
4. On confirm, the text is chunked and embedded normally

This human-in-the-loop approach turns unreliable PDF parsing into a usable workflow.

## Document Statuses

| Status           | Meaning                                                     |
| ---------------- | ----------------------------------------------------------- |
| `processing`     | Actively being chunked and embedded                         |
| `ready`          | Successfully processed, chunks available for search         |
| `failed`         | Processing failed (see `errorMessage`)                      |
| `pending_review` | PDF uploaded, awaiting admin confirmation of extracted text |

## Parser Output

All parsers produce a `ParsedDocument`:

```typescript
interface ParsedDocument {
  title: string;
  author?: string;
  sections: ParsedSection[];
  fullText: string;
  metadata: Record<string, string>;
  warnings: string[];
}
```

The `fullText` field is fed into `chunkMarkdownDocument()` for splitting and embedding. Sections are informational metadata.

## Dependencies

| Package     | Version | Used by     |
| ----------- | ------- | ----------- |
| `mammoth`   | ^1.12   | DOCX parser |
| `epub2`     | ^3.0    | EPUB parser |
| `pdf-parse` | ^2.4    | PDF parser  |
