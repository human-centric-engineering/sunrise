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
        <FieldHelp title="Upload a document">
          Plain text and Markdown files work best because they can be cleanly split into searchable
          chunks. PDFs and Word documents aren&apos;t supported yet because their formatting makes
          reliable text extraction difficult. Maximum size: 10 MB per file.
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
