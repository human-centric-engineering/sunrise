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
import {
  Bot,
  Code,
  Download,
  FileJson,
  FileText,
  MessageSquare,
  Settings,
  User,
  Wrench,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { cn } from '@/lib/utils';
import { messageMetadataSchema, messageProvenanceSchema } from '@/lib/validations/orchestration';
import { MessageWithCitations } from '@/components/admin/orchestration/chat/message-with-citations';
import { MessageTrace } from '@/components/admin/orchestration/chat/message-trace';
import type { Citation, ToolCallTrace } from '@/types/orchestration';

// ─── Types ──────────────────────────────────────────────────────────────────

interface MessageMetadata {
  tokenUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  latencyMs?: number;
  costUsd?: number;
}

interface MessageProvenance {
  citations?: Citation[];
  capabilityCalls?: ToolCallTrace[];
}

export interface ConversationMessage {
  id: string;
  role: string;
  content: string;
  capabilitySlug: string | null;
  toolCallId: string | null;
  metadata: Record<string, unknown> | null;
  /**
   * Provenance bundle: citations, capability calls, workflow sources.
   * Migrated out of `metadata` so it is queryable + first-class. The
   * trace viewer reads citations and capabilityCalls from here.
   */
  provenance: Record<string, unknown> | null;
  /** Scalar version pins — null on direct chat with the live agent. */
  agentVersionId: string | null;
  workflowExecutionId: string | null;
  workflowVersionId: string | null;
  /** Model + provider that produced the assistant turn. */
  modelId: string | null;
  providerSlug: string | null;
  createdAt: string;
}

export interface ConversationTraceViewerProps {
  messages: ConversationMessage[];
  /**
   * Conversation id — required to render the provenance download
   * buttons (JSON + Markdown). Omit when the viewer is used in a
   * preview / non-routable context.
   */
  conversationId?: string;
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

function parseProvenance(raw: Record<string, unknown> | null): MessageProvenance {
  if (!raw) return {};
  const result = messageProvenanceSchema.safeParse(raw);
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
  const prov = parseProvenance(message.provenance);
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
        ) : message.role === 'assistant' ? (
          <>
            <MessageWithCitations
              content={message.content}
              citations={prov.citations}
              className="text-sm"
            />
            {prov.capabilityCalls && prov.capabilityCalls.length > 0 && (
              <MessageTrace toolCalls={prov.capabilityCalls} />
            )}
          </>
        ) : (
          <p className="text-sm whitespace-pre-wrap">{message.content}</p>
        )}
      </div>

      {/* Metadata bar */}
      {(message.modelId ||
        meta.tokenUsage ||
        meta.latencyMs !== undefined ||
        meta.costUsd !== undefined) && (
        <div className="text-muted-foreground mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
          {message.modelId && <span>{message.modelId}</span>}
          {message.providerSlug && <span>· {message.providerSlug}</span>}
          {meta.tokenUsage?.inputTokens !== undefined && (
            <span>{meta.tokenUsage.inputTokens.toLocaleString()} in</span>
          )}
          {meta.tokenUsage?.outputTokens !== undefined && (
            <span>{meta.tokenUsage.outputTokens.toLocaleString()} out</span>
          )}
          {meta.latencyMs !== undefined && <span>{meta.latencyMs} ms</span>}
          {meta.costUsd !== undefined && <span>${meta.costUsd.toFixed(4)}</span>}
        </div>
      )}

      {/* Provenance pin row — version pins surface as small badges next
          to the message so an auditor can see at a glance which
          agent/workflow version was running. Mirrors the
          SupervisorVerdictBadge styling in execution-detail-view. */}
      {(message.agentVersionId || message.workflowExecutionId) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {message.agentVersionId && (
            <Badge variant="outline" className="font-mono text-[10px]">
              agent {message.agentVersionId.slice(0, 8)}
            </Badge>
          )}
          {message.workflowExecutionId && (
            <Badge variant="outline" className="font-mono text-[10px]">
              workflow exec {message.workflowExecutionId.slice(0, 8)}
              {message.workflowVersionId ? ` @ ${message.workflowVersionId.slice(0, 8)}` : ''}
            </Badge>
          )}
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
      totalTokens += (meta.tokenUsage.inputTokens ?? 0) + (meta.tokenUsage.outputTokens ?? 0);
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

// ─── Download button group ──────────────────────────────────────────────────

/**
 * Audit-bundle download affordance — JSON + Markdown.
 *
 * Mirrors the per-execution "Download report.md" button in
 * ExecutionDetailView. The PDF button is reserved for the future
 * Gotenberg-backed `provenance.pdf` route and stays hidden until that
 * infrastructure is provisioned.
 */
function DownloadProvenance({ conversationId }: { conversationId: string }) {
  return (
    <div
      data-testid="download-provenance"
      className="flex flex-wrap items-center gap-2 rounded-md border p-3"
    >
      <Download className="text-muted-foreground h-4 w-4" />
      <span className="text-sm font-medium">Download provenance</span>
      <FieldHelp title="What is the provenance bundle?">
        The audit trail behind every assistant message — agent / workflow / model versions, KB
        chunks cited (with their content hash at message time), capability calls, and workflow step
        sources. Hand this to a reviewer to answer &ldquo;how did the agent arrive at this answer on
        this date?&rdquo;
      </FieldHelp>
      <div className="ml-auto flex flex-wrap gap-2">
        <Button asChild variant="outline" size="sm">
          <a
            href={API.ADMIN.ORCHESTRATION.conversationProvenance(conversationId)}
            target="_blank"
            rel="noopener noreferrer"
          >
            <FileJson className="mr-1 h-3.5 w-3.5" />
            JSON
          </a>
        </Button>
        <Button asChild variant="outline" size="sm">
          <a
            href={API.ADMIN.ORCHESTRATION.conversationProvenanceMarkdown(conversationId)}
            target="_blank"
            rel="noopener noreferrer"
          >
            <FileText className="mr-1 h-3.5 w-3.5" />
            Markdown
          </a>
        </Button>
      </div>
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

export function ConversationTraceViewer({
  messages,
  conversationId,
}: ConversationTraceViewerProps) {
  return (
    <div className="space-y-6">
      <SummaryBar messages={messages} />

      {conversationId && <DownloadProvenance conversationId={conversationId} />}

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
