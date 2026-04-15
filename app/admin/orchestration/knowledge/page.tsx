import type { Metadata } from 'next';
import Link from 'next/link';

import { KnowledgeView } from '@/components/admin/orchestration/knowledge/knowledge-view';
import { FieldHelp } from '@/components/ui/field-help';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import type { AiKnowledgeDocument } from '@/types/orchestration';

export const metadata: Metadata = {
  title: 'Knowledge Base · AI Orchestration',
  description: 'Manage documents, seed patterns, and test knowledge base search.',
};

export default async function KnowledgeBasePage() {
  let documents: AiKnowledgeDocument[];
  try {
    documents = await prisma.aiKnowledgeDocument.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { _count: { select: { chunks: true } } },
    });
  } catch (err) {
    logger.error('knowledge page: document fetch failed', err);
    documents = [];
  }

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
              Upload documents, load built-in agentic design patterns, and use the search tester to
              verify queries return relevant results.
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
