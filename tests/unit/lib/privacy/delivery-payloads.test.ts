/**
 * Unit tests for lib/privacy/delivery-payloads.ts (t-783).
 *
 * The raw-SQL JSON-containment matching is proven against real Postgres by
 * scripts/smoke/erasure-deliveries.ts. This layer covers the pure payload
 * redaction / subject-view logic and the shape of the statements issued.
 *
 * @see lib/privacy/delivery-payloads.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { isStoppedByErasure } from '@/lib/orchestration/webhooks/not-retried';
import {
  ADMIN_ACTION_EVENTS,
  EVENT_RECORD_KEYS,
  byCreatedAtThenId,
  deliveriesNamingSubject,
  eraseSubjectFromDeliveries,
  erasedPayload,
  subjectViewOfPayload,
  type RawClient,
} from '@/lib/privacy/delivery-payloads';

const SUBJECT = 'user-subject';
const OTHER = 'user-other';
const EVENT = 'conversation.started';

/** Render a tagged-template call as the SQL text Prisma would send plus its bound values. */
function render(
  strings: TemplateStringsArray,
  values: unknown[]
): { text: string; values: unknown[] } {
  const sql = Prisma.sql(strings, ...values);
  return { text: sql.text, values: sql.values };
}

interface RawRow {
  id: string;
  eventType: string;
  status: string;
  lastError: string | null;
  lastAttemptAt: Date | null;
  createdAt: Date;
  payload: Prisma.JsonValue;
  activity: boolean;
}

function row(overrides: Partial<RawRow> & { id: string }): RawRow {
  return {
    eventType: 'conversation.started',
    status: 'delivered',
    lastError: null,
    lastAttemptAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    payload: { event: 'x', data: { userId: SUBJECT } },
    activity: true,
    ...overrides,
  };
}

function makeClient(rows: RawRow[]) {
  const queryRaw = vi.fn(async (..._args: unknown[]) => rows);
  const executeRaw = vi.fn(async (..._args: unknown[]) => 1);
  // Module-edge fake: only the two raw methods the module uses.
  const client = { $queryRaw: queryRaw, $executeRaw: executeRaw } as unknown as RawClient;
  return { client, queryRaw, executeRaw };
}

/** The `[strings, ...values]` of the nth call to a tagged-template mock. */
function renderCall(mock: ReturnType<typeof vi.fn>, n = 0) {
  const [strings, ...values] = mock.mock.calls[n] as [TemplateStringsArray, ...unknown[]];
  return render(strings, values);
}

describe('erasedPayload', () => {
  describe('activity basis', () => {
    it('keeps only EVENT_RECORD_KEYS and person keys, dropping free-text and unknown keys', () => {
      const payload = {
        event: 'conversation.started',
        timestamp: '2026-01-01T00:00:00Z',
        data: {
          conversationId: 'c1',
          agentSlug: 'support',
          costUsd: 0.12,
          reason: 'my private reason',
          metadata: { note: 'secret' },
          prompt: 'approve my thing',
          body: 'hello',
          changes: { a: 1 },
          forkOwnKey: 'fork data',
        },
      };

      const result = erasedPayload(payload, 'activity', SUBJECT);

      expect(result).toEqual({
        event: 'conversation.started',
        timestamp: '2026-01-01T00:00:00Z',
        data: { conversationId: 'c1', agentSlug: 'support', costUsd: 0.12 },
      });
    });

    it('nulls the subject userId and actorUserId', () => {
      const result = erasedPayload(
        { event: 'e', data: { userId: SUBJECT, actorUserId: SUBJECT, agentId: 'a' } },
        'activity',
        SUBJECT
      );

      expect(result).toEqual({
        event: 'e',
        data: { userId: null, actorUserId: null, agentId: 'a' },
      });
    });

    it('drops actorUserName only when the actor is the subject', () => {
      const subjectActor = erasedPayload(
        { data: { actorUserId: SUBJECT, actorUserName: 'Sam Subject' } },
        'activity',
        SUBJECT
      );
      const otherActor = erasedPayload(
        { data: { actorUserId: OTHER, actorUserName: 'Olive Other' } },
        'activity',
        SUBJECT
      );

      expect(subjectActor).toEqual({ data: { actorUserId: null } });
      expect(otherActor).toEqual({ data: { actorUserId: OTHER, actorUserName: 'Olive Other' } });
    });

    it('filters the subject out of approverUserIds and leaves colleagues', () => {
      const result = erasedPayload(
        { data: { approverUserIds: [OTHER, SUBJECT, 'user-third'] } },
        'activity',
        SUBJECT
      );

      expect(result).toEqual({ data: { approverUserIds: [OTHER, 'user-third'] } });
    });

    it("leaves another person's userId untouched", () => {
      const result = erasedPayload({ data: { userId: OTHER, agentId: 'a' } }, 'activity', SUBJECT);

      expect(result).toEqual({ data: { userId: OTHER, agentId: 'a' } });
    });
  });

  describe('actor basis', () => {
    it('keeps all data (including changes) and loses only the subject', () => {
      const result = erasedPayload(
        {
          event: 'agent_updated',
          data: {
            actorUserId: SUBJECT,
            actorUserName: 'Sam Subject',
            changes: { name: 'new' },
            reason: 'kept on actor rows',
            approverUserIds: [SUBJECT, OTHER],
            forkOwnKey: 'kept',
          },
        },
        'actor',
        SUBJECT
      );

      expect(result).toEqual({
        event: 'agent_updated',
        data: {
          actorUserId: null,
          changes: { name: 'new' },
          reason: 'kept on actor rows',
          approverUserIds: [OTHER],
          forkOwnKey: 'kept',
        },
      });
    });

    it("leaves another person's ids and names untouched", () => {
      const result = erasedPayload(
        { data: { actorUserId: OTHER, actorUserName: 'Olive Other', userId: OTHER, changes: 1 } },
        'actor',
        SUBJECT
      );

      expect(result).toEqual({
        data: { actorUserId: OTHER, actorUserName: 'Olive Other', userId: OTHER, changes: 1 },
      });
    });
  });

  describe('payloads without a usable data object', () => {
    it.each<[string, Prisma.JsonValue]>([
      ['null payload', null],
      ['array payload', [{ data: { userId: SUBJECT } }]],
      ['string payload', 'plain'],
      ['missing data', { event: 'e' }],
      ['null data', { event: 'e', data: null }],
      ['array data', { event: 'e', data: [SUBJECT] }],
      ['string data', { event: 'e', data: SUBJECT }],
    ])('returns %s unchanged', (_label, payload) => {
      expect(erasedPayload(payload, 'activity', SUBJECT)).toBe(payload);
      expect(erasedPayload(payload, 'actor', SUBJECT)).toBe(payload);
    });
  });

  it('does not mutate the input payload', () => {
    const payload = { data: { userId: SUBJECT, reason: 'r', approverUserIds: [SUBJECT] } };
    const snapshot = JSON.parse(JSON.stringify(payload));

    erasedPayload(payload, 'activity', SUBJECT);

    expect(payload).toEqual(snapshot);
  });
});

describe('subjectViewOfPayload', () => {
  it('activity: never hands the subject the org’s configuration carried on an event about their run', () => {
    // A webhook-channel notification step puts its target URL — which often
    // holds the credential in its path or query — and the body an admin's
    // template rendered into the payload. The run is the subject's; the URL,
    // the approval links and the body are not.
    const result = subjectViewOfPayload(
      {
        data: {
          executionId: 'e1',
          workflowId: 'w1',
          stepId: 's1',
          webhookUrl: 'https://hooks.example/services/T000/B000/secret-token',
          body: 'rendered by an admin template',
          approveUrl: 'https://app.example/approve?token=abc',
          rejectUrl: 'https://app.example/reject?token=abc',
          tokenExpiresAt: '2026-10-14T00:00:00Z',
          prompt: 'Approve your request?',
          errorMessage: 'the run failed',
        },
      },
      'activity',
      SUBJECT,
      EVENT
    );

    expect(result).toEqual({
      executionId: 'e1',
      workflowId: 'w1',
      stepId: 's1',
      prompt: 'Approve your request?',
      errorMessage: 'the run failed',
    });
  });

  it('activity: returns the event record, the subject’s text and own ids, and only the subject among the approvers', () => {
    const result = subjectViewOfPayload(
      {
        data: {
          userId: SUBJECT,
          conversationId: 'c1',
          reason: 'free text is the subject’s to see',
          metadata: { n: 1 },
          error: 'boom',
          actorUserId: OTHER,
          actorUserName: 'Olive Other',
          approverUserIds: [SUBJECT, OTHER],
        },
      },
      'activity',
      SUBJECT,
      EVENT
    );

    expect(result).toEqual({
      userId: SUBJECT,
      conversationId: 'c1',
      reason: 'free text is the subject’s to see',
      metadata: { n: 1 },
      error: 'boom',
      approverUserIds: [SUBJECT],
    });
    expect(JSON.stringify(result)).not.toContain(OTHER);
    expect(JSON.stringify(result)).not.toContain('Olive');
  });

  it('activity: drops keys that are neither the event record nor the subject’s text', () => {
    const result = subjectViewOfPayload(
      {
        data: {
          conversationId: 'c1',
          forkOwnKey: 'a fork’s own payload field',
          body: 'rendered by an admin template',
          changes: { a: 1 },
          webhookUrl: 'https://hooks.example/secret',
        },
      },
      'activity',
      SUBJECT,
      EVENT
    );

    expect(result).toEqual({ conversationId: 'c1' });
  });

  it('activity: keeps the subject as actor, with their name', () => {
    const result = subjectViewOfPayload(
      { data: { actorUserId: SUBJECT, actorUserName: 'Sam Subject', agentId: 'a' } },
      'activity',
      SUBJECT,
      EVENT
    );

    expect(result).toEqual({ actorUserId: SUBJECT, actorUserName: 'Sam Subject', agentId: 'a' });
  });

  it('activity: never returns an admin actor who force-failed the subject run', () => {
    const result = subjectViewOfPayload(
      {
        data: {
          executionId: 'e1',
          userId: SUBJECT,
          actorUserId: 'admin-1',
          actorUserName: 'Admin Person',
        },
      },
      'activity',
      SUBJECT,
      EVENT
    );

    expect(result).toEqual({ executionId: 'e1', userId: SUBJECT });
    expect(result).not.toHaveProperty('actorUserId');
    expect(result).not.toHaveProperty('actorUserName');
  });

  it('activity: an admin’s force-fail of the subject’s run carries no free text, but keeps the record keys', () => {
    const result = subjectViewOfPayload(
      {
        data: {
          executionId: 'e1',
          userId: SUBJECT,
          actorUserId: 'admin-1',
          reason: 'admin note: suspected abuse',
          metadata: { note: 'admin’s' },
          prompt: 'admin prompt',
          error: 'admin error',
          errorMessage: 'admin error message',
        },
      },
      'activity',
      SUBJECT,
      'execution.force_failed'
    );

    expect(result).toEqual({ executionId: 'e1', userId: SUBJECT });
  });

  it('activity: the workflow.failed a force-fail also emits carries no admin note either', () => {
    // Not an ADMIN_ACTION_EVENT, but `source: 'admin-force-fail'` marks its
    // errorMessage as the admin's reason.
    const result = subjectViewOfPayload(
      {
        data: {
          executionId: 'e1',
          workflowId: 'w1',
          source: 'admin-force-fail',
          errorMessage: 'Force-failed by admin: suspected abuse, see ticket 123',
        },
      },
      'activity',
      SUBJECT,
      'workflow.failed'
    );

    expect(result).toEqual({ executionId: 'e1', workflowId: 'w1', source: 'admin-force-fail' });
  });

  it('activity: a workflow.failed from the run itself keeps its errorMessage', () => {
    const result = subjectViewOfPayload(
      { data: { executionId: 'e1', errorMessage: 'step 3 timed out' } },
      'activity',
      SUBJECT,
      'workflow.failed'
    );

    expect(result).toEqual({ executionId: 'e1', errorMessage: 'step 3 timed out' });
  });

  it('activity: an event that is not an admin action keeps the free text (conversation_escalated)', () => {
    const result = subjectViewOfPayload(
      { data: { conversationId: 'c1', reason: 'user asked for a human' } },
      'activity',
      SUBJECT,
      'conversation_escalated'
    );

    expect(result).toEqual({ conversationId: 'c1', reason: 'user asked for a human' });
  });

  it('actor: returns only EVENT_RECORD_KEYS plus the subject’s own person keys', () => {
    const result = subjectViewOfPayload(
      {
        data: {
          actorUserId: SUBJECT,
          actorUserName: 'Sam Subject',
          agentId: 'a1',
          changes: { name: 'secret-config' },
          reason: 'x',
          forkOwnKey: 'y',
        },
      },
      'actor',
      SUBJECT,
      EVENT
    );

    expect(result).toEqual({ actorUserId: SUBJECT, actorUserName: 'Sam Subject', agentId: 'a1' });
  });

  it.each<'actor' | 'activity'>(['actor', 'activity'])(
    '%s: an approver is told they were one, and never who the other approvers were',
    (basis) => {
      const result = subjectViewOfPayload(
        { data: { approverUserIds: [OTHER, SUBJECT, 'user-third'], workflowId: 'w1' } },
        basis,
        SUBJECT,
        EVENT
      );

      expect(result).toEqual({ workflowId: 'w1', approverUserIds: [SUBJECT] });
    }
  );

  it.each<'actor' | 'activity'>(['actor', 'activity'])(
    '%s: no approverUserIds when the subject is not among them, or the field is not a list',
    (basis) => {
      const colleaguesOnly = subjectViewOfPayload(
        { data: { approverUserIds: [OTHER, 'user-third'], workflowId: 'w1' } },
        basis,
        SUBJECT,
        EVENT
      );
      const notAList = subjectViewOfPayload(
        { data: { approverUserIds: SUBJECT, workflowId: 'w1' } },
        basis,
        SUBJECT,
        EVENT
      );

      expect(colleaguesOnly).toEqual({ workflowId: 'w1' });
      expect(notAList).toEqual({ workflowId: 'w1' });
    }
  );

  it('actor: omits another person’s actor id and name', () => {
    const result = subjectViewOfPayload(
      { data: { actorUserId: OTHER, actorUserName: 'Olive Other', agentId: 'a1' } },
      'actor',
      SUBJECT,
      EVENT
    );

    expect(result).toEqual({ agentId: 'a1' });
  });

  it.each<[string, Prisma.JsonValue]>([
    ['null payload', null],
    ['missing data', { event: 'e' }],
    ['array data', { data: [1] }],
    ['string data', { data: 'x' }],
  ])('returns {} for %s', (_label, payload) => {
    expect(subjectViewOfPayload(payload, 'activity', SUBJECT, EVENT)).toEqual({});
    expect(subjectViewOfPayload(payload, 'actor', SUBJECT, EVENT)).toEqual({});
  });
});

describe('EVENT_RECORD_KEYS', () => {
  it('excludes free-text and person fields', () => {
    for (const key of ['reason', 'metadata', 'prompt', 'error', 'body', 'changes', 'userId']) {
      expect(EVENT_RECORD_KEYS.has(key)).toBe(false);
    }
  });
});

describe('deliveriesNamingSubject', () => {
  it('maps activity true/false to basis and strips the activity column', async () => {
    const { client } = makeClient([
      row({ id: 'a', activity: true }),
      row({ id: 'b', activity: false, createdAt: new Date('2026-01-02T00:00:00Z') }),
    ]);

    const result = await deliveriesNamingSubject(client, 'webhook', SUBJECT);

    expect(result.map((r) => [r.id, r.basis])).toEqual([
      ['a', 'activity'],
      ['b', 'actor'],
    ]);
    expect(result[0]).not.toHaveProperty('activity');
  });

  it('returns rows in the order the query gave them, without re-sorting in JS', async () => {
    // The ordering lives in the SQL; a JS re-sort here would hide a missing ORDER BY.
    const { client } = makeClient([
      row({ id: 'z-late', createdAt: new Date('2026-03-01T00:00:00Z') }),
      row({ id: 'b-early', createdAt: new Date('2026-01-01T00:00:00Z') }),
      row({ id: 'a-early', createdAt: new Date('2026-01-01T00:00:00Z') }),
    ]);

    const result = await deliveriesNamingSubject(client, 'webhook', SUBJECT);

    expect(result.map((r) => r.id)).toEqual(['z-late', 'b-early', 'a-early']);
  });

  it('orders in SQL by createdAt then id in code-unit order, around the DISTINCT ON', async () => {
    const { client, queryRaw } = makeClient([]);

    await deliveriesNamingSubject(client, 'webhook', SUBJECT);

    const { text } = renderCall(queryRaw);
    expect(text).toMatch(/ORDER BY "createdAt", id COLLATE "C"/);
    // The outer ORDER BY comes after the DISTINCT ON subquery, which has its own.
    expect(text.indexOf('ORDER BY "createdAt"')).toBeGreaterThan(text.indexOf('DISTINCT ON (id)'));
    expect(text).toContain('ORDER BY id, activity DESC');
  });

  it('selects only the needed columns in every arm: never d.*, SELECT *, or an address column', async () => {
    const { client, queryRaw } = makeClient([]);

    await deliveriesNamingSubject(client, 'webhook', SUBJECT);

    const { text } = renderCall(queryRaw);
    const columns =
      'd.id, d."eventType", d.status, d."lastError", d."lastAttemptAt", d."createdAt", d.payload';
    // One arm per match: conversation, execution, userId, actorUserId, approvers.
    expect(text.split(`SELECT ${columns}, `)).toHaveLength(6);
    expect(text).not.toContain('d.*');
    expect(text).not.toContain('SELECT *,');
    expect(text).not.toMatch(/destination|previousDestinations/i);
  });

  it('exports the admin-action events as a fixed list', () => {
    expect([...ADMIN_ACTION_EVENTS].sort()).toEqual(
      [
        'agent.updated',
        'agent_updated',
        'capability.quarantined',
        'capability.unquarantined',
        'execution.force_failed',
      ].sort()
    );
  });

  it('decides the actorUserId arm by event type: binds ADMIN_ACTION_EVENTS as one text[] parameter', async () => {
    const { client, queryRaw } = makeClient([]);

    await deliveriesNamingSubject(client, 'webhook', SUBJECT);

    const { text, values } = renderCall(queryRaw);
    // Activity unless the event is an admin action — the list is a bound
    // array, not interpolated text.
    expect(text).toContain('NOT (d."eventType" = ANY(');
    expect(text).toContain('::text[]');
    expect(values).toContainEqual([...ADMIN_ACTION_EVENTS]);
    for (const event of ADMIN_ACTION_EVENTS) expect(text).not.toContain(event);
    // The approver arm stays unconditionally `actor`.
    expect(text).toMatch(/\bd\.payload, false FROM [\w.]+ d WHERE d\.payload @>/);
  });

  it('queries the webhook delivery table for "webhook"', async () => {
    const { client, queryRaw } = makeClient([]);

    await deliveriesNamingSubject(client, 'webhook', SUBJECT);

    const { text } = renderCall(queryRaw);
    expect(text).toContain('ai_webhook_delivery');
    expect(text).not.toContain('ai_event_hook_delivery');
  });

  it('queries the event-hook delivery table for "hook"', async () => {
    const { client, queryRaw } = makeClient([]);

    await deliveriesNamingSubject(client, 'hook', SUBJECT);

    const { text } = renderCall(queryRaw);
    expect(text).toContain('ai_event_hook_delivery');
    expect(text).not.toContain('ai_webhook_delivery');
  });

  it('binds the userId as a parameter and never interpolates it into the SQL text', async () => {
    const hostile = "u'; DROP TABLE users; --";
    const { client, queryRaw } = makeClient([]);

    await deliveriesNamingSubject(client, 'webhook', hostile);

    const { text, values } = renderCall(queryRaw);
    expect(text).not.toContain(hostile);
    expect(text).not.toContain('DROP TABLE');
    expect(values).toContain(hostile);
    // The containment parameters carry it inside bound JSON, not in the text.
    expect(values).toContain(JSON.stringify({ data: { userId: hostile } }));
    expect(values).toContain(JSON.stringify({ data: { actorUserId: hostile } }));
    expect(values).toContain(JSON.stringify({ data: { approverUserIds: [hostile] } }));
  });
});

describe('eraseSubjectFromDeliveries', () => {
  let rows: RawRow[];

  beforeEach(() => {
    rows = [];
  });

  /** All rows written across every $executeRaw call, parsed from the bound jsonb parameter. */
  function writtenRows(executeRaw: ReturnType<typeof vi.fn>) {
    return executeRaw.mock.calls.flatMap((_c, i) => {
      const { values } = renderCall(executeRaw, i);
      const json = values.find((v): v is string => typeof v === 'string' && v.startsWith('['));
      if (!json) throw new Error('no jsonb chunk bound');
      const parsed: Array<{
        id: string;
        payload: Prisma.JsonValue;
        activity: boolean;
      }> = JSON.parse(json);
      return parsed;
    });
  }

  it('hands the UPDATE each row’s basis as `activity`, and computes no stop or lastError itself', async () => {
    rows = [
      row({ id: 'pend', status: 'pending', lastError: null, createdAt: new Date(1) }),
      row({ id: 'fail', status: 'failed', lastError: 'HTTP 500', createdAt: new Date(2) }),
      row({ id: 'done', status: 'delivered', lastError: null, createdAt: new Date(3) }),
      row({
        id: 'actor-pending',
        activity: false,
        status: 'pending',
        lastError: 'earlier error',
        payload: { data: { actorUserId: SUBJECT, changes: { a: 1 } } },
        createdAt: new Date(4),
      }),
    ];
    const { client, executeRaw } = makeClient(rows);

    await eraseSubjectFromDeliveries(client, 'webhook', SUBJECT);

    // Exactly {id, payload, activity}: the status the read saw is not sent,
    // so the UPDATE can only decide against the row as it finds it.
    const written = writtenRows(executeRaw);
    expect(written.map((w) => [w.id, w.activity])).toEqual([
      ['pend', true],
      ['fail', true],
      ['done', true],
      ['actor-pending', false],
    ]);
    for (const w of written) {
      expect(Object.keys(w).sort()).toEqual(['activity', 'id', 'payload']);
    }
  });

  it('decides the stop in SQL against the row’s live status, for activity rows only', async () => {
    const { client, executeRaw } = makeClient([row({ id: 'one' })]);

    await eraseSubjectFromDeliveries(client, 'webhook', SUBJECT);

    const { text, values } = renderCall(executeRaw);
    // The live condition, with the awaiting-retry statuses bound as one array
    const stop = String.raw`\(w\.activity AND d\.status = ANY\(\$\d+::text\[\]\)\)`;
    expect(values).toContainEqual(['pending', 'failed']);
    // Status, retry time and last error all hang off the same live condition
    expect(text).toMatch(
      new RegExp(`status = CASE WHEN ${stop} THEN 'exhausted' ELSE d\\.status END`)
    );
    expect(text).toMatch(
      new RegExp(`"nextRetryAt" = CASE WHEN ${stop} THEN NULL ELSE d\\."nextRetryAt" END`)
    );
    // The mark lands on every activity row, whatever its status — an
    // exhausted one keeps its status, so a DLQ replay refuses it, and so does
    // a delivered one, which can still be retried by hand (t-793).
    expect(text).toMatch(
      /"lastError" = CASE WHEN \(w\.activity\s+AND d\."lastError" IS DISTINCT FROM \$\d+\s+AND right\(coalesce\(d\."lastError", ''\), \$\d+\) <> \$\d+\) THEN/
    );
    // A row an earlier erasure already marked is not marked twice
    expect(values).toContain(' (not retried: subject erased)'.length);
    expect(text).toContain('ELSE d."lastError" END');
    // The not-retried wording is built in SQL from the row's own lastError,
    // with notRetried's wording bound as parameters, so isStoppedByErasure
    // recognises the result and a manual retry refuses the row (t-793).
    expect(values).toContain('Not retried: subject erased');
    expect(values).toContain(' (not retried: subject erased)');
    expect(text).toMatch(/ELSE d\."lastError" \|\| \$\d+ END/);
    expect(isStoppedByErasure('Not retried: subject erased')).toBe(true);
    expect(isStoppedByErasure('HTTP 500 (not retried: subject erased)')).toBe(true);
    expect(text).toContain('AS w(id text, payload jsonb, activity boolean)');
  });

  it('writes the redacted payload for each basis', async () => {
    rows = [
      row({
        id: 'act',
        activity: true,
        payload: { event: 'ev', data: { userId: SUBJECT, agentId: 'a', reason: 'private' } },
        createdAt: new Date(1),
      }),
      row({
        id: 'actr',
        activity: false,
        payload: { event: 'ev', data: { actorUserId: SUBJECT, changes: { k: 1 } } },
        createdAt: new Date(2),
      }),
    ];
    const { client, executeRaw } = makeClient(rows);

    await eraseSubjectFromDeliveries(client, 'webhook', SUBJECT);

    const byId = new Map(writtenRows(executeRaw).map((w) => [w.id, w.payload]));
    expect(byId.get('act')).toEqual({ event: 'ev', data: { userId: null, agentId: 'a' } });
    expect(byId.get('actr')).toEqual({
      event: 'ev',
      data: { actorUserId: null, changes: { k: 1 } },
    });
  });

  it('writes in chunks of 500 and returns the row count', async () => {
    rows = Array.from({ length: 1001 }, (_, i) =>
      row({ id: `r${String(i).padStart(4, '0')}`, createdAt: new Date(i) })
    );
    const { client, executeRaw } = makeClient(rows);

    const count = await eraseSubjectFromDeliveries(client, 'webhook', SUBJECT);

    expect(count).toBe(1001);
    expect(executeRaw).toHaveBeenCalledTimes(3);
    const sizes = executeRaw.mock.calls.map((_c, i) => {
      const { values } = renderCall(executeRaw, i);
      const json = values.find((v): v is string => typeof v === 'string' && v.startsWith('['));
      return json ? JSON.parse(json).length : -1;
    });
    expect(sizes).toEqual([500, 500, 1]);
  });

  it('makes no writes and returns 0 when nothing matched', async () => {
    const { client, executeRaw } = makeClient([]);

    const count = await eraseSubjectFromDeliveries(client, 'hook', SUBJECT);

    expect(count).toBe(0);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('updates the table matching the requested kind', async () => {
    rows = [row({ id: 'one' })];
    const hook = makeClient(rows);
    const webhook = makeClient(rows);

    await eraseSubjectFromDeliveries(hook.client, 'hook', SUBJECT);
    await eraseSubjectFromDeliveries(webhook.client, 'webhook', SUBJECT);

    expect(renderCall(hook.executeRaw).text).toContain('UPDATE ai_event_hook_delivery');
    expect(renderCall(webhook.executeRaw).text).toContain('UPDATE ai_webhook_delivery');
  });
});

describe('byCreatedAtThenId', () => {
  const at = (ms: number, id: string) => ({ createdAt: new Date(ms), id });

  it('orders oldest first', () => {
    const sorted = [at(300, 'a'), at(100, 'z'), at(200, 'm')].sort(byCreatedAtThenId);

    expect(sorted.map((r) => r.id)).toEqual(['z', 'm', 'a']);
  });

  it('breaks a tie on time by id', () => {
    const sorted = [at(100, 'b'), at(100, 'c'), at(100, 'a')].sort(byCreatedAtThenId);

    expect(sorted.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('breaks a tie in code-unit order, not locale order', () => {
    // Locale order puts 'a' before 'B'; code-unit order puts 'B' (66) before 'a' (97).
    const sorted = [at(100, 'a'), at(100, 'B')].sort(byCreatedAtThenId);

    expect(sorted.map((r) => r.id)).toEqual(['B', 'a']);
  });

  it('is negative, positive and — for the same row — zero', () => {
    expect(byCreatedAtThenId(at(1, 'a'), at(2, 'a'))).toBeLessThan(0);
    expect(byCreatedAtThenId(at(2, 'a'), at(1, 'a'))).toBeGreaterThan(0);
    expect(byCreatedAtThenId(at(1, 'a'), at(1, 'b'))).toBeLessThan(0);
    expect(byCreatedAtThenId(at(1, 'b'), at(1, 'a'))).toBeGreaterThan(0);
  });
});
