import type { Metadata } from 'next';
import Link from 'next/link';

import {
  ConversationsTable,
  type ConversationListItem,
  type AgentOption,
} from '@/components/admin/orchestration/conversations-table';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { parsePaginationMeta } from '@/lib/validations/common';
import { logger } from '@/lib/logging';
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

async function getConversations(): Promise<{
  conversations: ConversationListItem[];
  meta: PaginationMeta;
}> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.CONVERSATIONS}?page=1&limit=25`);
    if (!res.ok) return { conversations: [], meta: EMPTY_META };
    const body = await parseApiResponse<ConversationListItem[]>(res);
    if (!body.success) return { conversations: [], meta: EMPTY_META };
    return {
      conversations: body.data,
      meta: parsePaginationMeta(body.meta) ?? EMPTY_META,
    };
  } catch (err) {
    logger.error('conversations list page: initial fetch failed', err);
    return { conversations: [], meta: EMPTY_META };
  }
}

async function getAgents(): Promise<AgentOption[]> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.AGENTS}?page=1&limit=100`);
    if (!res.ok) return [];
    const body = await parseApiResponse<AgentOption[]>(res);
    return body.success ? body.data : [];
  } catch {
    return [];
  }
}

export default async function ConversationsListPage() {
  const [{ conversations, meta }, agents] = await Promise.all([getConversations(), getAgents()]);

  return (
    <div className="space-y-6">
      <header>
        <nav className="text-muted-foreground mb-1 text-xs">
          <Link href="/admin/orchestration" className="hover:underline">
            AI Orchestration
          </Link>
          {' / '}
          <span>Conversations</span>
        </nav>
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

      <ConversationsTable initialConversations={conversations} initialMeta={meta} agents={agents} />
    </div>
  );
}
