/**
 * The event-notification email (`emails/event-notification.tsx`): one
 * template for every event a subscription can send, its subject line, and
 * the summary sentence each event gets, from the catalogue (§138 t-1075).
 */

import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import EventNotification, { eventNotificationSubject } from '@/emails/event-notification';
import { BRAND } from '@/lib/brand';

const WHEN = '2026-11-20T10:00:00Z';

async function text(event: string, data: Record<string, unknown>, timestamp = WHEN) {
  return render(EventNotification({ event, timestamp, data }), {
    plainText: true,
    htmlToTextOptions: { wordwrap: false },
  });
}

describe('the summary sentence', () => {
  it.each([
    ['budget_exceeded', { agentName: 'Helper' }, 'Agent “Helper” reached its monthly budget.'],
    ['budget_exceeded', {}, 'An agent reached its monthly budget.'],
    [
      'workflow_failed',
      { workflowName: 'Sync', error: 'Timeout' },
      'Workflow “Sync” failed: Timeout',
    ],
    ['workflow_failed', { workflowSlug: 'sync' }, 'Workflow “sync” failed.'],
    ['workflow_failed', { error: 'Timeout' }, 'A workflow failed: Timeout'],
    ['workflow_failed', {}, 'A workflow failed.'],
    [
      'approval_required',
      { workflowName: 'Sync' },
      'Workflow “Sync” is paused and needs approval.',
    ],
    ['approval_required', {}, 'A workflow is paused and needs approval.'],
    [
      'circuit_breaker_opened',
      { providerSlug: 'openai' },
      'The circuit breaker for provider “openai” has tripped open.',
    ],
    ['circuit_breaker_opened', {}, 'A provider circuit breaker has tripped open.'],
    [
      'agent_updated',
      { agentName: 'Helper', actorUserName: 'Ada' },
      'Agent “Helper” was updated by Ada.',
    ],
    ['agent_updated', { agentName: 'Helper' }, 'Agent “Helper” was updated.'],
    ['agent_updated', { actorUserId: 'u-1' }, 'An agent was updated by u-1.'],
    ['agent_updated', {}, 'An agent was updated.'],
    [
      'execution_crashed',
      { workflowName: 'Sync', error: 'OOM' },
      'Workflow “Sync” crashed mid-execution: OOM',
    ],
    ['execution_crashed', { workflowName: 'Sync' }, 'Workflow “Sync” crashed mid-execution.'],
    ['execution_crashed', { error: 'OOM' }, 'A workflow execution crashed: OOM'],
    ['execution_crashed', {}, 'A workflow execution crashed.'],
    ['some_new_event', {}, 'Event “some_new_event” fired.'],
  ])('%s with %j', async (event, data, sentence) => {
    expect(await text(event, data)).toContain(sentence);
  });
});

describe('the rest of the email', () => {
  it('titles a known event, and names an unknown one by its wire name', async () => {
    expect(await text('budget_exceeded', {})).toMatch(/^Budget exceeded/);
    expect(await text('order.shipped_late', {})).toMatch(/^Order Shipped Late/);
  });

  it('dates it in the recipient’s zone, and shows a timestamp that does not parse as it came', async () => {
    expect(await text('budget_exceeded', {})).toContain(
      `${BRAND.name} · Nov 20, 2026, 10:00 AM UTC`
    );
    expect(await text('budget_exceeded', {}, 'not-a-date')).toContain(`${BRAND.name} · not-a-date`);
  });

  it('shows approve and reject buttons only for the links it is given', async () => {
    const both = await text('approval_required', {
      approveUrl: 'https://example.test/a',
      rejectUrl: 'https://example.test/r',
    });
    expect(both).toContain('Approve');
    expect(both).toContain('Reject');
    const none = await text('approval_required', {});
    expect(none).not.toMatch(/\bApprove\b/);
  });

  it('lists the payload’s fields as the event names them, and leaves out empty ones', async () => {
    const out = await text('agent_updated', {
      agentName: 'Helper',
      retries: 3,
      paused: false,
      tags: ['a'],
      gone: null,
    });
    expect(out).toContain('Agent name\nHelper');
    expect(out).toContain('Retries\n3');
    expect(out).toContain('Paused\nfalse');
    expect(out).toContain('Tags\n["a"]');
    expect(out).not.toContain('Gone');
  });

  it('shows what changed, from and to', async () => {
    const out = await text('agent_updated', {
      changes: { model: { from: 'a', to: 'b' }, temperature: { from: null, to: 0.2 } },
    });
    expect(out).toContain('Changes');
    expect(out).toContain('a → b');
    expect(out).toContain('— → 0.2');
  });

  it('ignores a changes field that is not from/to pairs', async () => {
    const out = await text('agent_updated', { changes: { model: 'b' } });
    expect(out).not.toContain('→');
  });

  it('says which subscription it came from', async () => {
    expect(await text('budget_exceeded', {})).toContain(
      `You're receiving this because you subscribed to budget_exceeded via ${BRAND.name} event subscriptions`
    );
  });
});

describe('eventNotificationSubject', () => {
  it('names the event and what it is about', () => {
    expect(eventNotificationSubject('budget_exceeded', { agentName: 'Helper' })).toBe(
      `[${BRAND.name}] Budget exceeded · Helper`
    );
    expect(eventNotificationSubject('workflow_failed', { workflowName: 'Sync' })).toBe(
      `[${BRAND.name}] Workflow failed · Sync`
    );
    expect(eventNotificationSubject('circuit_breaker_opened', { providerSlug: 'openai' })).toBe(
      `[${BRAND.name}] Provider circuit breaker opened · openai`
    );
  });

  it('names an event with no title of its own by its wire name', () => {
    expect(eventNotificationSubject('order_shipped', {})).toBe(
      `[${BRAND.name}] ${BRAND.name} event: order_shipped`
    );
  });
});
