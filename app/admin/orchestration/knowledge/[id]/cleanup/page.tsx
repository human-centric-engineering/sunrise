import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { CleanupView } from '@/components/admin/orchestration/knowledge/cleanup-view';
import { API } from '@/lib/api/endpoints';
import { requireServerData } from '@/lib/api/server-load';
import { resolveCleanupAgentContextWindow } from '@/lib/orchestration/knowledge/cleanup-agent';
import { parseDocumentMetadata } from '@/lib/orchestration/knowledge/document-manager';

export const metadata: Metadata = {
  title: 'Document Clean Up · Knowledge Base',
  description: 'Interactively clean up an uploaded document before chunking.',
};

interface CleanupDocResponse {
  document: {
    id: string;
    name: string;
    fileName: string;
    status: string;
    originalContent: string | null;
    processedContent: string | null;
    metadata: unknown;
  };
}

export default async function CleanupPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // A 404 is a missing document; any other failure reaches the error boundary.
  const {
    data: { document },
  } = await requireServerData<CleanupDocResponse>(
    API.ADMIN.ORCHESTRATION.knowledgeDocumentById(id),
    { notFound: true }
  );

  // Already-finalised docs shouldn't be reachable via this URL — kick the
  // admin back to the main KB page rather than rendering a stale chat.
  if (document.status !== 'cleaning') {
    redirect('/admin/orchestration/knowledge');
  }

  const meta = parseDocumentMetadata(document.metadata);
  const contextWindow = await resolveCleanupAgentContextWindow(document.id);

  // ChatInterface looks up (or creates) the cleanup conversation via
  // contextType='knowledge_document' + contextId={documentId} server-side,
  // so the page doesn't need to resolve the conversationId itself.

  return (
    <div className="space-y-4">
      <nav className="text-muted-foreground -mb-2 text-xs">
        <Link href="/admin/orchestration" className="hover:underline">
          AI Orchestration
        </Link>
        {' / '}
        <Link href="/admin/orchestration/knowledge" className="hover:underline">
          Knowledge Base
        </Link>
        {' / '}
        <span>Document Clean Up</span>
      </nav>

      <CleanupView
        documentId={document.id}
        documentName={document.name}
        fileName={document.fileName}
        originalContent={document.originalContent ?? ''}
        initialProcessedContent={document.processedContent ?? document.originalContent ?? ''}
        sizeClass={meta?.sizeClass ?? 'small'}
        sizeTokens={meta?.sizeTokens ?? 0}
        llmRewriteAllowed={meta?.llmRewriteAllowed ?? true}
        contextWindow={contextWindow}
      />
    </div>
  );
}
