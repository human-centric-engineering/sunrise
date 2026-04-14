import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ConversationTraceViewer } from '@/components/admin/orchestration/conversation-trace-viewer';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';

export const metadata: Metadata = {
  title: 'Conversation · AI Orchestration',
  description: 'View conversation messages and metadata.',
};

interface ConversationDetail {
  id: string;
  title: string | null;
  agentId: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  agent?: { id: string; name: string; slug: string } | null;
  _count?: { messages: number };
}

interface ConversationMessage {
  id: string;
  role: string;
  content: string;
  capabilitySlug: string | null;
  toolCallId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

async function getConversation(id: string): Promise<ConversationDetail | null> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.conversationById(id));
    if (!res.ok) return null;
    const body = await parseApiResponse<ConversationDetail>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('conversation detail page: fetch failed', err, { id });
    return null;
  }
}

async function getMessages(id: string): Promise<ConversationMessage[]> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.conversationMessages(id));
    if (!res.ok) return [];
    const body = await parseApiResponse<{ messages: ConversationMessage[] }>(res);
    return body.success ? body.data.messages : [];
  } catch (err) {
    logger.error('conversation detail page: messages fetch failed', err, { id });
    return [];
  }
}

export default async function ConversationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [conversation, messages] = await Promise.all([getConversation(id), getMessages(id)]);

  if (!conversation) notFound();

  return (
    <div className="space-y-6">
      <header>
        <nav className="text-muted-foreground mb-1 text-xs">
          <Link href="/admin/orchestration" className="hover:underline">
            AI Orchestration
          </Link>
          {' / '}
          <span>Conversations</span>
          {' / '}
          <span className="text-foreground">{conversation.title ?? 'Untitled'}</span>
        </nav>
        <h1 className="text-2xl font-semibold">
          {conversation.title ?? 'Untitled conversation'}{' '}
          <FieldHelp
            title="What is a conversation?"
            contentClassName="w-96 max-h-80 overflow-y-auto"
          >
            <p>
              A conversation is a recorded session between a user and an agent. It contains the
              complete message history — user prompts, assistant responses, and tool call results —
              giving you a full trace of how the agent reasoned and acted.
            </p>
            <p className="text-foreground mt-2 font-medium">How to read it</p>
            <p>
              Messages appear chronologically. Tool-call messages show which capability was invoked
              and what data came back. Each message includes token counts and timestamps.
            </p>
            <p className="text-foreground mt-2 font-medium">This page</p>
            <p>
              Review the full message trace, inspect tool calls, and understand how the agent
              handled this interaction.
            </p>
          </FieldHelp>
        </h1>
        <div className="text-muted-foreground mt-1 flex flex-wrap gap-x-4 text-sm">
          {conversation.agent && <span>Agent: {conversation.agent.name}</span>}
          <span>Created: {new Date(conversation.createdAt).toLocaleDateString()}</span>
          <span>{conversation._count?.messages ?? messages.length} messages</span>
        </div>
      </header>

      <ConversationTraceViewer conversation={conversation} messages={messages} />
    </div>
  );
}
