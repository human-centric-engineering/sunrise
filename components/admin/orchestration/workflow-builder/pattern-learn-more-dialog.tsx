'use client';

/**
 * PatternLearnMoreDialog — fetches and renders pattern knowledge base
 * content inline without leaving the workflow builder.
 *
 * Reuses `PatternContent` (markdown + Mermaid) and `PatternDetailSections`
 * (collapsible accordions) from the learning area.
 */

import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { PatternContent } from '@/components/admin/orchestration/learn/pattern-content';
import { PatternDetailSections } from '@/components/admin/orchestration/learn/pattern-detail-sections';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import type { AiKnowledgeChunk } from '@/types/orchestration';

interface PatternDetail {
  patternName: string | null;
  chunks: AiKnowledgeChunk[];
  totalTokens: number;
}

const HERO_SECTIONS = new Set(['overview', 'tldr', 'summary']);

function stripEmbeddingPrefix(content: string): string {
  const withDash = content.match(/^.+ — .+\n\n([\s\S]*)$/);
  if (withDash) return withDash[1];
  const plain = content.match(/^[^\n]+\n\n([\s\S]*)$/);
  if (plain) return plain[1];
  return content;
}

export interface PatternLearnMoreDialogProps {
  open: boolean;
  patternNumber: number | null;
  onOpenChange: (open: boolean) => void;
}

export function PatternLearnMoreDialog({
  open,
  patternNumber,
  onOpenChange,
}: PatternLearnMoreDialogProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<PatternDetail | null>(null);

  const fetchPattern = useCallback(async (num: number) => {
    setLoading(true);
    setError(null);
    setDetail(null);
    try {
      const data = await apiClient.get<PatternDetail>(
        API.ADMIN.ORCHESTRATION.knowledgePatternByNumber(num)
      );
      setDetail(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load pattern');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && patternNumber !== null) {
      void fetchPattern(patternNumber);
    }
  }, [open, patternNumber, fetchPattern]);

  const heroChunks =
    detail?.chunks.filter((c) => HERO_SECTIONS.has((c.section ?? '').toLowerCase())) ?? [];
  const restChunks =
    detail?.chunks.filter((c) => !HERO_SECTIONS.has((c.section ?? '').toLowerCase())) ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{detail?.patternName ?? `Pattern #${patternNumber}`}</DialogTitle>
          <DialogDescription>Design pattern reference from the knowledge base.</DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
          </div>
        )}

        {error && (
          <div className="py-8 text-center">
            <p className="text-muted-foreground text-sm">{error}</p>
          </div>
        )}

        {!loading && !error && detail && (
          <div className="space-y-4 py-2">
            {heroChunks.map((chunk) => (
              <div key={chunk.id} className="bg-card rounded-lg border p-4">
                <PatternContent content={stripEmbeddingPrefix(chunk.content)} />
              </div>
            ))}

            {restChunks.length > 0 && <PatternDetailSections chunks={restChunks} />}

            {detail.chunks.length === 0 && (
              <p className="text-muted-foreground py-4 text-center text-sm">
                No content available for this pattern.
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
