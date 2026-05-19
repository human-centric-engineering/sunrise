/**
 * Recipe 1: Customer Support Agent
 *
 * Patterns: Routing (2) + RAG (14) + Tool Use (5) + Human-in-the-Loop (13) + Guardrails (18).
 *
 * Flow: classify incoming request → route to self-serve or human branch →
 * retrieve help docs → search knowledge base via a registered tool → draft
 * a response → human approval before the message is sent. Both route
 * branches converge at the human-approval step so either path ends with a
 * reviewer in the loop.
 */

import type { WorkflowTemplate } from '@/prisma/seeds/data/templates/types';

export const CUSTOMER_SUPPORT_TEMPLATE: WorkflowTemplate = {
  slug: 'tpl-customer-support',
  name: 'Customer Support Agent',
  shortDescription:
    'Classifies an incoming support request, retrieves help docs, drafts a reply, and pauses for human review before sending.',
  patterns: [
    { number: 2, name: 'Routing' },
    { number: 5, name: 'Tool Use' },
    { number: 13, name: 'Human-in-the-Loop' },
    { number: 14, name: 'RAG' },
    { number: 18, name: 'Guardrails' },
  ],
  flowSummary:
    'An LLM classifies the inbound request, a Route step splits self-serve tickets from ones that need a human, the self-serve branch retrieves help docs and searches the knowledge base, an LLM drafts a response, and the whole pipeline pauses for human approval before anything is sent.',
  useCases: [
    {
      title: 'E-commerce returns processing',
      scenario:
        'Classify return requests by reason (damaged, wrong item, changed mind), retrieve return policy docs, draft a response with next steps, and require human approval before sending.',
    },
    {
      title: 'SaaS billing inquiries',
      scenario:
        'Triage billing questions vs. cancellation risks, pull account docs from the knowledge base, draft a personalised retention or resolution reply, and get team lead sign-off.',
    },
    {
      title: 'Healthcare patient portal',
      scenario:
        'Route patient messages (appointment, prescription, clinical), retrieve relevant care guidelines, draft a compliant response, and require clinician approval before replying.',
    },
  ],
  workflowDefinition: {
    entryStepId: 'classify',
    errorStrategy: 'fail',
    steps: [
      {
        id: 'classify',
        name: 'Classify intent',
        description:
          'Labels the inbound support request as billing, technical, account, or other so the triage step can pick the right path.',
        type: 'llm_call',
        config: {
          prompt:
            'Classify the customer support request below into one of: billing, technical, account, other.\n\nRequest:\n{{input}}\n\nReturn only the single-word category.',
          modelOverride: '',
          temperature: 0.2,
        },
        nextSteps: [{ targetStepId: 'triage' }],
      },
      {
        id: 'triage',
        name: 'Triage (self-serve vs human)',
        description:
          'Decides whether help-doc lookup can resolve the request (self-serve) or whether it goes straight to a human agent. Both paths converge at the approval step so every send has a reviewer in the loop.',
        type: 'route',
        config: {
          classificationPrompt:
            'Given the category and the original request, decide whether this can be resolved with self-serve help docs or needs a human support agent.',
          routes: [{ label: 'self_serve' }, { label: 'requires_human' }],
        },
        nextSteps: [
          { targetStepId: 'retrieve_docs', condition: 'self_serve' },
          { targetStepId: 'approve_send', condition: 'requires_human' },
        ],
      },
      {
        id: 'retrieve_docs',
        name: 'Retrieve help docs',
        description:
          'Vector-searches the knowledge base for the top 5 chunks relevant to the customer message (similarity threshold 0.7). Feeds the draft step so replies are grounded in real documentation.',
        type: 'rag_retrieve',
        config: {
          query: '{{input}}',
          topK: 5,
          similarityThreshold: 0.7,
        },
        nextSteps: [{ targetStepId: 'search_kb' }],
      },
      {
        id: 'search_kb',
        name: 'Search knowledge base',
        description:
          'Second knowledge-base lookup via the search_knowledge_base capability — supplements the RAG retrieve with citation-tagged chunks. Useful when the draft needs to attribute claims by [N] marker.',
        type: 'tool_call',
        config: {
          capabilitySlug: 'search_knowledge_base',
        },
        nextSteps: [{ targetStepId: 'draft_reply' }],
      },
      {
        id: 'draft_reply',
        name: 'Draft reply',
        description:
          'Composes a concise, helpful customer reply using the retrieved docs. Acknowledges the issue and lays out clear next steps; final wording is reviewed by a human before send.',
        type: 'llm_call',
        config: {
          prompt:
            'You are a helpful support agent. Draft a reply to the customer using the retrieved documentation. Be concise, acknowledge the issue, and give clear next steps.\n\nCustomer:\n{{input}}\n\nDocs:\n{{retrieve_docs.output}}',
          modelOverride: '',
          temperature: 0.5,
        },
        nextSteps: [{ targetStepId: 'approve_send' }],
      },
      {
        id: 'approve_send',
        name: 'Human approval before send',
        description:
          'Pauses the workflow for a support agent to review the drafted reply (or the escalated ticket) before anything reaches the customer. 60-minute timeout, in-app notification.',
        type: 'human_approval',
        config: {
          prompt:
            'Please review the drafted reply (or the escalated ticket) before it is sent to the customer.',
          timeoutMinutes: 60,
          notificationChannel: 'in-app',
        },
        nextSteps: [],
      },
    ],
  },
};
