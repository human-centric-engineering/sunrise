/**
 * Recipe 12: Inbound Conversation Handler
 *
 * Patterns: Memory Management (8) + Tool Use (5).
 *
 * The minimum-viable end-to-end SMS / WhatsApp / messaging handler.
 * Two steps:
 *   1. `chat_turn` — loads prior `AiMessage` rows for the inbound
 *      conversation (history-aware) and asks the agent to draft a reply.
 *   2. `tool_call` invoking `send_message_to_channel` — dispatches the
 *      reply back on the same channel the inbound came in on.
 *
 * Multi-turn memory works out of the box: every subsequent inbound on
 * the same `(channel, fromAddress)` finds the same `AiConversation` row,
 * and `chat_turn` reads the prior turns into the LLM context.
 *
 * Showcases: the new `chat_turn` step type (loads history; persists
 * turns; bridges the parity gap between the streaming chat handler and
 * the workflow engine). Pairs with item #24's inbound-trigger framework
 * — a Twilio or Meta webhook fires this workflow with `inputData.trigger`
 * populated from the normalised adapter payload.
 *
 * Preconditions before publish:
 *   - Edit `chat_turn.agentSlug` to point at one of your agents.
 *   - Bind `send_message_to_channel` to that same agent with a
 *     `providers` block for whichever vendor(s) you support (Twilio,
 *     Meta). See `.context/orchestration/recipes/sms-whatsapp-inbound-reply.md`.
 *   - Create an `AiWorkflowTrigger` for the channel and put its
 *     metadata.conversationAgentId on the same agent so the inbound
 *     route's resolver populates `triggerMeta.conversationId` for this
 *     workflow's `{{trigger.conversationId}}` interpolation.
 */

import type { WorkflowTemplate } from '@/prisma/seeds/data/templates/types';

export const INBOUND_CONVERSATION_HANDLER_TEMPLATE: WorkflowTemplate = {
  slug: 'tpl-inbound-conversation-handler',
  name: 'Inbound Conversation Handler',
  shortDescription:
    'Receives a webhook-driven inbound message (SMS / WhatsApp / future messaging channels), drafts a reply with full multi-turn conversation memory, and dispatches it back on the same channel.',
  patterns: [
    { number: 5, name: 'Tool Use' },
    { number: 8, name: 'Memory Management' },
  ],
  flowSummary:
    'A chat_turn step loads prior AiMessage rows for the inbound conversation (so the agent sees what the user said earlier) and asks the agent to draft a reply with full history context. A tool_call step then invokes the send_message_to_channel capability with the resolved conversationId and the LLM output, dispatching the reply back on whichever channel the inbound came in on (Twilio SMS / WhatsApp, Meta WhatsApp Cloud, future Vonage / MessageBird / ...).',
  useCases: [
    {
      title: 'Customer support over WhatsApp',
      scenario:
        'Customers message your Meta WhatsApp business number with questions about orders, returns, or product help. Each inbound fires this workflow; the agent sees the full conversation history (previous order numbers mentioned, prior context) and replies on the same WhatsApp thread.',
    },
    {
      title: 'SMS intake for service desks',
      scenario:
        'Citizens text a council service number to report issues. The workflow recognises returning numbers, loads their history (previous reports, follow-up status), drafts a personalised reply, and dispatches via Twilio SMS — without the citizen ever needing to log in or sign up.',
    },
    {
      title: 'Multi-turn appointment confirmation flows',
      scenario:
        'Send an initial outreach via send_message_to_channel; this workflow then handles the inbound replies ("yes, confirm" / "can we reschedule for Thursday?") with full memory of the original appointment, so the agent never re-asks for context the user has already provided.',
    },
    {
      title: 'Mutual-aid coordination',
      scenario:
        'Volunteers and beneficiaries communicate over WhatsApp because it is where they already live. The workflow tracks each conversation thread per number, ensuring the volunteer-side agent always knows what the beneficiary asked last week before drafting the next reply.',
    },
  ],
  workflowDefinition: {
    entryStepId: 'respond_to_inbound',
    errorStrategy: 'fail',
    steps: [
      {
        id: 'respond_to_inbound',
        name: 'Respond with conversation memory',
        description:
          'Loads prior AiMessage rows for the conversation (chat_turn reads conversationId from triggerMeta), composes [system, ...history, user] and asks the agent to draft a reply. The new user + assistant turns are persisted so the next inbound on this conversation inherits them.',
        type: 'chat_turn',
        config: {
          agentSlug: '',
          conversationId: '{{trigger.conversationId}}',
          message: '{{trigger.text}}',
          historyLimit: 20,
          persistMessages: true,
          temperature: 0.4,
        },
        nextSteps: [{ targetStepId: 'send_reply' }],
      },
      {
        id: 'send_reply',
        name: 'Send reply on the same channel',
        description:
          'Invokes the send_message_to_channel capability. The capability looks up AiConversation.(channel, provider, fromAddress) from the conversationId, resolves the outbound adapter (Twilio / Meta / future provider), enforces guards (STOP-flag, WhatsApp 24h window, length cap, throttle, idempotency), and dispatches via the vendor API. Returns the vendor transactionId on success or a typed error code on guard failure.',
        type: 'tool_call',
        config: {
          capabilitySlug: 'send_message_to_channel',
          args: {
            conversationId: '{{trigger.conversationId}}',
            message: '{{respond_to_inbound.output}}',
          },
        },
        nextSteps: [],
      },
    ],
  },
};
