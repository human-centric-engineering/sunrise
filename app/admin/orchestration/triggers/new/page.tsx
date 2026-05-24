import type { Metadata } from 'next';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import {
  TriggerForm,
  type AgentOption,
  type WorkflowOption,
} from '@/components/admin/orchestration/trigger-form';
import { API } from '@/lib/api/endpoints';
import { getBaseUrl, parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';

export const metadata: Metadata = {
  title: 'New Inbound Trigger · AI Orchestration',
};

/**
 * Starter workflow definition seeded when the operator clicks "Create a
 * workflow" from the no-workflows-yet state on the trigger creation
 * page. Single `llm_call` step that reads the normalised inbound
 * trigger fields (`trigger.text`, `trigger.from`, `trigger.channel`) so
 * the operator lands in the workflow builder with a runnable shape
 * instead of an empty canvas.
 *
 * Encoded into a `?definition=` query param the workflow new page
 * already accepts (the advisor chatbot uses the same hand-off path).
 */
const INBOUND_TRIGGER_STARTER_DEFINITION = {
  entryStepId: 'respond_to_inbound',
  errorStrategy: 'fail' as const,
  steps: [
    {
      id: 'respond_to_inbound',
      name: 'Respond to inbound message',
      description:
        'Reads the normalised inbound trigger payload (text + sender) and asks the LLM to draft a reply. The trigger.* fields available depend on the channel: Twilio/WhatsApp populate trigger.text + trigger.from + trigger.subChannel; Slack populates trigger.text + trigger.user; Postmark populates trigger.textBody + trigger.from.email. To actually send the reply back on the same channel, add a tool_call step using the `send_message_to_channel` capability with `conversationId: {{trigger.conversationId}}` and `message: {{steps.respond_to_inbound.output}}` after binding the capability to an agent.',
      type: 'llm_call',
      config: {
        prompt:
          'A user sent us this inbound message:\n\n{{trigger.text}}\n\nFrom: {{trigger.from}}\nChannel: {{trigger.channel}}\n\nWrite a concise, helpful reply suitable for the channel (SMS: under 1600 chars; WhatsApp: under 4096; Slack: markdown OK).',
        temperature: 0.4,
      },
      nextSteps: [],
    },
  ],
};

const STARTER_DEFINITION_PARAM = encodeURIComponent(
  JSON.stringify(INBOUND_TRIGGER_STARTER_DEFINITION)
);
const NEW_WORKFLOW_HREF_WITH_STARTER = `/admin/orchestration/workflows/new?definition=${STARTER_DEFINITION_PARAM}`;

async function getWorkflows(): Promise<WorkflowOption[]> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.WORKFLOWS}?page=1&limit=200`);
    if (!res.ok) return [];
    const body = await parseApiResponse<WorkflowOption[]>(res);
    return body.success ? body.data : [];
  } catch (err) {
    logger.error('trigger new: workflows fetch failed', err);
    return [];
  }
}

async function getAgents(): Promise<AgentOption[]> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.AGENTS}?page=1&limit=200`);
    if (!res.ok) return [];
    const body = await parseApiResponse<AgentOption[]>(res);
    return body.success ? body.data : [];
  } catch (err) {
    logger.error('trigger new: agents fetch failed', err);
    return [];
  }
}

async function getEnabledChannels(): Promise<string[]> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.TRIGGERS}?page=1&limit=1`);
    if (!res.ok) return [];
    const body = await parseApiResponse<unknown>(res);
    if (
      body.success &&
      body.meta &&
      typeof body.meta === 'object' &&
      'enabledChannels' in body.meta
    ) {
      return (body.meta as { enabledChannels: string[] }).enabledChannels ?? [];
    }
    return [];
  } catch {
    return [];
  }
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
              <Link href={NEW_WORKFLOW_HREF_WITH_STARTER}>
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
          baseUrl={getBaseUrl()}
        />
      )}
    </div>
  );
}
