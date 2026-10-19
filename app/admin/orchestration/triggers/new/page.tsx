import type { Metadata } from 'next';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import {
  TriggerForm,
  type AgentOption,
  type WorkflowOption,
} from '@/components/admin/orchestration/trigger-form';
import { WhatsAppWorkedExample } from '@/components/admin/orchestration/whatsapp-worked-example';
import { API } from '@/lib/api/endpoints';
import { getPublicUrl } from '@/lib/api/server-fetch';
import { requireAllServerData, requireServerData } from '@/lib/api/server-load';
import { INBOUND_TRIGGER_STARTER_HREF } from '@/lib/orchestration/admin/inbound-trigger-starter';
import { parseEnabledChannelsFromMeta } from '@/lib/orchestration/admin/trigger-meta';

export const metadata: Metadata = {
  title: 'New Inbound Trigger · AI Orchestration',
};

/**
 * All three are options the form cannot work honestly without, so each is
 * required and a failed load throws to the admin error boundary (#518). An
 * empty workflow list reads as "You need a workflow first"; an empty channel
 * list flags every adapter as unregistered; an empty agent list offers no
 * conversation agent for the channels that need one. The workflows and
 * agents are read across every page: a list cut short at 100 rows would
 * leave options out with nothing on screen to say so.
 */
async function getWorkflows(): Promise<WorkflowOption[]> {
  return requireAllServerData<WorkflowOption>(API.ADMIN.ORCHESTRATION.WORKFLOWS);
}

async function getAgents(): Promise<AgentOption[]> {
  return requireAllServerData<AgentOption>(API.ADMIN.ORCHESTRATION.AGENTS);
}

async function getEnabledChannels(): Promise<string[]> {
  const { meta } = await requireServerData<unknown>(
    `${API.ADMIN.ORCHESTRATION.TRIGGERS}?page=1&limit=1`
  );
  return parseEnabledChannelsFromMeta(meta);
}

export default async function NewTriggerPage() {
  const [workflows, agents, enabledChannels] = await Promise.all([
    getWorkflows(),
    getAgents(),
    getEnabledChannels(),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/orchestration/triggers"
          className="text-muted-foreground text-sm hover:underline"
        >
          ← Triggers
        </Link>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight">New trigger</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Configure how an external system fires a workflow.
        </p>
      </div>

      <WhatsAppWorkedExample />

      {workflows.length === 0 ? (
        <div className="bg-card space-y-4 rounded-lg border p-6 text-sm">
          <div>
            <h3 className="font-semibold">You need a workflow first</h3>
            <p className="text-muted-foreground mt-1">
              Every trigger fires exactly one workflow. The trigger holds the webhook URL config
              (channel, signing secret, event filter); the workflow holds the actual logic that runs
              when an inbound message arrives.
            </p>
          </div>

          <div className="text-muted-foreground bg-muted/40 rounded border p-3 text-xs">
            <div className="text-foreground mb-1.5 font-medium">Typical setup</div>
            <ol className="list-decimal space-y-1 pl-5">
              <li>
                Click <strong>Create a workflow (pre-filled for inbound)</strong> below. The builder
                opens with a single <code>llm_call</code> step already wired to read{' '}
                <code>trigger.text</code> + <code>trigger.from</code>, so the workflow is runnable
                the moment you publish it.
              </li>
              <li>Tweak the prompt or add steps (e.g. RAG, tool calls), then publish.</li>
              <li>
                Come back here to wire the webhook — pick the workflow + channel, paste the
                generated URL into Twilio / Slack / etc.
              </li>
              <li>
                To send actual replies back on the same channel, bind{' '}
                <code>send_message_to_channel</code> to an agent and add a <code>tool_call</code>{' '}
                step that invokes it with the LLM&apos;s output.
              </li>
            </ol>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link href={INBOUND_TRIGGER_STARTER_HREF}>
                Create a workflow (pre-filled for inbound)
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/admin/orchestration/workflows/new">Start blank instead</Link>
            </Button>
            <Button asChild variant="ghost">
              <Link href="/admin/orchestration/triggers">← Back to triggers</Link>
            </Button>
          </div>
        </div>
      ) : (
        <TriggerForm
          mode="create"
          workflows={workflows}
          agents={agents}
          enabledChannels={enabledChannels}
          baseUrl={getPublicUrl()}
        />
      )}
    </div>
  );
}
