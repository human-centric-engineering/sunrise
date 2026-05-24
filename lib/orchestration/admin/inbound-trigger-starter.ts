/**
 * Starter workflow definition used when an admin clicks
 * "Create a workflow (pre-filled for inbound)" from the no-workflows-yet
 * state on `/admin/orchestration/triggers/new`.
 *
 * Encoded into the `?definition=` URL param the new-workflow page
 * already accepts (the advisor chatbot uses the same hand-off path).
 *
 * The single `chat_turn` step loads prior `AiMessage` rows for the
 * inbound conversation (so multi-turn context survives across runs)
 * and dispatches the new user message through the named agent. The
 * operator must edit `agentSlug` to point at one of their agents
 * before publishing — the placeholder `''` will fail validation at
 * publish time with a clear error.
 *
 * Lives in its own module (not inline on the page component) so the
 * shape is importable by tests — the workflow new page silently falls
 * back to an empty builder when the encoded definition fails schema
 * validation, so a regression test asserts this constant parses clean.
 *
 * Field constraints to mind when editing:
 *   - Step `description` is capped at 500 chars by `workflowStepSchema`.
 *     Keep it short.
 *   - Field names referenced in `message` must match what the inbound
 *     adapters set on `NormalisedTriggerPayload.payload`. Twilio + WA
 *     Cloud set `text` / `from` / `channel`; Slack sets `text` /
 *     `user`; Postmark sets `textBody` / `from.email`. The starter
 *     uses the most cross-channel-compatible subset.
 *   - `conversationId` defaults to `{{trigger.conversationId}}` which
 *     the inbound route's `resolveConversation` always populates for
 *     Twilio / WhatsApp Cloud. Slack / generic HMAC don't populate it
 *     — operators on those channels should either change the starter
 *     to `llm_call` or create the conversation themselves before
 *     calling `chat_turn`.
 */

import type { WorkflowDefinition } from '@/types/orchestration';

export const INBOUND_TRIGGER_STARTER_DEFINITION: WorkflowDefinition = {
  entryStepId: 'respond_to_inbound',
  errorStrategy: 'fail',
  steps: [
    {
      id: 'respond_to_inbound',
      name: 'Respond to inbound message',
      description:
        'Loads prior turns of the conversation so the agent sees what the user said earlier, then drafts a reply. Edit `agentSlug` to point at one of your agents before publishing. To send the reply back on the same channel, add a tool_call step after using `send_message_to_channel`.',
      type: 'chat_turn',
      config: {
        agentSlug: '',
        conversationId: '{{trigger.conversationId}}',
        message: '{{trigger.text}}',
        historyLimit: 20,
        persistMessages: true,
        temperature: 0.4,
      },
      nextSteps: [],
    },
  ],
};

/**
 * Encoded URL pointing the workflow builder at the starter definition.
 * Use this in the trigger admin page CTA.
 */
export const INBOUND_TRIGGER_STARTER_HREF = `/admin/orchestration/workflows/new?definition=${encodeURIComponent(
  JSON.stringify(INBOUND_TRIGGER_STARTER_DEFINITION)
)}`;
