import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ConversationTags } from '@/components/admin/orchestration/conversation-tags';
import {
  ConversationTraceViewer,
  type ConversationMessage,
} from '@/components/admin/orchestration/conversation-trace-viewer';
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
  tags: string[];
  createdAt: string;
  updatedAt: string;
  agent?: { id: string; name: string; slug: string } | null;
  _count?: { messages: number };
  /**
   * Inbound messaging channel — populated for Twilio / WhatsApp Cloud
   * conversations, null for embed-widget / admin chats.
   */
  channel: string | null;
  provider: string | null;
  fromAddress: string | null;
  lastInboundAt: string | null;
  smsOptedOut: boolean;
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
      <nav className="text-muted-foreground -mb-5 text-xs">
        <Link href="/admin/orchestration" className="hover:underline">
          AI Orchestration
        </Link>
        {' / '}
        <span>Conversations</span>
        {' / '}
        <span className="text-foreground">{conversation.title ?? 'Untitled'}</span>
      </nav>

      <header className="bg-background sticky top-0 z-30 -mx-6 border-b px-6 pt-3 pb-3">
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

      <div className="flex items-center gap-2">
        <span className="text-muted-foreground text-sm">Tags:</span>
        <ConversationTags conversationId={conversation.id} initialTags={conversation.tags ?? []} />
      </div>

      {conversation.channel && (
        <div className="bg-muted/30 rounded-lg border p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-sm font-medium">
                Inbound channel{' '}
                <FieldHelp title="What is this section?">
                  <p>
                    This conversation was created by an inbound webhook (SMS / WhatsApp / future
                    messaging channel) rather than the embed widget or admin chat. The fields below
                    are populated by the inbound adapter and read by the{' '}
                    <code>send_message_to_channel</code> capability when the agent replies.
                  </p>
                </FieldHelp>
              </h3>
              <dl className="text-muted-foreground mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
                <div>
                  <dt className="font-medium">Channel</dt>
                  <dd className="font-mono">{conversation.channel}</dd>
                </div>
                <div>
                  <dt className="font-medium">Provider</dt>
                  <dd className="font-mono">{conversation.provider ?? '—'}</dd>
                </div>
                <div>
                  <dt className="font-medium">From</dt>
                  <dd className="font-mono">{conversation.fromAddress ?? '—'}</dd>
                </div>
                <div>
                  <dt className="font-medium">Last inbound</dt>
                  <dd>
                    {conversation.lastInboundAt
                      ? new Date(conversation.lastInboundAt).toLocaleString()
                      : '—'}
                  </dd>
                </div>
              </dl>
            </div>
            {conversation.smsOptedOut && (
              <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-md border px-3 py-1.5 text-xs font-medium">
                Opted out (STOP)
                <p className="text-destructive/80 mt-0.5 text-[10px] font-normal">
                  Outbound dispatches refused
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      <ConversationTraceViewer messages={messages} conversationId={conversation.id} />
    </div>
  );
}
