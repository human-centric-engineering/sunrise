'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { FileText, Search, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { z } from 'zod';

import { API } from '@/lib/api/endpoints';

const knowledgeChunkSchema = z.object({
  id: z.string(),
  chunkKey: z.string(),
  documentId: z.string(),
  content: z.string(),
  chunkType: z.string(),
  patternNumber: z.number().nullable(),
  patternName: z.string().nullable(),
  category: z.string().nullable(),
  section: z.string().nullable(),
  keywords: z.string().nullable(),
  estimatedTokens: z.number().nullable(),
  embeddingModel: z.string().nullable(),
  embeddingProvider: z.string().nullable(),
  embeddedAt: z.coerce.date().nullable(),
  metadata: z.unknown().nullable(),
});

const searchResultSchema = z.object({
  chunk: knowledgeChunkSchema,
  similarity: z.number(),
  documentName: z.string().optional(),
});

type KnowledgeSearchResult = z.infer<typeof searchResultSchema>;

const searchResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({ results: z.array(searchResultSchema) }).optional(),
});

/** Returns similarity badge colour classes based on score tier */
function similarityClasses(score: number): string {
  if (score >= 0.8) return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400';
  if (score >= 0.6) return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400';
  return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400';
}

/** Check if content looks like it contains markdown */
function looksLikeMarkdown(content: string): boolean {
  return /^#{1,6}\s|^\*\*|^-\s|^\d+\.\s|```|`[^`]+`|\[.*\]\(/.test(content);
}

interface ExploreTabProps {
  scope?: string;
}

export function ExploreTab({ scope }: ExploreTabProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<KnowledgeSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState<KnowledgeSearchResult | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doSearch = useCallback(
    async (q: string) => {
      setSearching(true);
      try {
        const res = await fetch(API.ADMIN.ORCHESTRATION.KNOWLEDGE_SEARCH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: q, limit: 20, ...(scope ? { scope } : {}) }),
        });
        if (!res.ok) return;
        const body = searchResponseSchema.parse(await res.json());
        if (body.success && body.data) {
          setResults(body.data.results);
        }
      } catch {
        // Silently handle — no results shown
      } finally {
        setSearching(false);
        setSearched(true);
      }
    },
    [scope]
  );

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const trimmed = query.trim();
    if (trimmed.length < 3) {
      setResults([]);
      setSearched(false);
      return;
    }

    debounceRef.current = setTimeout(() => {
      void doSearch(trimmed);
    }, 400);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, doSearch]);

  return (
    <div className="space-y-6">
      {/* Search input */}
      <div className="relative">
        <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
        <Input
          placeholder="Search the knowledge base..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pr-10 pl-10"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            className="text-muted-foreground hover:text-foreground absolute top-1/2 right-3 -translate-y-1/2"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Hint / status */}
      {query.trim().length > 0 && query.trim().length < 3 && (
        <p className="text-muted-foreground text-center text-xs">
          Type at least 3 characters to search
        </p>
      )}

      {searching && (
        <div className="text-muted-foreground flex items-center justify-center gap-2 py-8 text-sm">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
          Searching...
        </div>
      )}

      {/* Empty states */}
      {!searching && !searched && query.trim().length === 0 && (
        <div className="text-muted-foreground rounded-lg border border-dashed p-12 text-center">
          <Search className="mx-auto mb-3 h-10 w-10 opacity-40" />
          <p className="text-sm font-medium">Explore the knowledge base</p>
          <p className="mt-1 text-xs">
            Enter a natural language query to see what the vector search retrieves.
          </p>
        </div>
      )}

      {!searching && searched && results.length === 0 && (
        <div className="text-muted-foreground rounded-lg border border-dashed p-12 text-center">
          <p className="text-sm font-medium">No results found</p>
          <p className="mt-1 text-xs">
            No matching chunks for &ldquo;{query.trim()}&rdquo;. Try a different query or ensure
            embeddings have been generated.
          </p>
        </div>
      )}

      {/* Results list */}
      {!searching && results.length > 0 && (
        <div className="space-y-3">
          <p className="text-muted-foreground text-xs">
            {results.length} result{results.length !== 1 ? 's' : ''}
          </p>
          {results.map((result) => (
            <button
              key={result.chunk.id}
              type="button"
              onClick={() => setSelected(result)}
              className="hover:bg-muted/50 w-full rounded-lg border p-4 text-left transition-colors"
            >
              <div className="flex items-start gap-3">
                <Badge className={`shrink-0 ${similarityClasses(result.similarity)}`}>
                  {Math.round(result.similarity * 100)}%
                </Badge>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex items-center gap-2">
                    {result.documentName && (
                      <span className="text-muted-foreground flex items-center gap-1 text-xs">
                        <FileText className="h-3 w-3" />
                        {result.documentName}
                      </span>
                    )}
                    <Badge variant="outline" className="text-xs">
                      {result.chunk.chunkType}
                    </Badge>
                    {result.chunk.patternName && (
                      <Badge variant="secondary" className="text-xs">
                        {result.chunk.patternName}
                      </Badge>
                    )}
                  </div>
                  <div className="line-clamp-4 text-sm leading-relaxed">
                    {looksLikeMarkdown(result.chunk.content) ? (
                      <div className="prose prose-sm dark:prose-invert max-w-none">
                        <Markdown>{result.chunk.content.slice(0, 500)}</Markdown>
                      </div>
                    ) : (
                      <p className="text-muted-foreground">{result.chunk.content.slice(0, 500)}</p>
                    )}
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Detail modal */}
      <Dialog open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              Chunk Detail
              {selected && (
                <Badge className={similarityClasses(selected.similarity)}>
                  {Math.round(selected.similarity * 100)}% similarity
                </Badge>
              )}
            </DialogTitle>
          </DialogHeader>

          {selected && (
            <div className="space-y-4">
              {/* Content */}
              <div className="prose prose-sm dark:prose-invert max-w-none rounded-lg border p-4">
                {looksLikeMarkdown(selected.chunk.content) ? (
                  <Markdown>{selected.chunk.content}</Markdown>
                ) : (
                  <p className="whitespace-pre-wrap">{selected.chunk.content}</p>
                )}
              </div>

              {/* Metadata grid */}
              <div className="space-y-2">
                <h4 className="text-sm font-medium">Metadata</h4>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  {selected.documentName && (
                    <>
                      <span className="text-muted-foreground">Document</span>
                      <span>{selected.documentName}</span>
                    </>
                  )}
                  <span className="text-muted-foreground">Chunk Type</span>
                  <span>
                    <Badge variant="outline">{selected.chunk.chunkType}</Badge>
                  </span>
                  {selected.chunk.patternNumber !== null && (
                    <>
                      <span className="text-muted-foreground">Pattern #</span>
                      <span>{selected.chunk.patternNumber}</span>
                    </>
                  )}
                  {selected.chunk.patternName && (
                    <>
                      <span className="text-muted-foreground">Pattern Name</span>
                      <span>{selected.chunk.patternName}</span>
                    </>
                  )}
                  {selected.chunk.category && (
                    <>
                      <span className="text-muted-foreground">Category</span>
                      <span>{selected.chunk.category}</span>
                    </>
                  )}
                  {selected.chunk.section && (
                    <>
                      <span className="text-muted-foreground">Section</span>
                      <span>{selected.chunk.section}</span>
                    </>
                  )}
                  {selected.chunk.keywords && (
                    <>
                      <span className="text-muted-foreground">Keywords</span>
                      <span className="text-xs">{selected.chunk.keywords}</span>
                    </>
                  )}
                  {selected.chunk.estimatedTokens !== null && (
                    <>
                      <span className="text-muted-foreground">Estimated Tokens</span>
                      <span>{selected.chunk.estimatedTokens}</span>
                    </>
                  )}
                  <span className="text-muted-foreground">Similarity Score</span>
                  <span>{selected.similarity.toFixed(4)}</span>
                  {selected.chunk.metadata !== null &&
                  typeof selected.chunk.metadata === 'object' &&
                  !Array.isArray(selected.chunk.metadata)
                    ? Object.entries(selected.chunk.metadata as Record<string, unknown>).map(
                        ([key, value]) => (
                          <div key={key} className="col-span-2 grid grid-cols-2">
                            <span className="text-muted-foreground">{key}</span>
                            <span className="text-xs break-all">
                              {typeof value === 'string' ? value : JSON.stringify(value)}
                            </span>
                          </div>
                        )
                      )
                    : null}
                </div>
              </div>

              <div className="flex justify-end">
                <DialogClose asChild>
                  <Button variant="outline" size="sm">
                    Close
                  </Button>
                </DialogClose>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
