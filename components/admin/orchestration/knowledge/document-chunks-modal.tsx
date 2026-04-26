'use client';

import { useCallback, useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import { z } from 'zod';

import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { API } from '@/lib/api/endpoints';

const chunksResponseSchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      chunks: z.array(
        z.object({
          id: z.string(),
          content: z.string(),
          chunkType: z.string(),
          patternNumber: z.number().nullable(),
          patternName: z.string().nullable(),
          section: z.string().nullable(),
          category: z.string().nullable(),
          keywords: z.string().nullable(),
          estimatedTokens: z.number(),
        })
      ),
    })
    .optional(),
});

interface ChunkData {
  id: string;
  content: string;
  chunkType: string;
  patternNumber: number | null;
  patternName: string | null;
  section: string | null;
  category: string | null;
  keywords: string | null;
  estimatedTokens: number;
}

interface DocumentChunksModalProps {
  documentId: string | null;
  documentName: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DocumentChunksModal({
  documentId,
  documentName,
  open,
  onOpenChange,
}: DocumentChunksModalProps) {
  const [chunks, setChunks] = useState<ChunkData[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchChunks = useCallback(async () => {
    if (!documentId) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.knowledgeDocumentChunks(documentId));
      if (!res.ok) {
        throw new Error(`Failed to load chunks (${res.status})`);
      }
      const body = chunksResponseSchema.parse(await res.json());
      setChunks(body.data?.chunks ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load chunks');
    } finally {
      setLoading(false);
    }
  }, [documentId]);

  useEffect(() => {
    if (open && documentId) {
      void fetchChunks();
    }
    if (!open) {
      setChunks([]);
      setError(null);
    }
  }, [open, documentId, fetchChunks]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            {documentName ?? 'Document'} — Chunks
          </DialogTitle>
          <DialogDescription>
            {chunks.length > 0
              ? `${chunks.length} chunk${chunks.length === 1 ? '' : 's'}`
              : 'Loading...'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {loading && (
            <p className="text-muted-foreground py-8 text-center text-sm">Loading chunks...</p>
          )}

          {error && <p className="text-destructive text-sm">{error}</p>}

          {!loading &&
            !error &&
            chunks.map((chunk, i) => (
              <div key={chunk.id} className="space-y-1.5 rounded-md border p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted-foreground text-xs font-medium">#{i + 1}</span>
                    <Badge variant="outline" className="text-xs">
                      {chunk.chunkType.replace(/_/g, ' ')}
                    </Badge>
                    {chunk.category && (
                      <Badge variant="secondary" className="text-xs">
                        {chunk.category}
                      </Badge>
                    )}
                    {chunk.section && (
                      <span className="text-muted-foreground text-xs">{chunk.section}</span>
                    )}
                  </div>
                  <span className="text-muted-foreground text-xs">
                    ~{chunk.estimatedTokens} tokens
                  </span>
                </div>
                <pre className="bg-muted/50 max-h-40 overflow-y-auto rounded p-2 text-xs whitespace-pre-wrap">
                  {chunk.content}
                </pre>
                {chunk.keywords && (
                  <div className="flex flex-wrap gap-1">
                    {chunk.keywords.split(',').map((kw) => (
                      <Badge key={kw.trim()} variant="outline" className="text-[10px]">
                        {kw.trim()}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            ))}

          {!loading && !error && chunks.length === 0 && (
            <p className="text-muted-foreground py-8 text-center text-sm">
              No chunks found for this document.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
