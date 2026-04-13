'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw, Sprout } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { API } from '@/lib/api/endpoints';
import type { AiKnowledgeDocument } from '@/types/orchestration';

import { DocumentUploadZone } from './document-upload-zone';
import { SearchTest } from './search-test';

const STATUS_STYLES: Record<
  string,
  { variant: 'default' | 'secondary' | 'destructive' | 'outline'; label: string }
> = {
  pending: { variant: 'outline', label: 'Pending' },
  processing: { variant: 'secondary', label: 'Processing' },
  ready: { variant: 'default', label: 'Ready' },
  failed: { variant: 'destructive', label: 'Failed' },
};

interface KnowledgeViewProps {
  documents: AiKnowledgeDocument[];
}

export function KnowledgeView({ documents }: KnowledgeViewProps) {
  const router = useRouter();
  const [seeding, setSeeding] = useState(false);
  const [rechunkingId, setRechunkingId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    router.refresh();
  }, [router]);

  const handleSeed = useCallback(async () => {
    setSeeding(true);
    try {
      await fetch(API.ADMIN.ORCHESTRATION.KNOWLEDGE_SEED, { method: 'POST' });
      refresh();
    } finally {
      setSeeding(false);
    }
  }, [refresh]);

  const handleRechunk = useCallback(
    async (docId: string) => {
      setRechunkingId(docId);
      try {
        await fetch(API.ADMIN.ORCHESTRATION.knowledgeDocumentRechunk(docId), { method: 'POST' });
        refresh();
      } finally {
        setRechunkingId(null);
      }
    },
    [refresh]
  );

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-2">
        <Button onClick={() => void handleSeed()} disabled={seeding} variant="outline" size="sm">
          <Sprout className="mr-1 h-4 w-4" />
          {seeding ? 'Seeding...' : 'Seed Patterns'}
        </Button>
      </div>

      <DocumentUploadZone onUploadComplete={refresh} />

      {/* Document list */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Documents ({documents.length})</h3>

        {documents.length === 0 ? (
          <div className="text-muted-foreground rounded-lg border border-dashed p-8 text-center">
            <p className="text-sm">No documents yet.</p>
            <p className="mt-1 text-xs">
              Upload a file or seed the built-in patterns to get started.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Name</th>
                  <th className="px-4 py-2 text-left font-medium">Status</th>
                  <th className="px-4 py-2 text-right font-medium">Chunks</th>
                  <th className="px-4 py-2 text-left font-medium">Uploaded</th>
                  <th className="px-4 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {documents.map((doc) => {
                  const style = STATUS_STYLES[doc.status] ?? STATUS_STYLES.pending;
                  return (
                    <tr key={doc.id}>
                      <td className="px-4 py-2 font-medium">{doc.name}</td>
                      <td className="px-4 py-2">
                        <Badge variant={style.variant}>{style.label}</Badge>
                      </td>
                      <td className="px-4 py-2 text-right">{doc.chunkCount}</td>
                      <td className="text-muted-foreground px-4 py-2 text-xs">
                        {new Date(doc.createdAt).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={rechunkingId === doc.id}
                          onClick={() => void handleRechunk(doc.id)}
                        >
                          <RefreshCw
                            className={`mr-1 h-3 w-3 ${rechunkingId === doc.id ? 'animate-spin' : ''}`}
                          />
                          Rechunk
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <SearchTest />
    </div>
  );
}
