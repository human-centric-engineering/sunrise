import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ConversationTraceViewer } from '@/components/admin/orchestration/conversation-trace-viewer';
import { FieldHelp } from '@/components/ui/field-help';
import { getServerSession } from '@/lib/auth/utils';
import { prisma } from '@/lib/db/client';
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

export default async function ConversationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getServerSession();
  const userId = session?.user?.id;

  let conversation: ConversationDetail | null = null;
  let messages: ConversationMessage[] = [];

  try {
    if (userId) {
      const row = await prisma.aiConversation.findFirst({
        where: { id, userId },
        include: {
          agent: { select: { id: true, name: true, slug: true } },
          _count: { select: { messages: true } },
        },
      });
      if (row) {
        conversation = {
          id: row.id,
          title: row.title,
          agentId: row.agentId,
          isActive: row.isActive,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          agent: row.agent,
          _count: row._count,
        };

        const rawMessages = await prisma.aiMessage.findMany({
          where: { conversationId: id },
          orderBy: { createdAt: 'asc' },
        });
        messages = rawMessages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          capabilitySlug: m.capabilitySlug,
          toolCallId: m.toolCallId,
          metadata: m.metadata as Record<string, unknown> | null,
          createdAt: m.createdAt.toISOString(),
        }));
      }
    }
  } catch (err) {
    logger.error('conversation detail page: fetch failed', err, { id });
  }

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
