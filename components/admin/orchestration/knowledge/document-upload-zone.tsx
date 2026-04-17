'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, Upload, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { API } from '@/lib/api/endpoints';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_EXTENSIONS = ['.md', '.markdown', '.txt'];

interface DocumentUploadZoneProps {
  onUploadComplete: () => void;
}

export function DocumentUploadZone({ onUploadComplete }: DocumentUploadZoneProps) {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stagedFile, setStagedFile] = useState<File | null>(null);
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
        const body = (await res.json()) as {
          data?: { app?: { categories: Array<{ value: string }> } };
        };
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
      return `File exceeds 10 MB limit (${(file.size / 1024 / 1024).toFixed(1)} MB)`;
    }
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return `Unsupported file type: ${ext}. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`;
    }
    return null;
  }, []);

  const stageFile = useCallback(
    (file: File) => {
      const validationError = validateFile(file);
      if (validationError) {
        setError(validationError);
        return;
      }
      setError(null);
      setStagedFile(file);
    },
    [validateFile]
  );

  const uploadFile = useCallback(async () => {
    if (!stagedFile) return;

    setError(null);
    setUploading(true);

    try {
      const formData = new FormData();
      formData.append('file', stagedFile);
      if (category.trim()) {
        formData.append('category', category.trim());
      }

      const res = await fetch(API.ADMIN.ORCHESTRATION.KNOWLEDGE_DOCUMENTS, {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        const parsed = body as { error?: { message?: string } } | null;
        throw new Error(parsed?.error?.message ?? 'Upload failed');
      }

      // Reset state
      setStagedFile(null);
      setCategory('');
      onUploadComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }, [stagedFile, category, onUploadComplete]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) stageFile(file);
    },
    [stageFile]
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) stageFile(file);
      if (inputRef.current) inputRef.current.value = '';
    },
    [stageFile]
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
          <p>
            <strong>.md, .markdown, .txt</strong> only. PDFs and Word documents aren&apos;t
            supported yet because their formatting makes reliable text extraction difficult. Maximum
            size: 10 MB per file.
          </p>
        </FieldHelp>
      </div>

      {!stagedFile ? (
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
          <p className="text-sm font-medium">Drop a file here or click to browse</p>
          <p className="text-muted-foreground mt-1 text-xs">.md, .markdown, .txt — up to 10 MB</p>
        </div>
      ) : (
        /* Staged file — category + upload */
        <div className="space-y-3 rounded-lg border p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FileText className="text-muted-foreground h-5 w-5" />
              <div>
                <p className="text-sm font-medium">{stagedFile.name}</p>
                <p className="text-muted-foreground text-xs">
                  {(stagedFile.size / 1024).toFixed(1)} KB
                </p>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setStagedFile(null);
                setCategory('');
                setError(null);
              }}
              disabled={uploading}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

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

          <Button
            onClick={() => void uploadFile()}
            disabled={uploading}
            size="sm"
            className="w-full"
          >
            {uploading ? 'Uploading...' : 'Upload'}
          </Button>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept=".md,.markdown,.txt"
        className="hidden"
        onChange={handleFileChange}
        aria-label="Upload document"
      />

      {error && <p className="text-destructive text-sm">{error}</p>}
    </div>
  );
}
