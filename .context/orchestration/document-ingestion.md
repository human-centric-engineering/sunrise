# Document Ingestion Pipeline

Multi-format document parsing for the knowledge base. Converts uploaded files into chunked, embedded text for RAG retrieval.

## Supported Formats

| Format      | Extension | Reliability | Parser           | Notes                                                                            |
| ----------- | --------- | ----------- | ---------------- | -------------------------------------------------------------------------------- |
| Markdown    | `.md`     | ~95%        | Passthrough      | Existing `chunkMarkdownDocument()` handles splitting                             |
| Plain text  | `.txt`    | ~90%        | `txt-parser.ts`  | Splits on ALL CAPS headings and underline-style headings                         |
| CSV         | `.csv`    | ~95%        | `csv-parser.ts`  | RFC 4180 with delimiter sniffing; one chunk per row (batched above 5k rows)      |
| EPUB        | `.epub`   | ~85%        | `epub-parser.ts` | Best format for books. Extracts chapters via XHTML structure                     |
| DOCX        | `.docx`   | ~80%        | `docx-parser.ts` | Uses `mammoth` for markdown conversion, then heading split                       |
| PDF         | `.pdf`    | 40-70%      | `pdf-parser.ts`  | **Requires preview step.** Uses `pdf-parse` v2                                   |
| Scanned PDF | N/A       | N/A         | Not supported    | Use macOS Preview / Adobe Acrobat / `ocrmypdf` to OCR externally, then re-upload |

## Architecture

```
Upload (multipart form)
  │
  ├─ .md / .txt ──────────────► uploadDocument() ──► chunkMarkdownDocument() ──► embed ──► store
  │
  ├─ .csv ────────────────────► parseDocument() ──► uploadDocumentFromBuffer()
  │                                                  └─► uploadCsvFromParsed() ──► chunkCsvDocument() ──► embed ──► store
  │                                                       (one chunk per row; batched above 5,000 rows)
  │
  ├─ .epub / .docx ──────────► parseDocument() ──► uploadDocumentFromBuffer() ──► chunkMarkdownDocument() ──► embed ──► store
  │
  └─ .pdf ────────────────────► previewDocument() ──► admin reviews text
                                                       │
                                                       └─► confirmPreview() ──► chunkMarkdownDocument() ──► embed ──► store
                                                            (optionally with corrected text)
```

## Key Files

| File                                                 | Purpose                                                                          |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| `lib/orchestration/knowledge/parsers/index.ts`       | Format router, `parseDocument()`, `requiresPreview()`                            |
| `lib/orchestration/knowledge/parsers/txt-parser.ts`  | Plain text → sections                                                            |
| `lib/orchestration/knowledge/parsers/csv-parser.ts`  | CSV → row-per-section (RFC 4180, delimiter sniffing, header detect)              |
| `lib/orchestration/knowledge/parsers/docx-parser.ts` | DOCX → markdown → sections                                                       |
| `lib/orchestration/knowledge/parsers/epub-parser.ts` | EPUB → chapters → sections                                                       |
| `lib/orchestration/knowledge/parsers/pdf-parser.ts`  | PDF → pages → sections                                                           |
| `lib/orchestration/knowledge/parsers/types.ts`       | `ParsedDocument`, `ParsedSection` types                                          |
| `lib/orchestration/knowledge/document-manager.ts`    | `uploadDocumentFromBuffer()`, `previewDocument()`, `confirmPreview()`            |
| `lib/orchestration/knowledge/chunker.ts`             | `chunkMarkdownDocument()` (heading-aware) + `chunkCsvDocument()` (row-per-chunk) |

## API Endpoints

### Upload (existing, updated)

`POST /api/v1/admin/orchestration/knowledge/documents`

Multipart form upload. Accepts `.md`, `.markdown`, `.txt`, `.csv`, `.epub`, `.docx`, `.pdf`.

- **Text files** (`.md`, `.markdown`, `.txt`): Read as string, line-length guards apply, direct chunk+embed via `chunkMarkdownDocument`
- **CSV** (`.csv`): Read as buffer, parsed via `csv-parser.ts`, chunked one row per `csv_row` chunk via `chunkCsvDocument` (batched above 5,000 rows)
- **EPUB / DOCX** (`.epub`, `.docx`): Read as buffer, parsed, then chunk+embed via `chunkMarkdownDocument`
- **PDF**: Read as buffer, parsed, returns preview response with `requiresConfirmation: true`. The optional `extractTables=true` form field opts into vector-grid table extraction during the preview parse

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

### Chunks Inspector

`GET /api/v1/admin/orchestration/knowledge/documents/:id/chunks`

Returns every chunk for a document ordered by `chunkKey` (creation order). Used by the admin `DocumentChunksModal` and by the review flow for `pending_review` PDFs.

Response shape (each chunk):

```jsonc
{
  "id": "cuid",
  "content": "...",
  "chunkType": "pattern_overview" | "pattern_detail" | "section" | "...",
  "patternNumber": 3,
  "patternName": "Chain of Thought",
  "section": "Introduction",
  "category": "sales",
  "keywords": "pricing,discounts",
  "estimatedTokens": 482,
}
```

No pagination — documents are typically bounded to a few hundred chunks. The document row is fetched first so that a missing `id` returns 404 (`NotFoundError`) rather than an empty array.

### Fetch from URL

`POST /api/v1/admin/orchestration/knowledge/documents/fetch-url` — alternative to multipart upload when an admin has a publicly reachable URL rather than a local file.

```jsonc
{
  "url": "https://example.com/guide.md", // ≤ 2000 chars, must be absolute HTTP(S)
  "category": "optional — overrides any in-document metadata",
}
```

Pipeline:

1. Rate-limited via `adminLimiter`, body validated by an inline Zod schema.
2. `fetchDocumentFromUrl(url)` (in `lib/orchestration/knowledge/url-fetcher.ts`) performs the fetch with **SSRF protection** — the same safe-URL checks used by webhook subscriptions plus content-type sniffing and a size cap.
3. Extension is inferred from the response filename. PDFs **do not get a preview screen** through this route — they are processed through the buffer pipeline directly, which today throws for PDFs. Admins needing the preview flow should download the PDF and upload it via the multipart route.
4. Text files (`.md` / `.markdown` / `.txt`) go through `uploadDocument`; binary formats go through `uploadDocumentFromBuffer`. Either call records the original URL so the provenance is visible in the admin UI.
5. Writes an `knowledge_document.create` entry to the admin audit log with `sourceUrl` in metadata.

Returns the created document with HTTP 201.

## PDF Preview Flow

1. Admin uploads PDF via the documents endpoint
2. API returns extracted text + warnings for review
3. Admin reviews in the UI:
   - If text looks good → confirm as-is
   - If text has issues → edit/correct the text, then confirm with `correctedContent`
   - If text is garbage → re-upload in a better format (EPUB, DOCX)
4. On confirm, the text is chunked and embedded normally

This human-in-the-loop approach turns unreliable PDF parsing into a usable workflow.

### Per-page scanned diagnostic

The PDF parser reads per-page text from `pdf-parse`'s `pages[]` array. When a
page produces fewer than 50 characters of extractable text it is treated as
scanned-suspect, and consecutive scanned pages are grouped into a single
warning per range (e.g. `Pages 4–7 of 22 produced no extractable text — likely
scanned`). When EVERY page is empty the legacy doc-wide warning is emitted
instead. Per-page char counts are persisted on the preview metadata as
`pages: [{ num, charCount, hasText }]` so a future page-picker UI can render
without another parser change.

For scanned PDFs Sunrise does not ship OCR — produce a searchable PDF
externally first (macOS Preview, Adobe Acrobat, `ocrmypdf`) then re-upload.

### Opt-in table extraction

PDF uploads carry a "Extract tables (experimental)" checkbox. When checked,
the parser runs `pdf-parse` `getTable()` per page. Each detected vector-grid
table is rendered as a markdown pipe table and appended to that page's text
fenced by HTML comments:

```
<!-- table-start -->
| Header A | Header B |
| --- | --- |
| Row 1A | Row 1B |
<!-- table-end -->
```

Default off — `getTable()` can produce false positives on pages with non-
tabular vector content. The admin sees the rendered output in the preview
textarea and can delete fenced blocks before confirming. The fence comments
are also a forward path: a future chunker enhancement can teach
`chunkMarkdownDocument` to keep table blocks atomic. Today, a table whose
markdown exceeds the chunker's 800-token max may split across chunks.

#### Cell sanitisation invariant

`renderMarkdownTable` only escapes `|` and replaces `\n` in cell text. It
does NOT escape `<` / `>` / `&`. This is safe today because chunk content
is rendered downstream by `react-markdown` with no plugins — raw HTML in
markdown source is treated as inert text, so a PDF cell containing
`<script>` cannot execute. Storing HTML-escaped text would also surface as
visible `&lt;` entities in the preview textarea, confusing admins.

If a future change adds `rehype-raw` (or any plugin that interprets raw
HTML) to the chunk renderer, harden `renderMarkdownTable` first to escape
`<` / `>` / `&` on every cell. See the matching code comments in
`lib/orchestration/knowledge/parsers/pdf-parser.ts` and
`components/admin/orchestration/knowledge/explore-tab.tsx`.

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

## CSV Ingestion

CSV files use a dedicated path:

- **Parser** (`csv-parser.ts`) sniffs the delimiter from the first 5 non-empty
  lines (`,` / `\t` / `;`, ties → comma), detects whether row 1 is a header
  (heuristic: every cell non-empty, no purely numeric cells, fewer than half
  the cells duplicate row 2), then emits one `ParsedSection` per data row
  with content rendered as `Header1: Value1 | Header2: Value2 | ...`.
- **Chunker** (`chunkCsvDocument` in `chunker.ts`) emits one `csv_row` chunk
  per row so retrieval can target a single matching row rather than a
  diluted multi-row window.
- **Batching:** above 5,000 rows the chunker batches every 10 rows into a
  single chunk to cap embedding cost. Constants: `CSV_ROW_BATCH_THRESHOLD`,
  `CSV_ROWS_PER_BATCH`.
- **Re-chunking limitation:** `rechunkDocument` joins stored chunks with
  `\n\n---\n\n` which loses row-level granularity for CSV. Re-uploading is
  preferred when CSV content changes.
- **No preview step:** CSVs are deterministic to parse and skip the PDF-style
  preview/confirm flow.

## Dependencies

| Package     | Version | Used by     |
| ----------- | ------- | ----------- |
| `mammoth`   | ^1.12   | DOCX parser |
| `epub2`     | ^3.0    | EPUB parser |
| `pdf-parse` | ^2.4    | PDF parser  |

CSV parsing is in-house (no third-party dependency).
