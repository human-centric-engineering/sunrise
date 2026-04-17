'use client';

/**
 * ConversationTraceViewer (Phase 7 Session 7.2)
 *
 * Client component that renders a conversation's messages as a vertical
 * timeline. Each message card shows role, content, timestamp, and
 * optional metadata (model, tokens, latency, cost). Tool messages
 * display a wrench icon, the capability slug, and collapsible JSON
 * content. A "Raw" toggle on each message reveals the full metadata.
 */

import { useState } from 'react';
import { Bot, Code, MessageSquare, Settings, User, Wrench } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldHelp } from '@/components/ui/field-help';
import { cn } from '@/lib/utils';
import { messageMetadataSchema } from '@/lib/validations/orchestration';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ConversationDetail {
  id: string;
  title: string | null;
  agent?: { id: string; name: string; slug: string } | null;
  _count?: { messages: number };
}

interface MessageMetadata {
  tokenUsage?: { input?: number; output?: number };
  modelUsed?: string;
  latencyMs?: number;
  costUsd?: number;
}

export interface ConversationMessage {
  id: string;
  role: string;
  content: string;
  capabilitySlug: string | null;
  toolCallId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface ConversationTraceViewerProps {
  conversation?: ConversationDetail;
  messages: ConversationMessage[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const ROLE_CONFIG: Record<
  string,
  { icon: React.ElementType; label: string; variant: 'default' | 'secondary' | 'outline' }
> = {
  user: { icon: User, label: 'User', variant: 'outline' },
  assistant: { icon: Bot, label: 'Assistant', variant: 'default' },
  system: { icon: Settings, label: 'System', variant: 'secondary' },
  tool: { icon: Wrench, label: 'Tool', variant: 'secondary' },
};

function parseMetadata(raw: Record<string, unknown> | null): MessageMetadata {
  if (!raw) return {};
  const result = messageMetadataSchema.safeParse(raw);
  return result.success ? result.data : {};
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  });
}

// ─── Message card ───────────────────────────────────────────────────────────

function MessageCard({ message }: { message: ConversationMessage }) {
  const [showRaw, setShowRaw] = useState(false);
  const config = ROLE_CONFIG[message.role] ?? ROLE_CONFIG.user;
  const Icon = config.icon;
  const meta = parseMetadata(message.metadata);
  const isTool = message.role === 'tool';

  return (
    <div
      data-testid={`message-${message.id}`}
      className={cn('border-border/60 rounded-md border p-4', isTool && 'bg-muted/30')}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon className="text-muted-foreground h-4 w-4" />
          <Badge variant={config.variant}>{config.label}</Badge>
          {isTool && message.capabilitySlug && (
            <span className="text-muted-foreground text-xs">{message.capabilitySlug}</span>
          )}
        </div>
        <span className="text-muted-foreground shrink-0 text-xs">
          {formatTimestamp(message.createdAt)}
        </span>
      </div>

      <div className="mt-2">
        {isTool ? (
          <pre className="bg-muted/40 overflow-x-auto rounded p-2 font-mono text-xs">
            {message.content}
          </pre>
        ) : (
          <p className="text-sm whitespace-pre-wrap">{message.content}</p>
        )}
      </div>

      {/* Metadata bar */}
      {(meta.modelUsed ||
        meta.tokenUsage ||
        meta.latencyMs !== undefined ||
        meta.costUsd !== undefined) && (
        <div className="text-muted-foreground mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
          {meta.modelUsed && <span>{meta.modelUsed}</span>}
          {meta.tokenUsage?.input !== undefined && (
            <span>{meta.tokenUsage.input.toLocaleString()} in</span>
          )}
          {meta.tokenUsage?.output !== undefined && (
            <span>{meta.tokenUsage.output.toLocaleString()} out</span>
          )}
          {meta.latencyMs !== undefined && <span>{meta.latencyMs} ms</span>}
          {meta.costUsd !== undefined && <span>${meta.costUsd.toFixed(4)}</span>}
        </div>
      )}

      {/* Raw toggle */}
      {message.metadata && Object.keys(message.metadata).length > 0 && (
        <div className="mt-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => setShowRaw((v) => !v)}
          >
            <Code className="mr-1 h-3 w-3" />
            {showRaw ? 'Hide raw' : 'Raw'}
          </Button>
          {showRaw && (
            <pre className="bg-muted/40 mt-1 overflow-x-auto rounded p-2 font-mono text-xs">
              {JSON.stringify(message.metadata, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Summary bar ────────────────────────────────────────────────────────────

function SummaryBar({ messages }: { messages: ConversationMessage[] }) {
  let totalTokens = 0;
  let totalCost = 0;
  let totalLatency = 0;
  let latencyCount = 0;

  for (const msg of messages) {
    const meta = parseMetadata(msg.metadata);
    if (meta.tokenUsage) {
      totalTokens += (meta.tokenUsage.input ?? 0) + (meta.tokenUsage.output ?? 0);
    }
    if (meta.costUsd !== undefined) totalCost += meta.costUsd;
    if (meta.latencyMs !== undefined) {
      totalLatency += meta.latencyMs;
      latencyCount++;
    }
  }

  const avgLatency = latencyCount > 0 ? Math.round(totalLatency / latencyCount) : null;

  return (
    <div className="grid gap-4 sm:grid-cols-4">
      <Card>
        <CardHeader className="pb-1">
          <CardTitle className="text-xs font-medium">Messages</CardTitle>
        </CardHeader>
        <CardContent>
          <span className="text-lg font-bold">{messages.length}</span>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-1">
          <CardTitle className="text-xs font-medium">
            Total Tokens{' '}
            <FieldHelp title="What are tokens?">
              Tokens are the units LLMs use to measure text — roughly ¾ of a word. Input tokens are
              what you send; output tokens are what the model generates. More tokens = higher cost.
            </FieldHelp>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <span className="text-lg font-bold">{totalTokens.toLocaleString()}</span>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-1">
          <CardTitle className="text-xs font-medium">Total Cost</CardTitle>
        </CardHeader>
        <CardContent>
          <span className="text-lg font-bold">${totalCost.toFixed(4)}</span>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-1">
          <CardTitle className="text-xs font-medium">
            Avg Latency{' '}
            <FieldHelp title="What is latency?">
              The average time in milliseconds between sending a prompt and receiving the first
              response token. Lower is faster.
            </FieldHelp>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <span className="text-lg font-bold">
            {avgLatency !== null ? `${avgLatency} ms` : '—'}
          </span>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

export function ConversationTraceViewer({ messages }: ConversationTraceViewerProps) {
  return (
    <div className="space-y-6">
      <SummaryBar messages={messages} />

      {messages.length === 0 ? (
        <div className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
          <MessageSquare className="h-4 w-4" />
          <span>No messages in this conversation.</span>
        </div>
      ) : (
        <div className="space-y-3">
          {messages.map((msg) => (
            <MessageCard key={msg.id} message={msg} />
          ))}
        </div>
      )}
    </div>
  );
}
