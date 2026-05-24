'use client';

/**
 * TriggersTable — admin list view for AiWorkflowTrigger rows.
 *
 * Shows channel + name + workflow + enabled state + lastFiredAt for each
 * trigger, with a per-row webhook URL the operator copies into the
 * vendor's webhook config. Adapters that are not currently registered
 * (env vars unset) get a warning chip so operators see the trigger is
 * inert until the env is wired.
 */

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { logger } from '@/lib/logging';

export interface TriggerWorkflow {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
}

export interface TriggerListItem {
  id: string;
  channel: string;
  name: string;
  workflowId: string;
  metadata: Record<string, unknown> | null;
  isEnabled: boolean;
  hasSigningSecret: boolean;
  lastFiredAt: string | null;
  createdAt: string;
  workflow: TriggerWorkflow;
}

interface Props {
  triggers: TriggerListItem[];
  enabledChannels: string[];
}

export function TriggersTable({ triggers, enabledChannels }: Props) {
  const router = useRouter();
  const [deletingId, setDeletingId] = useState<string | null>(null);

  if (triggers.length === 0) {
    return (
      <div className="bg-card space-y-6 rounded-lg border p-8">
        <div className="text-center">
          <h3 className="text-lg font-semibold">No inbound triggers yet</h3>
          <p className="text-muted-foreground mx-auto mt-2 max-w-2xl text-sm">
            A <strong>trigger</strong> is a webhook URL on this server that fires one of your
            workflows. When an external system (Twilio, Slack, Postmark, Meta) POSTs to that URL,
            Sunrise verifies the signature and starts a new execution of the workflow.
          </p>
        </div>

        {/* Concept diagram */}
        <div className="bg-muted/40 mx-auto max-w-2xl rounded-md border p-4 text-xs">
          <div className="text-muted-foreground mb-2 font-medium">How it works</div>
          <ol className="list-decimal space-y-1.5 pl-5">
            <li>
              You pick a <strong>workflow</strong> to fire and a <strong>channel</strong> (the
              vendor protocol — slack / twilio / etc.).
            </li>
            <li>
              We give you a webhook URL like{' '}
              <code className="bg-background rounded border px-1 py-0.5">
                /api/v1/inbound/twilio/your-workflow-slug
              </code>
              .
            </li>
            <li>
              You paste that URL into the vendor&apos;s webhook config (Twilio Console, Meta App
              Dashboard, Slack Event Subscriptions, etc.).
            </li>
            <li>
              Every inbound message becomes an <code>AiWorkflowExecution</code> row with the
              normalised payload. Conversations from SMS / WhatsApp also create{' '}
              <code>AiConversation</code> rows so the agent can reply on the same channel via{' '}
              <code>send_message_to_channel</code>.
            </li>
          </ol>
        </div>

        {/* Channel options */}
        <div className="text-muted-foreground mx-auto max-w-2xl text-xs">
          <div className="mb-2 font-medium">Channels available out of the box</div>
          <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            <li>
              <code className="bg-muted rounded px-1 py-0.5">twilio</code> — SMS + Twilio-routed
              WhatsApp
            </li>
            <li>
              <code className="bg-muted rounded px-1 py-0.5">whatsapp_cloud</code> — Meta WhatsApp
              direct
            </li>
            <li>
              <code className="bg-muted rounded px-1 py-0.5">slack</code> — Slack Events API
            </li>
            <li>
              <code className="bg-muted rounded px-1 py-0.5">postmark</code> — inbound email parse
            </li>
            <li>
              <code className="bg-muted rounded px-1 py-0.5">hmac</code> — generic signed JSON
            </li>
          </ul>
          {enabledChannels.length > 0 && (
            <p className="mt-2">
              Currently registered in this deployment:{' '}
              {enabledChannels.map((c) => (
                <code key={c} className="bg-background mx-0.5 rounded border px-1 py-0.5">
                  {c}
                </code>
              ))}
              . Channels without their env vars set show as <em>adapter not registered</em> in the
              form, and inbound POSTs will 404 until you wire them up.
            </p>
          )}
        </div>

        <div className="flex justify-center">
          <Button asChild>
            <Link href="/admin/orchestration/triggers/new">Create your first trigger</Link>
          </Button>
        </div>
      </div>
    );
  }

  async function handleDelete(id: string, name: string) {
    if (
      !confirm(`Delete trigger "${name}"? Vendors calling its webhook URL will start getting 404s.`)
    ) {
      return;
    }
    setDeletingId(id);
    try {
      await apiClient.delete(API.ADMIN.ORCHESTRATION.triggerById(id));
      router.refresh();
    } catch (err) {
      logger.error('triggers-table: delete failed', err);
      alert(`Failed to delete: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-muted-foreground text-xs tracking-wide uppercase">
          <tr>
            <th className="px-4 py-3 text-left font-medium">Channel</th>
            <th className="px-4 py-3 text-left font-medium">Name</th>
            <th className="px-4 py-3 text-left font-medium">Workflow</th>
            <th className="px-4 py-3 text-left font-medium">Webhook URL</th>
            <th className="px-4 py-3 text-left font-medium">Status</th>
            <th className="px-4 py-3 text-left font-medium">Last fired</th>
            <th className="px-4 py-3 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {triggers.map((t) => {
            const adapterRegistered = enabledChannels.includes(t.channel);
            const webhookPath = `/api/v1/inbound/${t.channel}/${t.workflow.slug}`;
            return (
              <tr key={t.id} className="hover:bg-muted/30">
                <td className="px-4 py-3">
                  <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">
                    {t.channel}
                  </code>
                  {!adapterRegistered && (
                    <div className="mt-1">
                      <Badge variant="destructive" className="text-[10px]">
                        adapter not registered
                      </Badge>
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 font-medium">{t.name}</td>
                <td className="px-4 py-3">
                  <Link
                    href={`/admin/orchestration/workflows/${t.workflowId}`}
                    className="text-primary hover:underline"
                  >
                    {t.workflow.name}
                  </Link>
                  {!t.workflow.isActive && (
                    <Badge variant="outline" className="ml-2 text-[10px]">
                      inactive
                    </Badge>
                  )}
                </td>
                <td className="px-4 py-3">
                  <code className="bg-muted block max-w-xs truncate rounded px-1.5 py-0.5 font-mono text-xs">
                    {webhookPath}
                  </code>
                </td>
                <td className="px-4 py-3">
                  {t.isEnabled ? (
                    <Badge variant="default">enabled</Badge>
                  ) : (
                    <Badge variant="secondary">disabled</Badge>
                  )}
                  {t.hasSigningSecret && (
                    <div className="mt-1">
                      <Badge variant="outline" className="text-[10px]">
                        per-trigger secret
                      </Badge>
                    </div>
                  )}
                </td>
                <td className="text-muted-foreground px-4 py-3 text-xs">
                  {t.lastFiredAt ? new Date(t.lastFiredAt).toLocaleString() : '—'}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex justify-end gap-2">
                    <Button asChild variant="ghost" size="sm">
                      <Link href={`/admin/orchestration/triggers/${t.id}`}>Edit</Link>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={deletingId === t.id}
                      onClick={() => {
                        void handleDelete(t.id, t.name);
                      }}
                    >
                      {deletingId === t.id ? 'Deleting…' : 'Delete'}
                    </Button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
