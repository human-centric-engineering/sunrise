/**
 * Recipe 12: Scheduled Source Monitor
 *
 * Patterns: Routing (2) + External Call (15) + Evaluation & Monitoring (19).
 *
 * Flow: an External Call fetches a watched source on a schedule → an LLM
 * Call categorises the change against a brief stored description of the
 * previous snapshot → a Route step branches on the change tier → on
 * `material` the workflow fires a Send Notification; on `minor` or `none`
 * it records a quiet log entry. The operator wires the actual schedule
 * (cron expression) and recipient address on the AiWorkflow row after
 * cloning the template.
 *
 * Showcases: scheduled / asynchronous workflow execution (PR #140) for
 * "watch a thing, alert when it changes" patterns. Suitable for tracking
 * lender criteria, regulatory updates, supply-chain advisories, council
 * commitments, vendor pricing pages, and similar slow-moving sources.
 */

import type { WorkflowTemplate } from '@/prisma/seeds/data/templates/types';

export const SCHEDULED_SOURCE_MONITOR_TEMPLATE: WorkflowTemplate = {
  slug: 'tpl-scheduled-source-monitor',
  name: 'Scheduled Source Monitor',
  shortDescription:
    'On a schedule, fetches a watched source, categorises the change against the previous snapshot, and notifies on material changes.',
  patterns: [
    { number: 2, name: 'Routing' },
    { number: 15, name: 'External Call' },
    { number: 19, name: 'Evaluation & Monitoring' },
  ],
  flowSummary:
    'An External Call fetches the monitored source. An LLM Call diffs the response against the previous snapshot supplied via {{input}} and classifies the change as "material", "minor", or "none". A Route step branches on that tier — material changes trigger a Send Notification; minor and no changes are recorded via a short log step so the run history captures every tick.',
  useCases: [
    {
      title: 'Mortgage broker — lender criteria tracking',
      scenario:
        'Daily check of a lender criteria page or feed. Categorise self-employment / income-multiple / LTV changes against the last snapshot and notify the broker only when terms shift materially. Avoids the "did anything change today?" inbox-skim.',
    },
    {
      title: 'Supply-chain disruption monitoring',
      scenario:
        'Hourly check of a supplier status feed or shipping-route advisory. Categorise outages, lane closures, or material delays against last hour and notify the operations channel only on material disruption.',
    },
    {
      title: 'Regulatory change detection',
      scenario:
        'Weekly check of a regulator publication index or rule page. Categorise the diff (substantive amendment, editorial correction, no change) and notify the compliance lead only on substantive amendments.',
    },
    {
      title: 'Council commitment accountability',
      scenario:
        'Weekly check of a council pledge / spending tracker page. Categorise progress against the last snapshot (commitment moved, broken, on track) and notify the journalist or campaigner contact only when a commitment changes state.',
    },
  ],
  workflowDefinition: {
    entryStepId: 'fetch_source',
    errorStrategy: 'fail',
    steps: [
      {
        id: 'fetch_source',
        name: 'Fetch monitored source',
        type: 'external_call',
        config: {
          url: 'https://example.invalid/source',
          method: 'GET',
          headers: { Accept: 'text/html, application/json;q=0.9' },
          timeoutMs: 15000,
          authType: 'none',
        },
        nextSteps: [{ targetStepId: 'categorise_change' }],
      },
      {
        id: 'categorise_change',
        name: 'Categorise change vs. previous snapshot',
        type: 'llm_call',
        config: {
          prompt:
            'You are tracking changes to a monitored source. Compare the freshly fetched response to the previous snapshot supplied as input and classify the change as "material" (a substantive change a stakeholder needs to know about), "minor" (trivial editorial / formatting / unrelated content), or "none" (no meaningful difference). Return a short JSON object: {"tier": "material" | "minor" | "none", "summary": "one sentence summary of what changed"}.\n\nPrevious snapshot:\n{{input}}\n\nFreshly fetched response:\n{{fetch_source.output}}',
          modelOverride: '',
          temperature: 0.2,
        },
        nextSteps: [{ targetStepId: 'route_change' }],
      },
      {
        id: 'route_change',
        name: 'Route on change tier',
        type: 'route',
        config: {
          classificationPrompt:
            'Read the change classification from the previous step and route on the "tier" field: "material" if material, "minor" if minor, "none" if no change.',
          routes: [{ label: 'material' }, { label: 'minor' }, { label: 'none' }],
        },
        nextSteps: [
          { targetStepId: 'notify_change', condition: 'material' },
          { targetStepId: 'record_quiet_tick', condition: 'minor' },
          { targetStepId: 'record_quiet_tick', condition: 'none' },
        ],
      },
      {
        id: 'notify_change',
        name: 'Notify on material change',
        type: 'send_notification',
        config: {
          channel: 'email',
          to: 'alerts@example.invalid',
          subject: 'Monitored source changed materially',
          bodyTemplate:
            'A scheduled source monitor detected a material change.\n\nChange summary:\n{{categorise_change.output}}\n\n---\nView the full execution trace in the admin dashboard.',
        },
        nextSteps: [],
      },
      {
        id: 'record_quiet_tick',
        name: 'Record quiet tick',
        type: 'llm_call',
        config: {
          prompt:
            'Write one short sentence for the run log noting that this tick observed no material change. Include the change tier and the one-line summary from the previous step.\n\nClassification:\n{{categorise_change.output}}',
          modelOverride: '',
          temperature: 0.1,
        },
        nextSteps: [],
      },
    ],
  },
};
