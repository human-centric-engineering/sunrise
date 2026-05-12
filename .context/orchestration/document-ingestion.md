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

| File                                                 | Purpose                                                                                                                                                                                            |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/orchestration/knowledge/parsers/index.ts`       | Format router, `parseDocument()`, `requiresPreview()`                                                                                                                                              |
| `lib/orchestration/knowledge/parsers/txt-parser.ts`  | Plain text → sections                                                                                                                                                                              |
| `lib/orchestration/knowledge/parsers/csv-parser.ts`  | CSV → row-per-section (RFC 4180, delimiter sniffing, header detect)                                                                                                                                |
| `lib/orchestration/knowledge/parsers/docx-parser.ts` | DOCX → markdown → sections                                                                                                                                                                         |
| `lib/orchestration/knowledge/parsers/epub-parser.ts` | EPUB → chapters → sections                                                                                                                                                                         |
| `lib/orchestration/knowledge/parsers/pdf-parser.ts`  | PDF → pages → sections                                                                                                                                                                             |
| `lib/orchestration/knowledge/parsers/types.ts`       | `ParsedDocument`, `ParsedSection` types                                                                                                                                                            |
| `lib/orchestration/knowledge/document-manager.ts`    | `uploadDocumentFromBuffer()`, `previewDocument()`, `confirmPreview()`                                                                                                                              |
| `lib/orchestration/knowledge/chunker.ts`             | `chunkMarkdownDocument()` (heading-aware) + `chunkCsvDocument()` (row-per-chunk)                                                                                                                   |
| `lib/orchestration/knowledge/chunker-config.ts`      | Chunker constants (`MIN_CHUNK_TOKENS`, `MAX_CHUNK_TOKENS`, `CHARS_PER_TOKEN_ESTIMATE`, CSV caps) — extracted so client components can import without pulling the DB client into the browser bundle |
| `lib/orchestration/knowledge/coverage.ts`            | `computeCoverage()`, `buildCoverageWarning()` — post-chunk text-capture metric, persisted to `document.metadata.coverage`                                                                          |

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
    "pages": [{ "num": 1, "charCount": 1240, "hasText": true }, ...],
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
  // Heading-driven for seeded patterns and authored markdown; "text"
  // is the default for generic content (PDF prose, plain markdown
  // without `##` headings) that goes through the semantic chunker.
  "chunkType": "text" | "pattern_overview" | "pattern_section" | "glossary" | "composition_recipe" | "selection_guide" | "cost_reference" | "context_engineering" | "emerging_concepts" | "ecosystem",
  "patternNumber": 3,
  "patternName": "Chain of Thought",
  // Author-supplied heading, or — for generic content without
  // headings — the chunk's first sentence (≤80 chars) used as a
  // human-readable title in the graph view.
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

### Re-upload dedup

If the same admin uploads the same PDF a second time (matched by SHA-256 of
the bytes) while a previous `pending_review` row from that admin still exists,
`previewDocument` refreshes that row in place rather than creating a second
one. This keeps the queue clean for the common abandon-then-retry case (e.g.
the admin tried once without the table-extraction checkbox and wants to retry
with it on). Dedup is scoped to the uploading user, so two admins triaging
the same source material don't clobber each other.

### Per-page scanned diagnostic

The PDF parser reads per-page text from `pdf-parse`'s `pages[]` array. When a
page produces fewer than 50 characters of extractable text it is treated as
scanned-suspect, and consecutive scanned pages are grouped into a single
warning per range (e.g. `Pages 4–7 of 22 produced no extractable text — likely
scanned`). When EVERY page is empty the legacy doc-wide warning is emitted
instead. Per-page char counts are persisted on the preview metadata as
`pages: [{ num, charCount, hasText }]` so a future page-picker UI can render
without another parser change.

### Header/footer stripping

After table-merge and before `pageInfo` / `fullText` computation, the PDF parser
runs `stripHeadersAndFooters()` on the extracted page entries. It:

1. Scans the top 2 and bottom 2 non-blank lines of every page to build a
   candidate set.
2. Normalises each candidate (collapse whitespace, replace digit runs with `#`,
   lowercase) and tallies how many pages it appears on.
3. Any candidate that appears on ≥ 30 % of pages **and** ≥ 3 absolute pages is
   classified as a header/footer pattern.
4. Strips matching lines from the top and bottom of every page (capped at 3
   lines per side so a misfiring heuristic can't eat body content).

The number of stripped lines and pattern count are written to
`document.metadata.headersFootersStripped` / `document.metadata.headerFooterPatterns`
so the admin can see the effect. No-op on documents fewer than 3 pages.

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

## Coverage Metric

After every chunking operation the pipeline computes a coverage metric via
`lib/orchestration/knowledge/coverage.ts` and persists it on the document:

```jsonc
{
  "coverage": {
    "parsedChars": 124000, // length of source text fed into the chunker
    "chunkChars": 123200, // sum of all stored chunk content lengths (trimmed)
    "coveragePct": 99.4, // (chunkChars / parsedChars) × 100, rounded to 1 dp
  },
}
```

`coveragePct` can exceed 100 because heading-aware chunking re-emits section
titles inside each child chunk — over-capture is harmless, only under-capture
warrants attention. When `coveragePct < 95` a warning is appended to
`document.metadata.warnings` and surfaced in the admin Chunks Inspector.

This metric is computed on `uploadDocument`, `uploadCsvFromParsed`,
`confirmPreview`, and `rechunkDocument`.

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

**Page boundaries in `fullText`** are joined with `\n\n` (blank-line paragraph break), not `\f` (form-feed). pdfjs-dist emits visual lines separated by `\n` but rarely produces double-newlines between paragraphs; joining pages with `\n\n` gives the chunker an explicit paragraph boundary at every page break so its structural tier-fallback splitter has something to grip when semantic chunking falls back. Earlier versions joined with `\f` which the chunker ignored, collapsing multi-page PDFs into a single oversized chunk.

`chunkMarkdownDocument()` is **async** — generic sections without explicit `###` subheadings route through the semantic chunker (`semantic-chunker.ts`), which embeds every sentence and splits at topic-coherent boundaries via 75th-percentile cosine-distance jumps. Pattern documents (`## N. Pattern Name`) stay structural. See [knowledge.md § Chunking Strategy](./knowledge.md#chunking-strategy) for the full routing rules.

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
- **Per-row size cap:** rows longer than `CSV_MAX_ROW_CHARS` (32,000 chars,
  ≈ 8,000 tokens) are dropped before embedding because every embedding
  provider rejects oversized inputs. The skipped row numbers are surfaced
  on the document's `metadata.warnings`. Realistic rows are well under this
  — anything over almost always means a binary blob or JSON payload was
  stuffed into one cell.
- **Re-chunking:** `rechunkDocument` detects `metadata.format === 'csv'` and
  routes through `chunkCsvDocument` (not the markdown chunker). The
  per-row sections are persisted verbatim at upload time on
  `metadata.csvSections` and read back directly on rechunk, so any RFC-4180
  quoted cell containing an embedded newline survives intact (a previous
  implementation round-tripped through `rawContent.split('\n')` and would
  have shredded such rows). CSV documents without `csvSections` (legacy or
  externally-modified rows) raise a clear error pointing the admin at
  re-upload rather than producing corrupted chunks.
- **No preview step:** CSVs are deterministic to parse and skip the PDF-style
  preview/confirm flow.

## Dependencies

| Package     | Version | Used by     |
| ----------- | ------- | ----------- |
| `mammoth`   | ^1.12   | DOCX parser |
| `epub2`     | ^3.0    | EPUB parser |
| `pdf-parse` | ^2.4    | PDF parser  |

CSV parsing is in-house (no third-party dependency).
