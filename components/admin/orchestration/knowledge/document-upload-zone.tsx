'use client';

import { useCallback, useRef, useState } from 'react';
import { Upload } from 'lucide-react';

import { FieldHelp } from '@/components/ui/field-help';
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
  const inputRef = useRef<HTMLInputElement>(null);

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

  const uploadFile = useCallback(
    async (file: File) => {
      const validationError = validateFile(file);
      if (validationError) {
        setError(validationError);
        return;
      }

      setError(null);
      setUploading(true);

      try {
        const formData = new FormData();
        formData.append('file', file);

        const res = await fetch(API.ADMIN.ORCHESTRATION.KNOWLEDGE_DOCUMENTS, {
          method: 'POST',
          body: formData,
        });

        if (!res.ok) {
          const body: unknown = await res.json().catch(() => null);
          const parsed = body as { error?: { message?: string } } | null;
          throw new Error(parsed?.error?.message ?? 'Upload failed');
        }

        onUploadComplete();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Upload failed');
      } finally {
        setUploading(false);
      }
    },
    [validateFile, onUploadComplete]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) void uploadFile(file);
    },
    [uploadFile]
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void uploadFile(file);
      if (inputRef.current) inputRef.current.value = '';
    },
    [uploadFile]
  );

  return (
    <div className="space-y-2">
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

          <p className="text-foreground mt-3 font-medium">How to structure your documents</p>
          <p>
            <strong>Headings matter.</strong> The chunker uses ## and ### headings as natural split
            points. A document with clear headings produces cleaner, more targeted chunks than a
            wall of text. Think of each heading as a label that tells the AI what that section is
            about.
          </p>
          <p className="mt-1">
            <strong>Optional metadata.</strong> You can add HTML comments to tag sections with
            category and keywords that improve search:{' '}
            <code className="text-xs">
              {'<!-- metadata: category=sales, keywords="pricing,discounts" -->'}
            </code>
          </p>
          <p className="mt-1">
            Plain text without any formatting works too — the system will split on paragraph breaks
            instead. You don&apos;t need to add structure, but it helps.
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

          <p className="text-foreground mt-3 font-medium">
            Organising different types of knowledge
          </p>
          <p>
            Currently all documents share a single knowledge base — there&apos;s no way to create
            separate bases for different topics. However, you can use <strong>metadata tags</strong>{' '}
            (category and keywords in HTML comments) to label documents by type, and the search
            system will use those tags to return more relevant results. For example, tag sales docs
            with <code className="text-xs">{'<!-- metadata: category=sales -->'}</code> and
            engineering docs with{' '}
            <code className="text-xs">{'<!-- metadata: category=engineering -->'}</code>.
          </p>

          <p className="text-foreground mt-3 font-medium">Supported formats</p>
          <p>
            <strong>.md, .markdown, .txt</strong> only. PDFs and Word documents aren&apos;t
            supported yet because their formatting makes reliable text extraction difficult. Maximum
            size: 10 MB per file.
          </p>
        </FieldHelp>
      </div>

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
        } ${uploading ? 'pointer-events-none opacity-50' : ''}`}
      >
        <Upload className="text-muted-foreground mb-2 h-8 w-8" />
        <p className="text-sm font-medium">
          {uploading ? 'Uploading...' : 'Drop a file here or click to browse'}
        </p>
        <p className="text-muted-foreground mt-1 text-xs">.md, .markdown, .txt — up to 10 MB</p>
      </div>

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
