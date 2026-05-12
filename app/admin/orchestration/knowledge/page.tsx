import type { Metadata } from 'next';
import Link from 'next/link';
import { Tag } from 'lucide-react';

import { KnowledgeView } from '@/components/admin/orchestration/knowledge/knowledge-view';
import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
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
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <nav className="text-muted-foreground mb-1 text-xs">
            <Link href="/admin/orchestration" className="hover:underline">
              AI Orchestration
            </Link>
            {' / '}
            <span>Knowledge Base</span>
          </nav>
          <h1 className="text-2xl font-semibold">
            Knowledge Base{' '}
            <FieldHelp
              title="What is the knowledge base?"
              contentClassName="w-96 max-h-80 overflow-y-auto"
            >
              <p>
                The knowledge base stores documents your agents can search at query time. Documents
                are split into chunks, converted to vector embeddings, and indexed for semantic
                search — a technique called RAG (Retrieval-Augmented Generation).
              </p>
              <p className="text-foreground mt-2 font-medium">How it works</p>
              <p>
                When an agent receives a question, the system finds the most relevant document
                chunks by vector similarity and includes them in the prompt as context. This grounds
                answers in your actual content instead of the LLM&apos;s general training data.
              </p>
              <p className="text-foreground mt-2 font-medium">This page</p>
              <p>
                Upload documents, load built-in agentic design patterns, and use the search tester
                to verify queries return relevant results.
              </p>
            </FieldHelp>
          </h1>
          <p className="text-muted-foreground text-sm">
            Upload documents, load built-in patterns, and test search relevance.
          </p>
        </div>
        <Button asChild variant="outline" size="sm" className="shrink-0">
          <Link href="/admin/orchestration/knowledge/tags">
            <Tag className="mr-1.5 h-4 w-4" />
            Manage tags
          </Link>
        </Button>
      </header>

      <KnowledgeView documents={documents} />
    </div>
  );
}
