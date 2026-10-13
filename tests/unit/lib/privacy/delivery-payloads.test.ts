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
import {
  EVENT_RECORD_KEYS,
  deliveriesNamingSubject,
  eraseSubjectFromDeliveries,
  erasedPayload,
  subjectViewOfPayload,
  type RawClient,
} from '@/lib/privacy/delivery-payloads';

const SUBJECT = 'user-subject';
const OTHER = 'user-other';

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
  it('activity: returns everything except other people and approverUserIds', () => {
    const result = subjectViewOfPayload(
      {
        data: {
          userId: SUBJECT,
          conversationId: 'c1',
          reason: 'free text is the subject’s to see',
          metadata: { n: 1 },
          actorUserId: OTHER,
          actorUserName: 'Olive Other',
          approverUserIds: [SUBJECT, OTHER],
        },
      },
      'activity',
      SUBJECT
    );

    expect(result).toEqual({
      userId: SUBJECT,
      conversationId: 'c1',
      reason: 'free text is the subject’s to see',
      metadata: { n: 1 },
    });
  });

  it('activity: keeps the subject as actor, with their name', () => {
    const result = subjectViewOfPayload(
      { data: { actorUserId: SUBJECT, actorUserName: 'Sam Subject', agentId: 'a' } },
      'activity',
      SUBJECT
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
      SUBJECT
    );

    expect(result).toEqual({ executionId: 'e1', userId: SUBJECT });
    expect(result).not.toHaveProperty('actorUserId');
    expect(result).not.toHaveProperty('actorUserName');
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
          approverUserIds: [SUBJECT, OTHER],
        },
      },
      'actor',
      SUBJECT
    );

    expect(result).toEqual({ actorUserId: SUBJECT, actorUserName: 'Sam Subject', agentId: 'a1' });
  });

  it('actor: never returns approverUserIds even when the subject is an approver', () => {
    const result = subjectViewOfPayload(
      { data: { approverUserIds: [SUBJECT, OTHER], workflowId: 'w1' } },
      'actor',
      SUBJECT
    );

    expect(result).toEqual({ workflowId: 'w1' });
  });

  it('actor: omits another person’s actor id and name', () => {
    const result = subjectViewOfPayload(
      { data: { actorUserId: OTHER, actorUserName: 'Olive Other', agentId: 'a1' } },
      'actor',
      SUBJECT
    );

    expect(result).toEqual({ agentId: 'a1' });
  });

  it.each<[string, Prisma.JsonValue]>([
    ['null payload', null],
    ['missing data', { event: 'e' }],
    ['array data', { data: [1] }],
    ['string data', { data: 'x' }],
  ])('returns {} for %s', (_label, payload) => {
    expect(subjectViewOfPayload(payload, 'activity', SUBJECT)).toEqual({});
    expect(subjectViewOfPayload(payload, 'actor', SUBJECT)).toEqual({});
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

  it('sorts by createdAt, then id', async () => {
    const early = new Date('2026-01-01T00:00:00Z');
    const late = new Date('2026-03-01T00:00:00Z');
    const { client } = makeClient([
      row({ id: 'z-late', createdAt: late }),
      row({ id: 'b-early', createdAt: early }),
      row({ id: 'a-early', createdAt: early }),
    ]);

    const result = await deliveriesNamingSubject(client, 'webhook', SUBJECT);

    expect(result.map((r) => r.id)).toEqual(['a-early', 'b-early', 'z-late']);
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
        stop: boolean;
        lastError: string | null;
      }> = JSON.parse(json);
      return parsed;
    });
  }

  it('stops only activity rows that are pending or failed, with a not-retried lastError', async () => {
    rows = [
      row({ id: 'pend', status: 'pending', lastError: null, createdAt: new Date(1) }),
      row({ id: 'fail', status: 'failed', lastError: 'HTTP 500', createdAt: new Date(2) }),
      row({ id: 'done', status: 'delivered', lastError: null, createdAt: new Date(3) }),
      row({ id: 'exh', status: 'exhausted', lastError: 'gave up', createdAt: new Date(4) }),
    ];
    const { client, executeRaw } = makeClient(rows);

    await eraseSubjectFromDeliveries(client, 'webhook', SUBJECT);

    const byId = new Map(writtenRows(executeRaw).map((w) => [w.id, w]));
    expect(byId.get('pend')).toMatchObject({
      stop: true,
      lastError: 'Not retried: subject erased',
    });
    expect(byId.get('fail')).toMatchObject({
      stop: true,
      lastError: 'HTTP 500 (not retried: subject erased)',
    });
    expect(byId.get('done')).toMatchObject({ stop: false, lastError: null });
    expect(byId.get('exh')).toMatchObject({ stop: false, lastError: 'gave up' });
  });

  it('leaves actor rows’ status and lastError alone even when pending/failed', async () => {
    rows = [
      row({
        id: 'actor-pending',
        activity: false,
        status: 'pending',
        lastError: 'earlier error',
        payload: { data: { actorUserId: SUBJECT, changes: { a: 1 } } },
        createdAt: new Date(1),
      }),
      row({
        id: 'actor-failed',
        activity: false,
        status: 'failed',
        lastError: null,
        payload: { data: { actorUserId: SUBJECT } },
        createdAt: new Date(2),
      }),
    ];
    const { client, executeRaw } = makeClient(rows);

    await eraseSubjectFromDeliveries(client, 'hook', SUBJECT);

    const written = writtenRows(executeRaw);
    expect(written).toEqual([
      expect.objectContaining({ id: 'actor-pending', stop: false, lastError: 'earlier error' }),
      expect.objectContaining({ id: 'actor-failed', stop: false, lastError: null }),
    ]);
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
