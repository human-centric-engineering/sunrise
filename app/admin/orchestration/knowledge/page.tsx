import type { Metadata } from 'next';
import Link from 'next/link';

import { KnowledgeView } from '@/components/admin/orchestration/knowledge/knowledge-view';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import type { AiKnowledgeDocument } from '@/types/orchestration';

export const metadata: Metadata = {
  title: 'Knowledge Base · AI Orchestration',
  description: 'Manage documents, seed patterns, and test knowledge base search.',
};

async function getDocuments(): Promise<AiKnowledgeDocument[]> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.KNOWLEDGE_DOCUMENTS);
    if (!res.ok) return [];
    const body = await parseApiResponse<AiKnowledgeDocument[]>(res);
    return body.success ? body.data : [];
  } catch (err) {
    logger.error('knowledge page: document fetch failed', err);
    return [];
  }
}

export default async function KnowledgeBasePage() {
  const documents = await getDocuments();

  return (
    <div className="space-y-6">
      <header>
        <nav className="text-muted-foreground mb-1 text-xs">
          <Link href="/admin/orchestration" className="hover:underline">
            AI Orchestration
          </Link>
          {' / '}
          <span>Knowledge Base</span>
        </nav>
        <h1 className="text-2xl font-semibold">Knowledge Base</h1>
        <p className="text-muted-foreground text-sm">
          Upload documents, seed built-in patterns, and test search relevance.
        </p>
      </header>

      <KnowledgeView documents={documents} />
    </div>
  );
}
