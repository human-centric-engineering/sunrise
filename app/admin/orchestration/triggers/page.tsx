import type { Metadata } from 'next';
import Link from 'next/link';

import {
  TriggersTable,
  type TriggerListItem,
} from '@/components/admin/orchestration/triggers-table';
import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';

export const metadata: Metadata = {
  title: 'Inbound Triggers · AI Orchestration',
  description:
    'Manage workflow inbound triggers — webhook configurations that fire workflows from Slack, Postmark, Twilio, WhatsApp Cloud, or generic HMAC senders.',
};

async function getTriggers(): Promise<{
  triggers: TriggerListItem[];
  enabledChannels: string[];
}> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.TRIGGERS}?page=1&limit=100`);
    if (!res.ok) return { triggers: [], enabledChannels: [] };
    const body = await parseApiResponse<TriggerListItem[]>(res);
    if (!body.success) return { triggers: [], enabledChannels: [] };
    const enabledChannels =
      body.meta && typeof body.meta === 'object' && 'enabledChannels' in body.meta
        ? ((body.meta as { enabledChannels: string[] }).enabledChannels ?? [])
        : [];
    return { triggers: body.data, enabledChannels };
  } catch (err) {
    logger.error('triggers list page: initial fetch failed', err);
    return { triggers: [], enabledChannels: [] };
  }
}

export default async function TriggersListPage() {
  const { triggers, enabledChannels } = await getTriggers();

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Inbound Triggers</h2>
          <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
            Each trigger row gives a workflow a unique webhook URL that an external system can call
            to fire it — Slack events, Postmark inbound email, Twilio SMS / WhatsApp, Meta WhatsApp
            Cloud, or any signed HMAC sender.{' '}
            <FieldHelp title="What's a trigger?">
              <p className="mb-2">
                Triggers map a workflow to an inbound webhook URL of the form{' '}
                <code>/api/v1/inbound/&lt;channel&gt;/&lt;workflow-slug&gt;</code>. When a vendor
                POSTs to that URL, the adapter verifies the signature and the workflow runs.
              </p>
              <p className="mb-2">
                For Twilio + WhatsApp Cloud, set <code>metadata.conversationAgentId</code> so the
                inbound message is recorded against an <code>AiConversation</code> row and{' '}
                <code>send_message_to_channel</code> knows where to reply.
              </p>
              <p>See the inbound-triggers.md doc for the per-channel quick-start.</p>
            </FieldHelp>
          </p>
        </div>
        <Button asChild>
          <Link href="/admin/orchestration/triggers/new">+ New trigger</Link>
        </Button>
      </div>

      {enabledChannels.length > 0 && (
        <div className="bg-muted/30 rounded-lg border p-3 text-xs">
          <span className="text-muted-foreground">Registered adapters in this deployment:</span>{' '}
          {enabledChannels.map((c) => (
            <code key={c} className="bg-background mx-1 rounded border px-1.5 py-0.5 font-mono">
              {c}
            </code>
          ))}
        </div>
      )}

      <TriggersTable triggers={triggers} enabledChannels={enabledChannels} />
    </div>
  );
}
