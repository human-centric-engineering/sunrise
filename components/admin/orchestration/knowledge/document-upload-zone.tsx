'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, Globe, Loader2, Upload, X } from 'lucide-react';

import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { API } from '@/lib/api/endpoints';

const categoriesResponseSchema = z.object({
  data: z
    .object({ app: z.object({ categories: z.array(z.object({ value: z.string() })) }).optional() })
    .optional(),
});

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
const ALLOWED_EXTENSIONS = ['.md', '.markdown', '.txt', '.epub', '.docx', '.pdf'];

/** PDF preview data returned when a PDF upload requires confirmation. */
export interface PdfPreviewData {
  document: { id: string; name: string; fileName: string; status: string };
  preview: {
    extractedText: string;
    title: string | null;
    author: string | null;
    sectionCount: number;
    warnings: string[];
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
  const [category, setCategory] = useState('');
  const [existingCategories, setExistingCategories] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const categoryRef = useRef<HTMLDivElement>(null);

  // Fetch existing categories for suggestions
  useEffect(() => {
    async function fetchCategories() {
      try {
        const res = await fetch(API.ADMIN.ORCHESTRATION.KNOWLEDGE_META_TAGS);
        if (!res.ok) return;
        const body = categoriesResponseSchema.parse(await res.json());
        if (body.data?.app?.categories) {
          setExistingCategories(body.data.app.categories.map((c) => c.value));
        }
      } catch {
        // Supplementary — ignore failures
      }
    }
    void fetchCategories();
  }, []);

  // Close suggestions on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (categoryRef.current && !categoryRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
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
        if (category.trim()) {
          formData.append('category', category.trim());
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
          setCategory('');
          onPdfPreview({
            document: responseBody.data.document,
            preview: responseBody.data.preview,
          });
          return;
        }

        setStagedFiles([]);
        setCategory('');
        onUploadComplete();
        return;
      }

      // Multiple files — use bulk endpoint
      const formData = new FormData();
      for (const file of stagedFiles) {
        formData.append('files', file);
      }
      if (category.trim()) {
        formData.append('category', category.trim());
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
      setCategory('');
      onUploadComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }, [stagedFiles, category, onUploadComplete, onPdfPreview]);

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

  const filteredSuggestions = existingCategories.filter(
    (c) =>
      c.toLowerCase().includes(category.toLowerCase()) && c.toLowerCase() !== category.toLowerCase()
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1">
        <span className="text-sm font-medium">Upload Document</span>
        <FieldHelp
          title="Uploading documents to the knowledge base"
          contentClassName="w-[28rem] max-h-96 overflow-y-auto"
        >
          <p className="text-foreground font-medium">What happens when you upload</p>
          <p>
            Your document is <strong>chunked</strong> — split into smaller pieces of a few
            paragraphs each (roughly 200–3,200 characters). The system splits on headings first (##
            then ###), then by paragraph breaks. Each chunk is then <strong>embedded</strong> —
            converted into a numerical vector that captures its meaning. When a user asks a
            question, the system finds the chunks whose meaning is closest and feeds them to the AI.
          </p>

          <p className="text-foreground mt-3 font-medium">Category</p>
          <p>
            Assign a <strong>category</strong> when you upload to organise your knowledge.
            Categories let you filter documents and — more importantly — let agents be scoped to
            only search specific categories. For example, a sales agent can be restricted to
            &quot;sales&quot; knowledge only.
          </p>
          <p className="mt-1">
            You can also set category inside the document itself using an HTML comment:{' '}
            <code className="text-xs">{'<!-- metadata: category=sales -->'}</code>. If you set a
            category both here and inside the document, the one you type here takes priority.
          </p>

          <p className="text-foreground mt-3 font-medium">How to structure your documents</p>
          <p>
            <strong>Headings matter.</strong> The chunker uses ## and ### headings as natural split
            points. A document with clear headings produces cleaner, more targeted chunks than a
            wall of text. Think of each heading as a label that tells the AI what that section is
            about.
          </p>

          <p className="text-foreground mt-3 font-medium">In-document metadata tags</p>
          <p>
            You can embed metadata tags anywhere in a document using HTML comments. These are
            invisible in rendered markdown but the system reads them during chunking.
          </p>
          <p className="mt-1 text-xs">
            <strong>Format:</strong>{' '}
            <code>{'<!-- metadata: key=value, key2="value with commas" -->'}</code>
          </p>
          <p className="mt-1 text-xs">
            <strong>Supported tags:</strong>
          </p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-xs">
            <li>
              <strong>category</strong> — groups content by topic (e.g. sales, engineering,
              onboarding). Applied to every chunk in the section.
            </li>
            <li>
              <strong>keywords</strong> — comma-separated terms that boost search relevance. Wrap in
              quotes if the value contains commas: <code>{'keywords="retry,backoff,timeout"'}</code>
            </li>
          </ul>
          <p className="mt-2 text-xs">
            You can place metadata at the top of the document (applies globally) or before any
            section heading (applies to that section only). Section-level tags override
            document-level ones.
          </p>

          <p className="text-foreground mt-3 font-medium">
            Being free-form with meta-tags: flexibility vs. findability
          </p>
          <p>
            Tags are <strong>completely free-form</strong> — there is no fixed list and you can use
            any values you like. This is powerful but comes with a trade-off:
          </p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-xs">
            <li>
              <strong>Inconsistent naming hurts search.</strong> If some documents use
              &quot;sales&quot; and others use &quot;Sales&quot;, &quot;selling&quot;, or
              &quot;revenue&quot;, filtering by category becomes unreliable. The system treats these
              as different values.
            </li>
            <li>
              <strong>Too many unique tags = no tags.</strong> If every document has a unique
              category, you lose the ability to meaningfully filter. Categories work best with a
              small, consistent vocabulary (5–15 values).
            </li>
            <li>
              <strong>Keywords are more forgiving.</strong> Because keyword search is additive (more
              keywords = more ways to find the content), inconsistency there matters less than with
              categories. Use keywords liberally.
            </li>
          </ul>
          <p className="mt-2 text-xs">
            <strong>Recommendation:</strong> agree on a short list of categories before bulk
            uploading. Check the &quot;Meta-tags in use&quot; panel to see what values already
            exist.
          </p>

          <p className="text-foreground mt-3 font-medium">Content quality tips</p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-xs">
            <li>
              <strong>Typos and grammar</strong> — minor typos won&apos;t break search because
              embedding models understand meaning, not exact spelling. But significant errors (wrong
              terminology, garbled sentences) will reduce quality. A quick proofread is worthwhile.
            </li>
            <li>
              <strong>Video/meeting transcripts</strong> — raw transcripts are noisy (filler words,
              repetition, speaker labels). They work, but you&apos;ll get much better results if you
              clean them up first: remove filler, merge fragmented sentences, and add topic
              headings. Even a rough edit makes a big difference.
            </li>
            <li>
              <strong>Short snippets</strong> (a paragraph or two) — absolutely fine to upload.
              Short documents become one or two chunks and are searchable just like larger ones.
              Good for capturing individual ideas, policies, or decisions.
            </li>
          </ul>

          <p className="text-foreground mt-3 font-medium">Large documents and books</p>
          <p>
            <strong>Chapter by chapter is better than one huge file.</strong> While a whole book
            under 10 MB will technically upload, splitting by chapter gives you cleaner chunks (each
            chapter gets its own heading hierarchy), easier management (you can update or remove
            individual chapters), and better search results (the AI finds the right chapter rather
            than a random mid-book paragraph).
          </p>

          <p className="text-foreground mt-3 font-medium">Supported formats</p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-xs">
            <li>
              <strong>.md, .markdown, .txt</strong> — text files, chunked immediately
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
        </FieldHelp>
      </div>

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
            .md, .txt, .epub, .docx, .pdf — up to 50 MB, max 10 files
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

          <div ref={categoryRef} className="relative space-y-1">
            <div className="flex items-center gap-1">
              <label htmlFor="upload-category" className="text-xs font-medium">
                Category
              </label>
              <span className="text-muted-foreground text-xs">(optional)</span>
              <FieldHelp title="Document category" ariaLabel="What is the document category?">
                <p>
                  Assigns this document to a category so it can be filtered in search and scoped to
                  specific agents. If left blank, the system will look for a{' '}
                  <code className="text-xs">{'<!-- metadata: category=... -->'}</code> comment
                  inside the document.
                </p>
                <p className="mt-2">
                  Use an existing category from the suggestions to keep things consistent, or type a
                  new one. Categories are case-sensitive — &quot;Sales&quot; and &quot;sales&quot;
                  are treated as different values.
                </p>
              </FieldHelp>
            </div>
            <Input
              id="upload-category"
              placeholder="e.g. sales, engineering, onboarding"
              value={category}
              onChange={(e) => {
                setCategory(e.target.value);
                setShowSuggestions(true);
              }}
              onFocus={() => setShowSuggestions(true)}
              disabled={uploading}
              className="h-8 text-sm"
            />
            {showSuggestions && filteredSuggestions.length > 0 && (
              <div className="bg-popover border-border absolute top-full z-10 mt-1 w-full rounded-md border shadow-md">
                {filteredSuggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    className="hover:bg-accent w-full px-3 py-1.5 text-left text-sm"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setCategory(suggestion);
                      setShowSuggestions(false);
                    }}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setStagedFiles([]);
                setCategory('');
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
        accept=".md,.markdown,.txt,.epub,.docx,.pdf"
        multiple
        className="hidden"
        onChange={handleFileChange}
        aria-label="Upload documents"
      />

      {/* Fetch from URL */}
      <FetchFromUrl category={category} onFetchComplete={onUploadComplete} />

      {error && <p className="text-destructive text-sm">{error}</p>}
    </div>
  );
}

// ─── Fetch from URL sub-component ──────────────────────────────────────────

function FetchFromUrl({
  category,
  onFetchComplete,
}: {
  category: string;
  onFetchComplete: () => void;
}): React.ReactElement {
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
          category: category.trim() || undefined,
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
