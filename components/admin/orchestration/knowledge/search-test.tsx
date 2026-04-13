'use client';

import { useCallback, useState } from 'react';
import { Search } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { API } from '@/lib/api/endpoints';
import type { KnowledgeSearchResult } from '@/types/orchestration';

export function SearchTest() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<KnowledgeSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  const handleSearch = useCallback(async () => {
    if (!query.trim()) return;

    setSearching(true);
    setError(null);

    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.KNOWLEDGE_SEARCH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query.trim(), limit: 10 }),
      });

      if (!res.ok) {
        throw new Error('Search failed');
      }

      const body: unknown = await res.json();
      const data =
        body !== null &&
        typeof body === 'object' &&
        'data' in body &&
        Array.isArray((body as Record<string, unknown>).data)
          ? ((body as Record<string, unknown>).data as KnowledgeSearchResult[])
          : [];
      setResults(data);
      setSearched(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setSearching(false);
    }
  }, [query]);

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium">Search Test</h3>

      <div className="flex gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Test a search query..."
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleSearch();
          }}
        />
        <Button onClick={() => void handleSearch()} disabled={searching || !query.trim()} size="sm">
          <Search className="mr-1 h-4 w-4" />
          {searching ? 'Searching...' : 'Search'}
        </Button>
      </div>

      {error && <p className="text-destructive text-sm">{error}</p>}

      {searched && results.length === 0 && (
        <p className="text-muted-foreground text-sm">No results found.</p>
      )}

      {results.length > 0 && (
        <div className="space-y-3">
          {results.map((r) => (
            <div key={r.chunk.id} className="rounded-lg border p-3">
              <div className="mb-1 flex items-center gap-2">
                <Badge variant="outline">{r.chunk.chunkType}</Badge>
                <span className="text-muted-foreground text-xs">
                  Similarity: {(r.similarity * 100).toFixed(1)}%
                </span>
              </div>
              <p className="line-clamp-3 text-sm">{r.chunk.content}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
