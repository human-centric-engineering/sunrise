'use client';

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { BookOpen, FileText, Globe, Loader2, Upload, X } from 'lucide-react';

import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { MultiSelect, type MultiSelectOption } from '@/components/ui/multi-select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';

interface TagRow {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
}

/**
 * Mirror of the slug schema in `lib/validations/orchestration.ts`. Used by
 * the inline-create-tag affordance: the operator types a human-readable
 * name, we derive a slug client-side. Server-side validation is still the
 * source of truth — if the derived slug collides we surface the error.
 */
function slugifyTagName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

const errorBodySchema = z
  .object({
    error: z.object({ message: z.string().optional() }).optional(),
  })
  .nullable();

const pdfPreviewDataSchema = z.object({
  document: z.object({
    id: z.string(),
    name: z.string(),
    fileName: z.string(),
    status: z.string(),
  }),
  preview: z.object({
    extractedText: z.string(),
    title: z.string().nullable(),
    author: z.string().nullable(),
    sectionCount: z.number(),
    warnings: z.array(z.string()),
    pages: z
      .array(
        z.object({
          num: z.number(),
          charCount: z.number(),
          hasText: z.boolean(),
        })
      )
      .nullable()
      .optional(),
    requiresConfirmation: z.boolean(),
  }),
});

const uploadResponseSchema = z.object({
  data: z
    .object({
      document: pdfPreviewDataSchema.shape.document.optional(),
      preview: pdfPreviewDataSchema.shape.preview.optional(),
    })
    .optional(),
});

const bulkUploadResponseSchema = z.object({
  data: z
    .object({
      results: z.array(
        z.object({
          fileName: z.string(),
          status: z.string(),
          error: z.string().optional(),
        })
      ),
    })
    .optional(),
});

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const ALLOWED_EXTENSIONS = ['.md', '.markdown', '.txt', '.csv', '.epub', '.docx', '.pdf'];

/** PDF preview data returned when a PDF upload requires confirmation. */
export interface PdfPreviewData {
  document: { id: string; name: string; fileName: string; status: string };
  preview: {
    extractedText: string;
    title: string | null;
    author: string | null;
    sectionCount: number;
    warnings: string[];
    pages?: { num: number; charCount: number; hasText: boolean }[] | null;
    requiresConfirmation: boolean;
  };
}

interface DocumentUploadZoneProps {
  onUploadComplete: () => void;
  onPdfPreview?: (data: PdfPreviewData) => void;
}

export function DocumentUploadZone({ onUploadComplete, onPdfPreview }: DocumentUploadZoneProps) {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stagedFiles, setStagedFiles] = useState<File[]>([]);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [availableTags, setAvailableTags] = useState<TagRow[]>([]);
  const [extractTables, setExtractTables] = useState(false);
  // Operator-supplied display name for the document. Defaults to the file
  // stem so existing behaviour is preserved; only sent to the server when the
  // operator actually edits it.
  const [displayName, setDisplayName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Load the managed tag taxonomy once so the picker can offer it. apiClient
  // unwraps the envelope, so the generic type is the inner data shape.
  useEffect(() => {
    async function fetchTags(): Promise<void> {
      try {
        const tags = await apiClient.get<TagRow[]>(
          `${API.ADMIN.ORCHESTRATION.KNOWLEDGE_TAGS}?limit=100`
        );
        setAvailableTags(Array.isArray(tags) ? tags : []);
      } catch {
        // Supplementary — picker just shows an empty list if this fails.
      }
    }
    void fetchTags();
  }, []);

  const validateFile = useCallback((file: File): string | null => {
    if (file.size > MAX_FILE_SIZE) {
      return `File exceeds 50 MB limit (${(file.size / 1024 / 1024).toFixed(1)} MB)`;
    }
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return `Unsupported file type: ${ext}. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`;
    }
    return null;
  }, []);

  const stageFiles = useCallback(
    (files: File[]) => {
      const errors: string[] = [];
      const valid: File[] = [];
      for (const file of files) {
        const validationError = validateFile(file);
        if (validationError) {
          errors.push(`${file.name}: ${validationError}`);
        } else {
          valid.push(file);
        }
      }
      if (errors.length > 0) {
        setError(errors.join('; '));
      } else {
        setError(null);
      }
      if (valid.length > 0) {
        setStagedFiles((prev) => {
          const existing = new Set(prev.map((f) => f.name));
          const deduped = valid.filter((f) => !existing.has(f.name));
          const combined = [...prev, ...deduped];
          if (combined.length > 10) {
            setError('Maximum 10 files per batch');
            return prev;
          }
          // Seed the display-name input from the first staged file when
          // staging starts empty. The operator can edit before uploading.
          if (prev.length === 0 && combined.length > 0) {
            setDisplayName(combined[0].name.replace(/\.[^.]+$/, ''));
          }
          return combined;
        });
      }
    },
    [validateFile]
  );

  const uploadFiles = useCallback(async () => {
    if (stagedFiles.length === 0) return;

    setError(null);
    setUploading(true);

    try {
      // Single file — use original endpoint (supports PDF preview flow)
      if (stagedFiles.length === 1) {
        const formData = new FormData();
        formData.append('file', stagedFiles[0]);
        // FormData supports repeated keys; the server collects via getAll('tagIds').
        for (const tagId of tagIds) {
          formData.append('tagIds', tagId);
        }
        // Only send `name` when the operator actually edited it — empty or
        // unchanged means the server falls back to the filename-derived name.
        const trimmedName = displayName.trim();
        const filenameDefault = stagedFiles[0].name.replace(/\.[^.]+$/, '');
        if (trimmedName && trimmedName !== filenameDefault) {
          formData.append('name', trimmedName);
        }
        const isPdf = stagedFiles[0].name.toLowerCase().endsWith('.pdf');
        if (isPdf && extractTables) {
          formData.append('extractTables', 'true');
        }

        const res = await fetch(API.ADMIN.ORCHESTRATION.KNOWLEDGE_DOCUMENTS, {
          method: 'POST',
          body: formData,
        });

        if (!res.ok) {
          const raw = errorBodySchema.safeParse(await res.json().catch(() => null));
          throw new Error((raw.success ? raw.data?.error?.message : null) ?? 'Upload failed');
        }

        const responseBody = uploadResponseSchema.parse(await res.json());

        if (
          responseBody.data?.preview?.requiresConfirmation &&
          responseBody.data.document &&
          onPdfPreview
        ) {
          setStagedFiles([]);
          setTagIds([]);
          setDisplayName('');
          onPdfPreview({
            document: responseBody.data.document,
            preview: responseBody.data.preview,
          });
          return;
        }

        setStagedFiles([]);
        setTagIds([]);
        setDisplayName('');
        onUploadComplete();
        return;
      }

      // Multiple files — use bulk endpoint
      const formData = new FormData();
      for (const file of stagedFiles) {
        formData.append('files', file);
      }
      for (const tagId of tagIds) {
        formData.append('tagIds', tagId);
      }

      const res = await fetch(`${API.ADMIN.ORCHESTRATION.KNOWLEDGE_DOCUMENTS}/bulk`, {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const raw = errorBodySchema.safeParse(await res.json().catch(() => null));
        throw new Error((raw.success ? raw.data?.error?.message : null) ?? 'Bulk upload failed');
      }

      const responseBody = bulkUploadResponseSchema.parse(await res.json());

      const results = responseBody.data?.results ?? [];
      const errors = results.filter((r) => r.status === 'error');
      const skippedPdfs = results.filter((r) => r.status === 'skipped_pdf');

      const messages: string[] = [];
      if (errors.length > 0) {
        messages.push(errors.map((e) => `${e.fileName}: ${e.error}`).join('; '));
      }
      if (skippedPdfs.length > 0) {
        messages.push(
          `${skippedPdfs.length} PDF(s) skipped — upload PDFs individually for the preview flow`
        );
      }

      if (messages.length > 0) {
        setError(messages.join('. '));
      }

      setStagedFiles([]);
      setTagIds([]);
      setDisplayName('');
      onUploadComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }, [stagedFiles, tagIds, displayName, extractTables, onUploadComplete, onPdfPreview]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) stageFiles(files);
    },
    [stageFiles]
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length > 0) stageFiles(files);
      if (inputRef.current) inputRef.current.value = '';
    },
    [stageFiles]
  );

  const tagOptions: MultiSelectOption[] = availableTags.map((t) => ({
    value: t.id,
    label: t.name,
    description: t.description ?? t.slug,
  }));

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1">
        <span className="text-sm font-medium">Upload Document</span>
        <FieldHelp
          title="Uploading documents to the knowledge base"
          contentClassName="w-[28rem] max-h-96 overflow-y-auto"
        >
          <UploadGuideBody />
        </FieldHelp>
      </div>

      <UploadExplainer />

      {stagedFiles.length === 0 ? (
        /* Drop zone — file selection */
        <div
          role="button"
          tabIndex={0}
          onDragEnter={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
          }}
          className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors ${
            dragging
              ? 'border-primary bg-primary/5'
              : 'border-muted-foreground/25 hover:border-primary/50'
          }`}
        >
          <Upload className="text-muted-foreground mb-2 h-8 w-8" />
          <p className="text-sm font-medium">Drop files here or click to browse</p>
          <p className="text-muted-foreground mt-1 text-xs">
            .md, .txt, .csv, .epub, .docx, .pdf — up to 50 MB, max 10 files
          </p>
        </div>
      ) : (
        /* Staged files — category + upload */
        <div className="space-y-3 rounded-lg border p-4">
          <div className="space-y-2">
            {stagedFiles.map((file, idx) => (
              <div key={`${file.name}-${idx}`} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FileText className="text-muted-foreground h-4 w-4" />
                  <div>
                    <p className="text-sm font-medium">{file.name}</p>
                    <p className="text-muted-foreground text-xs">
                      {(file.size / 1024).toFixed(1)} KB
                    </p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setStagedFiles((prev) => prev.filter((_, i) => i !== idx));
                    setError(null);
                  }}
                  disabled={uploading}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>

          {stagedFiles.length < 10 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => inputRef.current?.click()}
              disabled={uploading}
              className="w-full"
            >
              Add more files
            </Button>
          )}

          {stagedFiles.length === 1 ? (
            <div className="space-y-1">
              <div className="flex items-center gap-1">
                <label htmlFor="upload-display-name" className="text-xs font-medium">
                  Title
                </label>
                <span className="text-muted-foreground text-xs">(optional)</span>
                <FieldHelp title="Document title" ariaLabel="What is the document title?">
                  <p>
                    The display name shown in the document list. Defaults to the filename without
                    its extension — edit if you want something more readable.
                  </p>
                  <p className="mt-2">
                    Doesn&apos;t affect search; it&apos;s purely for browsing in the admin and the
                    citation panels that surface document names.
                  </p>
                </FieldHelp>
              </div>
              <Input
                id="upload-display-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={stagedFiles[0].name.replace(/\.[^.]+$/, '')}
                disabled={uploading}
                className="h-8 text-sm"
              />
            </div>
          ) : null}

          <div className="space-y-1">
            <div className="flex items-center gap-1">
              <span id="upload-tags-label" className="text-xs font-medium">
                Tags
              </span>
              <span className="text-muted-foreground text-xs">(optional)</span>
              <FieldHelp title="Document tags" ariaLabel="What are document tags?">
                <p>
                  Tags scope which agents can search this document. When an agent runs in{' '}
                  <em>Restricted</em> knowledge mode, granting it a tag gives it access to every
                  document carrying that tag.
                </p>
                <p className="mt-2">
                  Pick from existing tags, or type a name that doesn&apos;t match anything to create
                  a new one inline. Full tag admin lives under <em>Knowledge → Tags</em>.
                </p>
                <p className="mt-2">
                  Tags control <em>which</em> docs an agent can search. To improve <em>how</em> a
                  doc ranks for a query, see <em>Indexed keywords</em> on the Manage tab —
                  that&apos;s a separate concept.
                </p>
              </FieldHelp>
            </div>
            <MultiSelect
              value={tagIds}
              onChange={setTagIds}
              options={tagOptions}
              placeholder={
                availableTags.length === 0 ? 'No tags yet — type to create one' : 'No tags applied'
              }
              emptyText="No matching tags. Type a new name to create one."
              disabled={uploading}
              ariaLabelledBy="upload-tags-label"
              createSupportsDescription
              onCreate={async (name, description) => {
                const created = await apiClient.post<TagRow>(
                  API.ADMIN.ORCHESTRATION.KNOWLEDGE_TAGS,
                  {
                    body: {
                      slug: slugifyTagName(name),
                      name,
                      ...(description ? { description } : {}),
                    },
                  }
                );
                // Refresh availableTags so the new row appears in subsequent renders.
                setAvailableTags((prev) =>
                  prev.some((t) => t.id === created.id) ? prev : [...prev, created]
                );
                return {
                  value: created.id,
                  label: created.name,
                  description: created.description ?? created.slug,
                };
              }}
            />
          </div>

          {stagedFiles.length === 1 && stagedFiles[0].name.toLowerCase().endsWith('.pdf') && (
            <div className="flex items-start gap-2">
              <input
                id="extract-tables"
                type="checkbox"
                className="border-border mt-1 h-4 w-4 rounded"
                checked={extractTables}
                onChange={(e) => setExtractTables(e.target.checked)}
                disabled={uploading}
              />
              <div className="flex-1">
                <div className="flex items-center gap-1">
                  <label htmlFor="extract-tables" className="text-xs font-medium">
                    Extract tables (experimental)
                  </label>
                  <FieldHelp
                    title="PDF table extraction"
                    ariaLabel="What does table extraction do?"
                  >
                    <p>
                      Tries to recognise tables on each PDF page and pull them out as readable rows
                      and columns. Useful when a PDF contains price lists, comparison tables, or any
                      structured data that the AI would otherwise see as jumbled lines of text.
                    </p>
                    <p className="mt-2">
                      <strong>When it works well:</strong> PDFs with clear ruled tables — invoices,
                      financial reports, product specifications, lender criteria sheets.
                    </p>
                    <p className="mt-2">
                      <strong>When it can misfire:</strong> PDFs that use lines for decoration
                      (boxes around quotes, separators between sections, charts with axes) — the
                      system might find &quot;tables&quot; that aren&apos;t really tables. Anything
                      it pulls out appears in the preview text below, so you can delete the wrong
                      bits before confirming.
                    </p>
                    <p className="mt-2">
                      <strong>Why it&apos;s off by default:</strong> turning this on changes the
                      extracted text. If you&apos;ve already uploaded similar PDFs without it,
                      mixing both could make search results uneven across your knowledge base.
                    </p>
                  </FieldHelp>
                </div>
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setStagedFiles([]);
                setTagIds([]);
                setDisplayName('');
                setExtractTables(false);
                setError(null);
              }}
              disabled={uploading}
            >
              Clear all
            </Button>
            <Button
              onClick={() => void uploadFiles()}
              disabled={uploading}
              size="sm"
              className="flex-1"
            >
              {uploading
                ? 'Uploading...'
                : `Upload ${stagedFiles.length === 1 ? '' : `${stagedFiles.length} files`}`}
            </Button>
          </div>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept=".md,.markdown,.txt,.csv,.epub,.docx,.pdf"
        multiple
        className="hidden"
        onChange={handleFileChange}
        aria-label="Upload documents"
      />

      {/* Fetch from URL */}
      <FetchFromUrl tagIds={tagIds} onFetchComplete={onUploadComplete} />

      {error && <p className="text-destructive text-sm">{error}</p>}
    </div>
  );
}

// ─── Fetch from URL sub-component ──────────────────────────────────────────

function FetchFromUrl({
  tagIds,
  onFetchComplete,
}: {
  tagIds: string[];
  onFetchComplete: () => void;
}): ReactElement {
  const [url, setUrl] = useState('');
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  async function handleFetch(): Promise<void> {
    if (!url.trim()) return;
    setFetching(true);
    setFetchError(null);
    try {
      const res = await fetch(`${API.ADMIN.ORCHESTRATION.KNOWLEDGE_DOCUMENTS}/fetch-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: url.trim(),
          ...(tagIds.length > 0 ? { tagIds } : {}),
        }),
      });
      if (!res.ok) {
        const raw = errorBodySchema.safeParse(await res.json().catch(() => null));
        throw new Error(
          (raw.success ? raw.data?.error?.message : null) ?? `Fetch failed (HTTP ${res.status})`
        );
      }
      setUrl('');
      onFetchComplete();
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'Fetch failed');
    } finally {
      setFetching(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1">
        <Globe className="text-muted-foreground h-3.5 w-3.5" />
        <span className="text-xs font-medium">Fetch from URL</span>
      </div>
      <div className="flex gap-2">
        <Input
          type="url"
          placeholder="https://example.com/document.md"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={fetching}
          className="h-8 text-sm"
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleFetch();
          }}
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() => void handleFetch()}
          disabled={fetching || !url.trim()}
        >
          {fetching ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
          {fetching ? 'Fetching...' : 'Fetch'}
        </Button>
      </div>
      {fetchError && <p className="text-destructive text-xs">{fetchError}</p>}
    </div>
  );
}

/**
 * Inline summary above the drop zone — gives users a one-glance overview of
 * what happens to a document on upload, with a "Read full guide" link that
 * opens a popover containing the same body the (i) FieldHelp on the
 * "Upload Document" header shows. Two surfaces, one source of truth.
 */
function UploadExplainer(): ReactElement {
  return (
    <div className="bg-muted/40 border-border/60 rounded-md border p-3">
      <div className="flex items-start gap-2 text-xs leading-relaxed">
        <BookOpen
          className="text-muted-foreground mt-0.5 h-3.5 w-3.5 shrink-0"
          aria-hidden="true"
        />
        <div className="flex-1 space-y-1.5">
          <p>
            <strong className="text-foreground">How upload works.</strong> Your document is parsed
            (PDF / DOCX / EPUB / CSV / MD / TXT supported), split into <strong>chunks</strong> of
            ~50–800 tokens each, and every chunk is embedded into a 1,536-dimension vector for
            search. The graph view shows one node per chunk linked to its document.
          </p>
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="text-primary text-xs font-medium underline-offset-2 hover:underline"
              >
                Read full guide
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              className="text-muted-foreground max-h-96 w-[28rem] overflow-y-auto text-sm leading-relaxed"
            >
              <div className="text-foreground mb-1 font-semibold">
                Uploading documents to the knowledge base
              </div>
              <div className="space-y-1">
                <UploadGuideBody />
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </div>
  );
}

/**
 * Shared body for the Upload Document explainer. Rendered inside both the
 * (i) FieldHelp on the section header and the "Read full guide" popover
 * triggered from the inline `<UploadExplainer />`. Keeping a single source
 * of truth means future edits land in one place.
 */
function UploadGuideBody(): ReactElement {
  return (
    <>
      <p className="text-foreground font-medium">What happens when you upload</p>
      <p>
        Your document is <strong>split into smaller pieces</strong> the AI can search through. How
        the split works depends on the format:
      </p>
      <ul className="mt-1 list-disc space-y-1 pl-4 text-xs">
        <li>
          <strong>Text files (.md / .txt) and Word / EPUB</strong> — the system splits on headings
          (## then ###) so each piece is a few paragraphs (roughly 200–3,200 characters).
        </li>
        <li>
          <strong>CSV / spreadsheets</strong> — each row becomes its own searchable piece, so the AI
          can find a single line item (one supplier, one transaction, one record) rather than a
          blurred mix of nearby rows.
        </li>
        <li>
          <strong>PDFs</strong> — extracted text is shown for you to review and edit before the AI
          ever sees it. Once confirmed, it&apos;s split the same way as a text file.
        </li>
      </ul>
      <p className="mt-2">
        Each piece is then turned into a numerical fingerprint (an <strong>embedding</strong>) that
        captures its meaning. When someone asks a question, the system finds the pieces whose
        meaning is closest and feeds those to the AI.
      </p>

      <p className="text-foreground mt-3 font-medium">The full pipeline</p>
      <ol className="mt-1 list-decimal space-y-1 pl-4 text-xs">
        <li>
          <strong>Parse</strong> — format-specific parsers convert PDF / DOCX / EPUB / CSV into
          plain text. Markdown and TXT skip this step.
        </li>
        <li>
          <strong>Chunk</strong> — the text is split into pieces sized to land in the{' '}
          <strong>50–800 token</strong> range (≈ 200–3,200 characters). Sections smaller than the
          minimum are merged with neighbours; oversized sections are split on paragraph boundaries.
          Code blocks and Mermaid diagrams are stripped first so they don&apos;t bloat the
          embeddings.
        </li>
        <li>
          <strong>Embed</strong> — each chunk&apos;s text is sent to your configured embedding
          provider in batches of 100. The returned <strong>1,536-dimension vector</strong> is stored
          alongside the text so vector search can find semantically similar chunks at query time.
        </li>
      </ol>

      <p className="text-foreground mt-3 font-medium">What you&apos;ll see in the graph</p>
      <p>
        The Visualize tab renders the result as a hierarchy: one <strong>Knowledge Base</strong>{' '}
        node, one <strong>Document</strong> node per upload (green / amber / red by status), and one{' '}
        <strong>Chunk</strong> node per chunk row — each chunk node represents one embedding.
      </p>
      <ul className="mt-1 list-disc space-y-1 pl-4 text-xs">
        <li>
          <strong>Edges from KB → document</strong> are labelled{' '}
          <code>contains (N&nbsp;chunks)</code>.
        </li>
        <li>
          <strong>Edges from document → chunk</strong> describe the chunk&apos;s role —{' '}
          <code>overview</code>, <code>section: &lt;heading&gt;</code>, <code>glossary</code>,{' '}
          <code>csv row</code>, etc. — derived from the chunk type the chunker assigned.
        </li>
        <li>
          <strong>Chunk node size</strong> reflects token count — larger chunks render slightly
          bigger (capped at 25&nbsp;px).
        </li>
      </ul>
      <p className="mt-2 text-xs">
        Rough sizing examples: a 5-page article (~5k tokens) produces 10–20 chunks; a README-sized
        doc 20–40; a 100-page PDF 100–200; a 500-page book 500–1,000.
      </p>
      <p className="mt-2 text-xs">
        <strong>500-chunk threshold:</strong> if the total chunk count across all documents in the
        current view crosses 500, individual chunk nodes are hidden and the graph collapses to KB +
        documents only (for performance). The aggregation note at the bottom of the chart tells you
        when this happens. Switch to the <strong>Embedded</strong> view to filter to chunks that
        actually have vectors stored.
      </p>

      <p className="text-foreground mt-3 font-medium">Tags</p>
      <p>
        Apply one or more <strong>tags</strong> when you upload. Tags are the access-control
        taxonomy: an agent running in <em>Restricted</em> knowledge mode can search a document only
        if it carries one of the tags granted to that agent. Tags also help with browsing and
        filtering, but their primary job is scoping — &quot;which agents can see this&quot;.
      </p>
      <p className="mt-1">
        Manage the tag list under <em>Knowledge → Tags</em>. You can also create a new tag inline
        from the Tags picker on this upload form by typing a name that doesn&apos;t match an
        existing one — a &quot;Create &lsquo;…&rsquo;&quot; row appears.
      </p>

      <p className="text-foreground mt-3 font-medium">Indexed Keywords</p>
      <p>
        Separate from tags, the system also indexes per-chunk <strong>keywords</strong> that feed
        the BM25 component of hybrid search. Keywords affect <em>how</em> a chunk ranks for a query;
        they never affect <em>who</em> can see it (tags do that).
      </p>
      <p className="mt-1">Keywords currently come from one of two sources:</p>
      <ul className="mt-1 list-disc space-y-1 pl-4 text-xs">
        <li>
          <strong>Metadata comments</strong> inside markdown documents (see below).
        </li>
        <li>
          <strong>The Enrich Keywords action</strong> on the document table — runs an LLM over each
          chunk and writes 3–8 keyword phrases. Use this when an uploaded doc doesn&apos;t rank well
          for queries whose vocabulary doesn&apos;t literally appear in the content.
        </li>
      </ul>
      <p className="mt-1 text-xs">
        Most uploads have NULL keywords. That&apos;s fine — BM25 still indexes the chunk content
        itself. Keywords are a precision dial, not a foundational signal.
      </p>

      <p className="text-foreground mt-3 font-medium">How to structure your documents</p>
      <p>
        <strong>Headings matter</strong> for text and Word documents. The system uses ## and ###
        headings as natural split points, so a document with clear headings produces cleaner, more
        targeted pieces than a wall of text. Think of each heading as a label that tells the AI what
        that section is about.
      </p>
      <p className="mt-2">
        <strong>CSVs:</strong> the first row should be your column headers (Name, Date, Amount,
        etc.). The system reads them and prepends them to each row when storing it, so a search for
        &quot;payments to Acme in March&quot; can match the right row even if the AI never sees the
        spreadsheet as a whole. Comma, tab, and semicolon separators are all detected automatically.
      </p>
      <p className="mt-2">
        <strong>PDFs:</strong> the system extracts the text and shows it to you for review before
        any chunking happens. You can correct OCR mistakes, delete unwanted sections, or paste in
        cleaner text from elsewhere. If pages 4–7 of a 22-page PDF were scanned images, you&apos;ll
        see a warning naming those exact pages so you know what to fix.
      </p>

      <p className="text-foreground mt-3 font-medium">In-document metadata comments</p>
      <p>
        Markdown documents can embed keyword hints anywhere using HTML comments. These are invisible
        in rendered markdown but the system reads them during chunking.
      </p>
      <p className="mt-1 text-xs">
        <strong>Format:</strong>{' '}
        <code>{'<!-- metadata: keywords="retry,backoff,timeout" -->'}</code>
      </p>
      <p className="mt-1 text-xs">
        You can place the comment at the top of the document (applies globally) or before any
        section heading (applies to that section only). Section-level metadata overrides
        document-level. <strong>Only markdown is parsed this way</strong> — DOCX, PDF, EPUB, and CSV
        uploads do not pick up metadata comments; use the <em>Enrich Keywords</em> action on the
        document table after upload instead.
      </p>

      <p className="text-foreground mt-3 font-medium">Content quality tips</p>
      <ul className="mt-1 list-disc space-y-1 pl-4 text-xs">
        <li>
          <strong>Typos and grammar</strong> — minor typos won&apos;t break search because embedding
          models understand meaning, not exact spelling. But significant errors (wrong terminology,
          garbled sentences) will reduce quality. A quick proofread is worthwhile.
        </li>
        <li>
          <strong>Video/meeting transcripts</strong> — raw transcripts are noisy (filler words,
          repetition, speaker labels). They work, but you&apos;ll get much better results if you
          clean them up first: remove filler, merge fragmented sentences, and add topic headings.
          Even a rough edit makes a big difference.
        </li>
        <li>
          <strong>Short snippets</strong> (a paragraph or two) — absolutely fine to upload. Short
          documents become one or two chunks and are searchable just like larger ones. Good for
          capturing individual ideas, policies, or decisions.
        </li>
      </ul>

      <p className="text-foreground mt-3 font-medium">Large documents and books</p>
      <p>
        <strong>Chapter by chapter is better than one huge file.</strong> While a whole book under
        10 MB will technically upload, splitting by chapter gives you cleaner chunks (each chapter
        gets its own heading hierarchy), easier management (you can update or remove individual
        chapters), and better search results (the AI finds the right chapter rather than a random
        mid-book paragraph).
      </p>

      <p className="text-foreground mt-3 font-medium">Supported formats</p>
      <ul className="mt-1 list-disc space-y-1 pl-4 text-xs">
        <li>
          <strong>.md, .markdown, .txt</strong> — text files, chunked immediately
        </li>
        <li>
          <strong>.csv</strong> — RFC 4180 with delimiter sniffing; each row becomes its own chunk
          for row-level retrieval
        </li>
        <li>
          <strong>.epub, .docx</strong> — parsed to text, then chunked automatically
        </li>
        <li>
          <strong>.pdf</strong> — extracted text shown for review before chunking (OCR quality
          varies; you can correct the text before confirming)
        </li>
      </ul>
      <p className="mt-2 text-xs">Maximum size: 50 MB per file.</p>
    </>
  );
}
