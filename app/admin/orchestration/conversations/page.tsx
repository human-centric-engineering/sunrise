import type { Metadata } from 'next';
import Link from 'next/link';

import {
  ConversationsTable,
  type ConversationListItem,
  type AgentOption,
} from '@/components/admin/orchestration/conversations-table';
import { LoadFailedNotice } from '@/components/admin/load-failed-notice';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { loadServerData, requireServerData } from '@/lib/api/server-load';
import { parsePaginationMeta } from '@/lib/validations/common';
import type { PaginationMeta } from '@/types/api';

export const metadata: Metadata = {
  title: 'Conversations · AI Orchestration',
  description: 'Browse and search AI agent conversations.',
};

const EMPTY_META: PaginationMeta = {
  page: 1,
  limit: 25,
  total: 0,
  totalPages: 1,
};

/** The list is the page: a failed load throws to the error boundary (#518). */
async function getConversations(): Promise<{
  conversations: ConversationListItem[];
  meta: PaginationMeta;
}> {
  const { data, meta } = await requireServerData<ConversationListItem[]>(
    `${API.ADMIN.ORCHESTRATION.CONVERSATIONS}?page=1&limit=25`
  );
  return { conversations: data, meta: parsePaginationMeta(meta) ?? EMPTY_META };
}

export default async function ConversationsListPage() {
  // The agent filter's options are secondary: without them the table still
  // works, so a failed load shows a notice instead of an empty filter.
  const [{ conversations, meta }, agents] = await Promise.all([
    getConversations(),
    loadServerData<AgentOption[]>(`${API.ADMIN.ORCHESTRATION.AGENTS}?page=1&limit=100`),
  ]);

  return (
    <div className="space-y-6">
      <nav className="text-muted-foreground -mb-5 text-xs">
        <Link href="/admin/orchestration" className="hover:underline">
          AI Orchestration
        </Link>
        {' / '}
        <span>Conversations</span>
      </nav>

      <header className="bg-background sticky top-0 z-30 -mx-6 border-b px-6 pt-3 pb-3">
        <h1 className="text-2xl font-semibold">
          Conversations{' '}
          <FieldHelp title="Conversations" contentClassName="w-80">
            <p>
              Browse all your chat conversations with AI agents. Search by title or toggle
              &quot;Search messages&quot; to find conversations by message content.
            </p>
            <p className="mt-2">
              Use the agent and status filters to narrow results. Click a conversation title to view
              the full message history.
            </p>
          </FieldHelp>
        </h1>
        <p className="text-muted-foreground text-sm">
          Browse, search, and filter your AI agent conversations.
        </p>
      </header>

      {!agents.ok && <LoadFailedNotice what="the agent filter options" />}

      <ConversationsTable
        initialConversations={conversations}
        initialMeta={meta}
        agents={agents.ok ? agents.data : []}
      />
    </div>
  );
}
