import type { Metadata } from 'next';
import Link from 'next/link';

import { KnowledgeView } from '@/components/admin/orchestration/knowledge/knowledge-view';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { requireServerData } from '@/lib/api/server-load';
import type { KnowledgeDocumentListItem } from '@/types/orchestration';

export const metadata: Metadata = {
  title: 'Knowledge Base · AI Orchestration',
  description: 'Manage documents, seed patterns, and test knowledge base search.',
};

export default async function KnowledgeBasePage() {
  // A failed load reaches the error boundary rather than reading as an empty
  // knowledge base (#518).
  const { data: documents } = await requireServerData<KnowledgeDocumentListItem[]>(
    API.ADMIN.ORCHESTRATION.KNOWLEDGE_DOCUMENTS
  );

  return (
    <div className="space-y-6">
      <nav className="text-muted-foreground -mb-5 text-xs">
        <Link href="/admin/orchestration" className="hover:underline">
          AI Orchestration
        </Link>
        {' / '}
        <span>Knowledge Base</span>
      </nav>

      <header className="bg-background sticky top-0 z-30 -mx-6 border-b px-6 pt-3 pb-3">
        <h1 className="text-2xl font-semibold">
          Knowledge Base{' '}
          <FieldHelp
            title="What is the knowledge base?"
            contentClassName="w-96 max-h-80 overflow-y-auto"
          >
            <p>
              The knowledge base stores documents your agents can search at query time. Documents
              are split into chunks, converted to vector embeddings, and indexed for semantic search
              — a technique called RAG (Retrieval-Augmented Generation).
            </p>
            <p className="text-foreground mt-2 font-medium">How it works</p>
            <p>
              When an agent receives a question, the system finds the most relevant document chunks
              by vector similarity and includes them in the prompt as context. This grounds answers
              in your actual content instead of the LLM&apos;s general training data.
            </p>
            <p className="text-foreground mt-2 font-medium">This page</p>
            <p>
              Upload documents, load built-in agentic design patterns, manage the tag taxonomy that
              scopes agent access, and use the search tester to verify queries return relevant
              results.
            </p>
          </FieldHelp>
        </h1>
        <p className="text-muted-foreground text-sm">
          Upload documents, load built-in patterns, and test search relevance.
        </p>
      </header>

      <KnowledgeView documents={documents} />
    </div>
  );
}
