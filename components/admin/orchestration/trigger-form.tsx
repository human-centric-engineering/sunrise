'use client';

/**
 * TriggerForm — create + edit form for AiWorkflowTrigger rows.
 *
 * One form covers all channels. The shown helpers adapt to the chosen
 * channel: HMAC reveals a `signingSecret` field (mandatory, with a
 * `Generate` button); Twilio/WhatsApp Cloud reveal a
 * `conversationAgentId` picker (required for conversation enrichment +
 * outbound replies). All channels offer an optional `eventTypes`
 * allow-list.
 *
 * Webhook URL is computed live from `(adapterChannel, workflowSlug)`
 * and shown as a copy-ready code block.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { logger } from '@/lib/logging';

export interface WorkflowOption {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
}

export interface AgentOption {
  id: string;
  name: string;
}

export interface TriggerFormInitial {
  id?: string;
  channel: string;
  name: string;
  workflowId: string;
  metadata: Record<string, unknown>;
  isEnabled: boolean;
  hasSigningSecret: boolean;
}

interface Props {
  mode: 'create' | 'edit';
  initial?: TriggerFormInitial;
  workflows: WorkflowOption[];
  agents: AgentOption[];
  enabledChannels: string[];
  /** Public base URL for the webhook preview. */
  baseUrl: string;
}

const ALL_CHANNELS = ['slack', 'postmark', 'twilio', 'whatsapp_cloud', 'hmac'] as const;

const CHANNEL_DESCRIPTIONS: Record<string, string> = {
  slack: 'Single-workspace Slack app; HMAC verified via SLACK_SIGNING_SECRET.',
  postmark: 'Postmark inbound email parse; Basic-auth via POSTMARK_INBOUND_USER + _PASS.',
  twilio: 'Twilio SMS + Twilio-routed WhatsApp; HMAC-SHA1 verified via TWILIO_AUTH_TOKEN.',
  whatsapp_cloud:
    'Meta WhatsApp Business Cloud (direct, not via BSP); requires WHATSAPP_VERIFY_TOKEN + WHATSAPP_APP_SECRET.',
  hmac: 'Generic HMAC-SHA256; per-trigger signing secret stored on this row.',
};

const CHANNEL_NEEDS_CONVERSATION_AGENT = new Set(['twilio', 'whatsapp_cloud']);

function generateHmacSecret(): string {
  // 32 random bytes → 64 hex chars. Mirrors `generateHookSecret()`.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function TriggerForm({ mode, initial, workflows, agents, enabledChannels, baseUrl }: Props) {
  const router = useRouter();
  const isEdit = mode === 'edit';

  const [channel, setChannel] = useState<string>(initial?.channel ?? 'slack');
  const [name, setName] = useState(initial?.name ?? '');
  const [workflowId, setWorkflowId] = useState(initial?.workflowId ?? workflows[0]?.id ?? '');
  const [isEnabled, setIsEnabled] = useState(initial?.isEnabled ?? true);
  const [signingSecret, setSigningSecret] = useState<string>('');
  const [rotateSecret, setRotateSecret] = useState(false);

  const initialMeta = initial?.metadata ?? {};
  const initialEventTypes = Array.isArray(initialMeta.eventTypes)
    ? (initialMeta.eventTypes as string[])
    : [];
  const [eventTypesRaw, setEventTypesRaw] = useState(initialEventTypes.join(', '));
  const [conversationAgentId, setConversationAgentId] = useState<string>(
    (initialMeta as { conversationAgentId?: string }).conversationAgentId ?? ''
  );

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedWorkflow = workflows.find((w) => w.id === workflowId);
  const webhookUrl = selectedWorkflow
    ? `${baseUrl}/api/v1/inbound/${channel}/${selectedWorkflow.slug}`
    : '';
  const adapterRegistered = enabledChannels.includes(channel);
  const channelNeedsConvAgent = CHANNEL_NEEDS_CONVERSATION_AGENT.has(channel);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    const eventTypes = eventTypesRaw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const metadata: Record<string, unknown> = {};
    if (eventTypes.length > 0) metadata.eventTypes = eventTypes;
    if (conversationAgentId) metadata.conversationAgentId = conversationAgentId;

    try {
      if (isEdit && initial?.id) {
        const body: Record<string, unknown> = {
          name,
          metadata,
          isEnabled,
        };
        if (rotateSecret) {
          body.signingSecret = signingSecret;
        }
        await apiClient.patch(API.ADMIN.ORCHESTRATION.triggerById(initial.id), { body });
      } else {
        const body: Record<string, unknown> = {
          workflowId,
          channel,
          name,
          metadata,
          isEnabled,
        };
        if (channel === 'hmac') body.signingSecret = signingSecret;
        await apiClient.post(API.ADMIN.ORCHESTRATION.TRIGGERS, { body });
      }
      router.push('/admin/orchestration/triggers');
      router.refresh();
    } catch (err) {
      logger.error('trigger-form: submit failed', err);
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        void handleSubmit(e);
      }}
      className="space-y-6"
    >
      {error && (
        <div className="border-destructive bg-destructive/10 text-destructive rounded-lg border p-3 text-sm">
          {error}
        </div>
      )}

      {/* Channel */}
      <div className="space-y-2">
        <Label htmlFor="channel">
          Channel
          <FieldHelp title="What is a channel?">
            <p>
              The adapter slug used in the inbound URL — picks which adapter parses the request
              (HMAC verification + payload normalisation). Cannot be changed after creation, so pick
              carefully. Channels whose env vars aren&apos;t set will show a warning.
            </p>
          </FieldHelp>
        </Label>
        <Select value={channel} onValueChange={setChannel} disabled={isEdit}>
          <SelectTrigger id="channel" aria-label="Channel adapter slug">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ALL_CHANNELS.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
                {!enabledChannels.includes(c) && ' (adapter not registered)'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">{CHANNEL_DESCRIPTIONS[channel]}</p>
        {!adapterRegistered && (
          <Badge variant="destructive" className="text-[10px]">
            adapter not registered in this deployment — inbound POSTs will 404 until env vars are
            set
          </Badge>
        )}
      </div>

      {/* Workflow */}
      <div className="space-y-2">
        <Label htmlFor="workflow">Workflow</Label>
        <Select value={workflowId} onValueChange={setWorkflowId} disabled={isEdit}>
          <SelectTrigger id="workflow" aria-label="Workflow">
            <SelectValue placeholder="Select a workflow" />
          </SelectTrigger>
          <SelectContent>
            {workflows.map((w) => (
              <SelectItem key={w.id} value={w.id}>
                {w.name} {!w.isActive && '(inactive)'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Name */}
      <div className="space-y-2">
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. SMS support intake"
          required
          maxLength={200}
        />
      </div>

      {/* Webhook URL preview */}
      {selectedWorkflow && (
        <div className="space-y-2">
          <Label>Webhook URL (point your vendor at this)</Label>
          <div className="bg-muted/30 rounded-lg border p-3">
            <code className="block font-mono text-xs break-all">{webhookUrl}</code>
          </div>
          <p className="text-muted-foreground text-xs">
            Inbound POSTs to this URL will fire <strong>{selectedWorkflow.name}</strong>. The
            adapter verifies the signature before any database lookup.
          </p>
        </div>
      )}

      {/* HMAC: per-trigger signing secret */}
      {channel === 'hmac' && (
        <div className="space-y-2">
          <Label htmlFor="signingSecret">
            Signing secret
            <FieldHelp title="What's this for?">
              <p>
                The generic-HMAC channel uses a per-trigger secret. Senders compute{' '}
                <code>
                  HMAC-SHA256(&quot;{'{'}ts{'}'}.{'{'}rawBody{'}'}&quot;, secret)
                </code>{' '}
                and pass it in the <code>X-Sunrise-Signature</code> header. Save this value
                somewhere safe — it&apos;s shown once on creation, then redacted.
              </p>
            </FieldHelp>
          </Label>
          {isEdit && initial?.hasSigningSecret && !rotateSecret ? (
            <div className="flex items-center gap-2">
              <Badge variant="outline">secret set</Badge>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setRotateSecret(true)}
              >
                Rotate secret
              </Button>
            </div>
          ) : (
            <div className="flex gap-2">
              <Input
                id="signingSecret"
                value={signingSecret}
                onChange={(e) => setSigningSecret(e.target.value)}
                placeholder="64 hex chars recommended"
                minLength={16}
                required={!isEdit || rotateSecret}
                type="text"
                className="font-mono text-xs"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => setSigningSecret(generateHmacSecret())}
              >
                Generate
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Twilio + WhatsApp Cloud: conversation-owning agent */}
      {channelNeedsConvAgent && (
        <div className="space-y-2">
          <Label htmlFor="conversationAgentId">
            Conversation-owning agent
            <FieldHelp title="Why does this matter?">
              <p className="mb-2">
                SMS and WhatsApp conversations live as <code>AiConversation</code> rows on a
                specific agent. The inbound trigger needs to know which agent owns this
                channel&apos;s conversations so it can find-or-create the row and update{' '}
                <code>lastInboundAt</code> + STOP / opt-out flags.
              </p>
              <p>
                Without this set, the workflow still runs but no conversation is recorded — and any{' '}
                <code>send_message_to_channel</code> call from the workflow will return{' '}
                <code>no_inbound_channel</code>.
              </p>
            </FieldHelp>
          </Label>
          <Select value={conversationAgentId} onValueChange={setConversationAgentId}>
            <SelectTrigger id="conversationAgentId" aria-label="Conversation agent">
              <SelectValue placeholder="(none — conversations won't be enriched)" />
            </SelectTrigger>
            <SelectContent>
              {agents.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Event types allow-list */}
      <div className="space-y-2">
        <Label htmlFor="eventTypes">
          Event types allow-list (optional)
          <FieldHelp title="Filter event types">
            <p>
              Comma-separated list of normalised event types to accept. Events outside this list are
              acknowledged with 200 but skipped. Leave empty to accept all (Twilio: filter to{' '}
              <code>message</code> to skip status callbacks; Slack: filter to{' '}
              <code>app_mention</code>; etc.).
            </p>
          </FieldHelp>
        </Label>
        <Textarea
          id="eventTypes"
          value={eventTypesRaw}
          onChange={(e) => setEventTypesRaw(e.target.value)}
          placeholder="e.g. message, app_mention"
          rows={2}
        />
      </div>

      {/* Enabled toggle */}
      <div className="flex items-center justify-between rounded-lg border p-4">
        <div>
          <Label htmlFor="isEnabled">Enabled</Label>
          <p className="text-muted-foreground text-xs">
            When disabled the inbound route returns 404, even though the row remains.
          </p>
        </div>
        <Switch id="isEnabled" checked={isEnabled} onCheckedChange={setIsEnabled} />
      </div>

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => router.push('/admin/orchestration/triggers')}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Create trigger'}
        </Button>
      </div>
    </form>
  );
}
