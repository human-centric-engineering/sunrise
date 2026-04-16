/**
 * Recipe 7: Multi-Channel Outreach with Safety
 *
 * Patterns: Guardrails (18) + Routing (2) + Inter-Agent Communication (15)
 * + Evaluation (19) + Human-in-the-Loop (13).
 *
 * Flow: screen the outreach request against compliance rules → route to
 * the appropriate channel (email / SMS / webhook) → draft content →
 * evaluate quality → human-approve before sending. The guard step blocks
 * non-compliant requests entirely; the webhook branch skips the
 * draft/evaluate/approve flow and fires directly.
 *
 * Showcases: guard (compliance gate), route (channel selection),
 * external_call (webhook delivery), evaluate (quality scoring),
 * human_approval (send gate).
 */

import type { WorkflowTemplate } from './types';

export const OUTREACH_SAFETY_TEMPLATE: WorkflowTemplate = {
  slug: 'tpl-outreach-safety',
  name: 'Multi-Channel Outreach with Safety',
  shortDescription:
    'Screens outreach requests for compliance, routes to the right channel, drafts and scores content, and requires human approval before sending.',
  patterns: [
    { number: 2, name: 'Routing' },
    { number: 13, name: 'Human-in-the-Loop' },
    { number: 15, name: 'Inter-Agent Communication' },
    { number: 18, name: 'Guardrails' },
    { number: 19, name: 'Evaluation & Monitoring' },
  ],
  flowSummary:
    'A Guard step screens the outreach request against compliance and opt-out rules, blocking non-compliant requests. A Route step classifies the channel (email, SMS, or webhook). Email and SMS branches draft personalised content via LLM, score it with an Evaluate step, then pause for Human Approval. The webhook branch fires an External Call directly.',
  useCases: [
    {
      title: 'Sales outreach compliance',
      scenario:
        'Screen outreach requests against opt-out lists and regulatory rules, route to the appropriate channel, draft personalised messages, score quality, and get human sign-off before sending.',
    },
    {
      title: 'Customer notification system',
      scenario:
        'Guard against sending to suppressed or bounced addresses, route by notification urgency (email for low, SMS for high, webhook for system-to-system), evaluate tone and clarity, and require approval for customer-facing sends.',
    },
    {
      title: 'Recruitment pipeline',
      scenario:
        'Guard candidate communications against bias rules, route by stage (email for initial outreach, SMS for interview reminders, webhook for ATS updates), evaluate professionalism, and human-approve before sending.',
    },
  ],
  workflowDefinition: {
    entryStepId: 'screen_request',
    errorStrategy: 'fail',
    steps: [
      {
        id: 'screen_request',
        name: 'Compliance screening',
        type: 'guard',
        config: {
          rules:
            'Block this outreach if the recipient is on the opt-out list, the message contains misleading claims, or the request violates GDPR/CAN-SPAM rules. Also block if the recipient address is missing or malformed.',
          mode: 'llm',
          failAction: 'block',
          temperature: 0.1,
        },
        nextSteps: [
          { targetStepId: 'classify_channel', condition: 'pass' },
          { targetStepId: 'rejection_notice', condition: 'fail' },
        ],
      },
      {
        id: 'rejection_notice',
        name: 'Generate rejection notice',
        type: 'llm_call',
        config: {
          prompt:
            'The outreach request was blocked by compliance screening. Write a brief internal notice explaining why and what rule was triggered.\n\nScreening result:\n{{screen_request.output}}',
          modelOverride: '',
          temperature: 0.2,
        },
        nextSteps: [],
      },
      {
        id: 'classify_channel',
        name: 'Route to channel',
        type: 'route',
        config: {
          classificationPrompt:
            'Based on the outreach request, determine the best delivery channel: "email" for standard communications, "sms" for urgent or time-sensitive messages, "webhook" for system-to-system notifications.',
          routes: [{ label: 'email' }, { label: 'sms' }, { label: 'webhook' }],
        },
        nextSteps: [
          { targetStepId: 'draft_email', condition: 'email' },
          { targetStepId: 'draft_sms', condition: 'sms' },
          { targetStepId: 'send_webhook', condition: 'webhook' },
        ],
      },
      {
        id: 'draft_email',
        name: 'Draft email content',
        type: 'llm_call',
        config: {
          prompt:
            'Draft a professional email for the following outreach request. Include a clear subject line, greeting, body, and call to action. Keep it concise and on-brand.\n\nRequest:\n{{input}}',
          modelOverride: '',
          temperature: 0.6,
        },
        nextSteps: [{ targetStepId: 'score_draft' }],
      },
      {
        id: 'draft_sms',
        name: 'Draft SMS content',
        type: 'llm_call',
        config: {
          prompt:
            'Draft an SMS message (max 160 characters) for the following outreach request. Be direct and include a clear action.\n\nRequest:\n{{input}}',
          modelOverride: '',
          temperature: 0.5,
        },
        nextSteps: [{ targetStepId: 'score_draft' }],
      },
      {
        id: 'send_webhook',
        name: 'Send webhook notification',
        type: 'external_call',
        config: {
          url: 'https://api.example.com/webhooks/notify',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          bodyTemplate: '{"event": "outreach", "payload": {{input}}}',
          timeoutMs: 10000,
          authType: 'bearer',
          authSecret: 'WEBHOOK_API_TOKEN',
        },
        nextSteps: [],
      },
      {
        id: 'score_draft',
        name: 'Score draft quality',
        type: 'evaluate',
        config: {
          rubric:
            'Rate the drafted message on clarity (is the purpose obvious?), professionalism (appropriate tone?), and compliance (no misleading claims, includes required disclosures?). Score from 1 to 10.',
          scaleMin: 1,
          scaleMax: 10,
          threshold: 6,
          temperature: 0.2,
        },
        nextSteps: [{ targetStepId: 'approve_send' }],
      },
      {
        id: 'approve_send',
        name: 'Approve before sending',
        type: 'human_approval',
        config: {
          prompt:
            'Review the drafted outreach message and its quality score before it is sent to the recipient.',
          timeoutMinutes: 60,
          notificationChannel: 'in-app',
        },
        nextSteps: [],
      },
    ],
  },
};
