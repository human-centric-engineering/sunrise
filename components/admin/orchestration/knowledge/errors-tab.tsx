'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { z } from 'zod';

import { API } from '@/lib/api/endpoints';

const knowledgeDocumentSchema = z.object({
  id: z.string(),
  name: z.string(),
  fileName: z.string(),
  fileHash: z.string(),
  chunkCount: z.number(),
  status: z.string(),
  scope: z.string(),
  category: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  errorMessage: z.string().nullable(),
  metadata: z.unknown().nullable(),
  uploadedBy: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

const apiResponseSchema = z.object({
  success: z.boolean(),
  data: z.array(knowledgeDocumentSchema).optional(),
  error: z.object({ message: z.string().optional() }).optional(),
});

type KnowledgeDocument = z.infer<typeof knowledgeDocumentSchema>;

interface ErrorsTabProps {
  scope?: string;
}

export function ErrorsTab({ scope }: ErrorsTabProps) {
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeDocument | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchFailed = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ status: 'failed' });
      if (scope) params.set('scope', scope);
      const res = await fetch(
        `${API.ADMIN.ORCHESTRATION.KNOWLEDGE_DOCUMENTS}?${params.toString()}`
      );
      if (!res.ok) return;
      const body = apiResponseSchema.parse(await res.json());
      if (body.success && body.data) {
        setDocuments(body.data);
      }
    } catch {
      // Silently ignore — will show empty state
    } finally {
      setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    void fetchFailed();
  }, [fetchFailed]);

  const handleRetry = useCallback(async (docId: string) => {
    setRetryingId(docId);
    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.knowledgeDocumentRetry(docId), {
        method: 'POST',
      });
      if (res.ok) {
        // Remove from list — it's no longer failed
        setDocuments((prev) => prev.filter((d) => d.id !== docId));
      }
    } finally {
      setRetryingId(null);
    }
  }, []);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.knowledgeDocumentById(deleteTarget.id), {
        method: 'DELETE',
      });
      if (res.ok) {
        setDocuments((prev) => prev.filter((d) => d.id !== deleteTarget.id));
      }
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  }, [deleteTarget]);

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="bg-muted/30 h-24 animate-pulse rounded-lg border" />
        ))}
      </div>
    );
  }

  if (documents.length === 0) {
    return (
      <div className="text-muted-foreground rounded-lg border border-dashed p-12 text-center">
        <CheckCircle className="mx-auto mb-3 h-10 w-10 opacity-40" />
        <p className="text-sm font-medium">No failed documents</p>
        <p className="mt-1 text-xs">All documents processed successfully.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">
          {documents.length} document{documents.length !== 1 ? 's' : ''} failed during processing
        </p>
        <Button variant="outline" size="sm" onClick={() => void fetchFailed()}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>

      <div className="space-y-3">
        {documents.map((doc) => (
          <div key={doc.id} className="rounded-lg border p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="text-destructive h-4 w-4 shrink-0" />
                  <span className="truncate text-sm font-medium">{doc.name}</span>
                  <Badge variant="outline" className="shrink-0 text-xs">
                    {doc.fileName.split('.').pop()?.toUpperCase() ?? 'FILE'}
                  </Badge>
                </div>
                {doc.errorMessage && (
                  <div className="bg-destructive/5 border-destructive/20 rounded border p-3">
                    <code className="text-destructive font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
                      {doc.errorMessage}
                    </code>
                  </div>
                )}
                <p className="text-muted-foreground text-xs">
                  Uploaded {new Date(doc.createdAt).toLocaleDateString()}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={retryingId === doc.id}
                  onClick={() => void handleRetry(doc.id)}
                >
                  <RotateCcw
                    className={`mr-1.5 h-3.5 w-3.5 ${retryingId === doc.id ? 'animate-spin' : ''}`}
                  />
                  Retry
                </Button>
                <Button variant="destructive" size="sm" onClick={() => setDeleteTarget(doc)}>
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                  Delete
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Delete confirmation modal */}
      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete document?</DialogTitle>
            <DialogDescription>
              This will permanently delete <strong>{deleteTarget?.name}</strong> and any partial
              chunks or embeddings. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button variant="destructive" disabled={deleting} onClick={() => void handleDelete()}>
              {deleting ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
