/**
 * Unit tests for lib/privacy/delivery-payloads.ts (t-783).
 *
 * The raw-SQL JSON-containment matching is proven against real Postgres by
 * scripts/smoke/erasure-deliveries.ts. This layer covers the pure payload
 * redaction / subject-view logic and the shape of the statements issued.
 *
 * @see lib/privacy/delivery-payloads.ts
 */

import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  ADMIN_ACTION_EVENTS,
  EVENT_RECORD_KEYS,
  byCreatedAtThenId,
  deliveriesNamingSubject,
  eraseSubjectFromDeliveries,
  erasedPayload,
  preRedactSubjectFromDeliveries,
  subjectViewOfPayload,
  subjectsOfPayload,
  withoutErasedSubjects,
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

/**
 * The SQL text and bound values of the nth call to a raw mock: called as a
 * tagged template, or with one prebuilt `Prisma.Sql`.
 */
function renderCall(mock: ReturnType<typeof vi.fn>, n = 0) {
  const [first, ...values] = mock.mock.calls[n] as [
    TemplateStringsArray | Prisma.Sql,
    ...unknown[],
  ];
  // A template's strings are an array; a prebuilt fragment is not.
  if (!Array.isArray(first)) {
    const sql = first as Prisma.Sql;
    return { text: sql.text, values: sql.values };
  }
  return render(first as TemplateStringsArray, values);
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
  // One statement that matches, redacts and writes in Postgres (t-806). What
  // it writes is pinned against erasedPayload() over real rows by
  // smoke:erasure-deliveries; this covers the statement's shape.

  it('issues one UPDATE, reads nothing into Node, and returns the rows it rewrote', async () => {
    const { client, queryRaw, executeRaw } = makeClient([row({ id: 'never-read' })]);
    executeRaw.mockResolvedValueOnce(1_000_001);

    const count = await eraseSubjectFromDeliveries(client, 'webhook', SUBJECT);

    expect(count).toBe(1_000_001);
    expect(queryRaw).not.toHaveBeenCalled();
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const { text, values } = renderCall(executeRaw);
    expect(text).toMatch(/^\s*WITH one_each AS \(/);
    expect(text).toContain('UPDATE ai_webhook_delivery AS d');
    expect(text).toContain('FROM redacted r');
    expect(text).toContain('WHERE d.id = r.id');
    // No payload is bound: nothing went through Node.
    expect(values.some((v) => typeof v === 'string' && v.startsWith('[{'))).toBe(false);
  });

  it('matches through the same arms as subject access, keeping the activity copy of a row matched twice', async () => {
    const { client, executeRaw } = makeClient([]);

    await eraseSubjectFromDeliveries(client, 'webhook', SUBJECT);

    const { text, values } = renderCall(executeRaw);
    // The arms read ids only; the row is joined back once, unlocked.
    expect(text.split('SELECT d.id, true')).toHaveLength(4);
    expect(text).toMatch(
      /SELECT DISTINCT ON \(id\) id, activity\s+FROM \([\s\S]+\) arms\s+ORDER BY id, activity DESC/
    );
    expect(text).toMatch(
      /SELECT d\.id, d\.payload, d\.status, d\."stoppedByErasure", d\."lastError", m\.activity[\s\S]+JOIN ai_webhook_delivery d ON d\.id = m\.id\)/
    );
    expect(values).toContainEqual([...ADMIN_ACTION_EVENTS]);
  });

  it('keeps exactly the event record keys and the person keys on an activity row', async () => {
    const { client, executeRaw } = makeClient([]);

    await eraseSubjectFromDeliveries(client, 'webhook', SUBJECT);

    const { text, values } = renderCall(executeRaw);
    expect(text).toMatch(/WHEN o\.activity\s+THEN \(SELECT coalesce\(jsonb_object_agg/);
    expect(text).toMatch(/WHERE e\.key = ANY\(\$\d+::text\[\]\)/);
    const keep = values.find((v): v is string[] => Array.isArray(v) && v.includes('agentId'));
    expect(new Set(keep)).toEqual(
      new Set([...EVENT_RECORD_KEYS, 'userId', 'actorUserId', 'actorUserName', 'approverUserIds'])
    );
    // An actor row keeps all of its data.
    expect(text).toContain("ELSE o.payload -> 'data' END");
  });

  it('nulls the subject’s ids, drops the actor’s name, and takes them out of the approvers', async () => {
    const { client, executeRaw } = makeClient([]);

    await eraseSubjectFromDeliveries(client, 'webhook', SUBJECT);

    const { text, values } = renderCall(executeRaw);
    expect(values).toContain('{userId}');
    expect(values).toContain('{actorUserId}');
    expect(values).toContain('actorUserName');
    expect(values).toContain('{approverUserIds}');
    expect(text).toMatch(/jsonb_set\(p0\.v, \$\d+::text\[\], 'null'::jsonb\)\s+ELSE p0\.v END/);
    expect(text).toMatch(
      /jsonb_set\(p1\.v, \$\d+::text\[\], 'null'::jsonb\)\s+- \$\d+::text\s+ELSE p1\.v END/
    );
    expect(text).toMatch(/jsonb_agg\(a\.e ORDER BY a\.i\)/);
    expect(text).toMatch(/WHERE a\.e <> to_jsonb\(\$\d+::text\)/);
    // Every step is fenced, so the planner evaluates each once per row rather
    // than inlining it into every reference (t-806: 9.9 s against 0.6 s).
    // The redaction runs twice, the first look and the locked re-read.
    expect(text.match(/\bOFFSET 0\s+\)/g)).toHaveLength(8);
    // A payload whose data is not an object is left as it was.
    expect(text).toMatch(
      /CASE WHEN jsonb_typeof\(o\.payload -> 'data'\) = 'object'\s+THEN jsonb_set\(o\.payload, '\{data\}', approvers\.v\)\s+ELSE o\.payload END/
    );
  });

  it('decides the stop against the row’s live status, for activity rows only', async () => {
    const { client, executeRaw } = makeClient([]);

    await eraseSubjectFromDeliveries(client, 'webhook', SUBJECT);

    const { text, values } = renderCall(executeRaw);
    const stop = String.raw`\(r\.activity AND d\.status = ANY\(\$\d+::text\[\]\)\)`;
    expect(values).toContainEqual(['pending', 'failed']);
    expect(text).toMatch(
      new RegExp(`status = CASE WHEN ${stop} THEN 'exhausted' ELSE d\\.status END`)
    );
    expect(text).toMatch(
      new RegExp(`"nextRetryAt" = CASE WHEN ${stop} THEN NULL ELSE d\\."nextRetryAt" END`)
    );
  });

  it('marks every activity row stoppedByErasure, and words lastError once, by the wording itself (t-809)', async () => {
    const { client, executeRaw } = makeClient([]);

    await eraseSubjectFromDeliveries(client, 'webhook', SUBJECT);

    const { text, values } = renderCall(executeRaw);
    // The column is set on every activity row and never cleared.
    expect(text).toContain('"stoppedByErasure" = d."stoppedByErasure" OR r.activity');
    // The wording, for people to read, is added once: decided on the wording,
    // not the column, so a row step 5 stopped as "recipient erased" still
    // says its content was erased.
    expect(text).toMatch(
      /"lastError" = CASE WHEN \(r\.activity\s+AND d\."lastError" IS DISTINCT FROM \$\d+\s+AND right\(coalesce\(d\."lastError", ''\), \$\d+\) <> \$\d+\) THEN CASE WHEN d\."lastError" IS NULL OR d\."lastError" = ''/
    );
    expect(values).toContain(' (not retried: subject erased)'.length);
    expect(values).toContain('Not retried: subject erased');
    expect(values).toContain(' (not retried: subject erased)');
    expect(text).toMatch(/ELSE d\."lastError" \|\| \$\d+ END ELSE d\."lastError" END/);
  });

  it('writes only a row that still needs it, so a row the pre-pass redacted costs no write', async () => {
    const { client, executeRaw } = makeClient([]);

    await eraseSubjectFromDeliveries(client, 'webhook', SUBJECT);

    const { text } = renderCall(executeRaw);
    expect(text).toMatch(
      /WHERE d\.id = r\.id\s+AND \(r\.payload IS DISTINCT FROM d\.payload OR \(r\.activity AND NOT d\."stoppedByErasure"\) OR \(r\.activity\s+AND d\."lastError" IS DISTINCT FROM [\s\S]+?\) OR \(r\.activity AND d\.status = ANY\(\$\d+::text\[\]\)\)\)/
    );
  });

  it('locks only the rows that still need a write, in id order, and redacts them as they are now (t-806)', async () => {
    const { client, executeRaw } = makeClient([]);

    await eraseSubjectFromDeliveries(client, 'webhook', SUBJECT);

    const { text } = renderCall(executeRaw);
    // The first look redacts the snapshot; todo keeps rows that need a write.
    expect(text).toMatch(/first_look AS \([\s\S]+?FROM one_each o/);
    // It filters the first look alone, comparing against the payload as read
    // (`before`), so one_each is read once and never joined back to itself.
    expect(text).toMatch(
      /todo AS \(\s+SELECT f\.id, f\.activity\s+FROM first_look f\s+WHERE \(f\.payload IS DISTINCT FROM f\.before OR/
    );
    expect(text.match(/\bone_each\b/g)).toHaveLength(2);
    // Only todo rows are locked, in id order, and re-read.
    expect(text).toMatch(
      /locked AS \(\s+SELECT d\.id, d\.payload, todo\.activity\s+FROM todo\s+JOIN ai_webhook_delivery d ON d\.id = todo\.id\s+ORDER BY d\.id\s+FOR UPDATE OF d\s+\)/
    );
    expect(text.match(/FOR UPDATE/g)).toHaveLength(1);
    // Only the first look carries the row as read; the locked re-read does not.
    expect(text.match(/o\.payload AS before/g)).toHaveLength(1);
    // The write redacts from the locked read, never the first look.
    expect(text).toMatch(
      /redacted AS \([\s\S]+FROM locked o[\s\S]+\)\s+UPDATE ai_webhook_delivery AS d/
    );
  });

  it('binds the subject as a parameter and never interpolates it', async () => {
    const hostile = `x'); DROP TABLE ai_webhook_delivery; --`;
    const { client, executeRaw } = makeClient([]);

    await eraseSubjectFromDeliveries(client, 'webhook', hostile);

    const { text, values } = renderCall(executeRaw);
    expect(text).not.toContain(hostile);
    expect(values).toContain(hostile);
  });

  it('updates the table matching the requested kind', async () => {
    const hook = makeClient([]);
    const webhook = makeClient([]);

    await eraseSubjectFromDeliveries(hook.client, 'hook', SUBJECT);
    await eraseSubjectFromDeliveries(webhook.client, 'webhook', SUBJECT);

    expect(renderCall(hook.executeRaw).text).toContain('UPDATE ai_event_hook_delivery AS d');
    expect(renderCall(webhook.executeRaw).text).toContain('UPDATE ai_webhook_delivery AS d');
  });
});

describe('preRedactSubjectFromDeliveries', () => {
  function matchedIds(n: number) {
    return Array.from({ length: n }, (_, i) => ({ id: `r${i}`, activity: i % 2 === 0 }));
  }

  it('matches once, reading only ids and bases, never a payload', async () => {
    const { client, queryRaw } = makeClient([]);
    queryRaw.mockResolvedValueOnce([]);

    await preRedactSubjectFromDeliveries(client, 'webhook', SUBJECT);

    expect(queryRaw).toHaveBeenCalledTimes(1);
    const { text, values } = renderCall(queryRaw);
    expect(text).toMatch(/^\s*SELECT DISTINCT ON \(id\) id, activity\s/);
    expect(text.split('SELECT d.id, ')).toHaveLength(6);
    expect(text).not.toContain('d.payload,');
    expect(values).toContain(SUBJECT);
  });

  it('rewrites in committed chunks of 5,000, each from the row as it is, and sums what changed', async () => {
    const { client, queryRaw, executeRaw } = makeClient([]);
    queryRaw.mockResolvedValueOnce(matchedIds(10_001) as unknown as RawRow[]);
    executeRaw.mockResolvedValueOnce(5_000).mockResolvedValueOnce(4_999).mockResolvedValueOnce(1);

    const changed = await preRedactSubjectFromDeliveries(client, 'hook', SUBJECT);

    expect(changed).toBe(10_000);
    expect(executeRaw).toHaveBeenCalledTimes(3);
    const sizes = [0, 1, 2].map((i) => {
      const { values } = renderCall(executeRaw, i);
      const ids = values.find(
        (v): v is string[] => Array.isArray(v) && typeof v[0] === 'string' && v[0].startsWith('r')
      );
      return ids?.length;
    });
    expect(sizes).toEqual([5_000, 5_000, 1]);
    const { text, values } = renderCall(executeRaw, 2);
    // The chunk's ids and bases, joined to the live row: no payload is bound.
    expect(text).toMatch(
      /FROM unnest\(\$\d+::text\[\], \$\d+::boolean\[\]\)\s+AS w\(id, activity\)\s+JOIN ai_event_hook_delivery d ON d\.id = w\.id/
    );
    expect(values).toContainEqual(['r10000']);
    expect(values).toContainEqual([true]);
    // Each chunk reads its rows unlocked; the update locks only what it writes.
    expect(text).toMatch(/JOIN ai_event_hook_delivery d ON d\.id = w\.id\)/);
    // The same skip-unchanged update as the transaction's pass.
    expect(text).toContain('UPDATE ai_event_hook_delivery AS d');
    expect(text).toContain('r.payload IS DISTINCT FROM d.payload');
  });

  it('reports each chunk as it commits, so a later failure does not lose the count', async () => {
    const { client, queryRaw, executeRaw } = makeClient([]);
    queryRaw.mockResolvedValueOnce(matchedIds(12_000) as unknown as RawRow[]);
    executeRaw
      .mockResolvedValueOnce(5_000)
      .mockResolvedValueOnce(4_000)
      .mockRejectedValueOnce(new Error('connection lost'));
    const heard: number[] = [];

    await expect(
      preRedactSubjectFromDeliveries(client, 'webhook', SUBJECT, (n) => heard.push(n))
    ).rejects.toThrow('connection lost');

    expect(heard).toEqual([5_000, 4_000]);
  });

  it('writes nothing when nothing names the subject', async () => {
    const { client, queryRaw, executeRaw } = makeClient([]);
    queryRaw.mockResolvedValueOnce([]);

    expect(await preRedactSubjectFromDeliveries(client, 'webhook', SUBJECT)).toBe(0);
    expect(executeRaw).not.toHaveBeenCalled();
  });
});

describe('preRedactSubjectFromDeliveries with a statement runner (t-845)', () => {
  function matchedIds(n: number) {
    return Array.from({ length: n }, (_, i) => ({ id: `r${i}`, activity: i % 2 === 0 }));
  }

  it('runs the match and every chunk through the runner, on the client it hands over, never on `client`', async () => {
    const outer = makeClient([]);
    const inner = makeClient([]);
    inner.queryRaw.mockResolvedValueOnce(matchedIds(10_001) as unknown as RawRow[]);
    inner.executeRaw
      .mockResolvedValueOnce(5_000)
      .mockResolvedValueOnce(5_000)
      .mockResolvedValueOnce(1);
    let statements = 0;
    const runStatement = <T>(statement: (c: RawClient) => Promise<T>) => {
      statements += 1;
      return statement(inner.client);
    };

    const changed = await preRedactSubjectFromDeliveries(
      outer.client,
      'webhook',
      SUBJECT,
      undefined,
      runStatement
    );

    // One match plus three chunks, each its own statement.
    expect(statements).toBe(4);
    expect(inner.queryRaw).toHaveBeenCalledTimes(1);
    expect(inner.executeRaw).toHaveBeenCalledTimes(3);
    expect(outer.queryRaw).not.toHaveBeenCalled();
    expect(outer.executeRaw).not.toHaveBeenCalled();
    expect(changed).toBe(10_001);
    expect(renderCall(inner.queryRaw).values).toContain(SUBJECT);
  });

  it('runs a statement per chunk, so a chunk that the runner refuses stops the pass after the ones before it', async () => {
    const outer = makeClient([]);
    const inner = makeClient([]);
    inner.queryRaw.mockResolvedValueOnce(matchedIds(12_000) as unknown as RawRow[]);
    inner.executeRaw.mockResolvedValue(5_000);
    const heard: number[] = [];
    let statements = 0;
    const runStatement = async <T>(statement: (c: RawClient) => Promise<T>) => {
      statements += 1;
      // The match and the first chunk run; the second chunk is out of time.
      if (statements === 3) throw new Error('out of time');
      return statement(inner.client);
    };

    await expect(
      preRedactSubjectFromDeliveries(
        outer.client,
        'hook',
        SUBJECT,
        (n) => heard.push(n),
        runStatement
      )
    ).rejects.toThrow('out of time');

    expect(heard).toEqual([5_000]);
    expect(inner.executeRaw).toHaveBeenCalledTimes(1);
  });

  it('runs on `client` itself when no runner is given', async () => {
    const outer = makeClient([]);
    outer.queryRaw.mockResolvedValueOnce(matchedIds(1) as unknown as RawRow[]);
    outer.executeRaw.mockResolvedValueOnce(1);

    await preRedactSubjectFromDeliveries(outer.client, 'webhook', SUBJECT);

    expect(outer.queryRaw).toHaveBeenCalledTimes(1);
    expect(outer.executeRaw).toHaveBeenCalledTimes(1);
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

describe('who a payload about to be sent names (t-886)', () => {
  function owners(conversation: { userId: string | null } | null, execution = conversation) {
    return {
      aiConversation: { findUnique: vi.fn().mockResolvedValue(conversation) },
      aiWorkflowExecution: { findUnique: vi.fn().mockResolvedValue(execution) },
    };
  }

  it('looks up the conversation and the run side by side, naming them in the same order (t-926)', async () => {
    let releaseConversation: (value: { userId: string }) => void = () => undefined;
    const client = {
      aiConversation: {
        findUnique: vi.fn(
          () => new Promise<{ userId: string }>((resolve) => (releaseConversation = resolve))
        ),
      },
      aiWorkflowExecution: {
        findUnique: vi.fn().mockResolvedValue({
          userId: 'run-owner',
          startedAt: new Date('2026-10-01T00:00:00Z'),
          createdAt: new Date('2026-09-30T00:00:00Z'),
        }),
      },
    };

    const pending = subjectsOfPayload(client as never, 'workflow_failed', {
      event: 'workflow_failed',
      data: { conversationId: 'conv-1', executionId: 'exec-1' },
    });
    // The run's lookup has started while the conversation's is still out.
    await vi.waitFor(() => expect(client.aiWorkflowExecution.findUnique).toHaveBeenCalled());
    releaseConversation({ userId: 'chat-owner' });
    const named = await pending;

    expect([...named.userIds.keys()]).toEqual(['chat-owner', 'run-owner']);
    expect(named.runStartedAt).toEqual(new Date('2026-10-01T00:00:00Z'));
    expect(named.dangling).toBe(false);
  });

  it('counts a conversation or run asked about and not returned as dangling, whatever the client says', async () => {
    const client = {
      aiConversation: { findUnique: vi.fn().mockResolvedValue(undefined) },
      aiWorkflowExecution: { findUnique: vi.fn().mockResolvedValue(undefined) },
    };

    const named = await subjectsOfPayload(client as never, 'workflow_failed', {
      event: 'workflow_failed',
      data: { conversationId: 'conv-gone' },
    });

    expect(named.dangling).toBe(true);
  });

  it('reads the payload as it was handed over, not as it is after the lookups', async () => {
    let release: (value: null) => void = () => undefined;
    const client = {
      aiConversation: {
        findUnique: vi.fn(() => new Promise<null>((resolve) => (release = resolve))),
      },
      aiWorkflowExecution: { findUnique: vi.fn() },
    };
    const data: Record<string, unknown> = { conversationId: 'conv-1', userId: 'u-1' };

    const pending = subjectsOfPayload(client as never, 'message_created', {
      event: 'message_created',
      data,
    } as never);
    // The caller reuses its object after handing it over.
    delete data.userId;
    release(null);
    const named = await pending;

    expect([...named.userIds.keys()]).toEqual(['u-1']);
  });

  it('names every person key, on the basis erasure matches it on, activity winning', async () => {
    const client = owners(null);
    const named = await subjectsOfPayload(client as never, 'workflow_failed', {
      event: 'workflow_failed',
      data: { userId: 'u-1', actorUserId: 'u-2', approverUserIds: ['u-3', 'u-1', 7] },
    });

    expect([...named.userIds]).toEqual([
      ['u-1', 'activity'],
      ['u-2', 'activity'],
      ['u-3', 'actor'],
    ]);
    expect(named.dangling).toBe(false);
    expect(client.aiConversation.findUnique).not.toHaveBeenCalled();
  });

  it('reads actorUserId on an admin action as the actor, not the activity', async () => {
    const named = await subjectsOfPayload(owners(null) as never, ADMIN_ACTION_EVENTS[0], {
      data: { actorUserId: 'admin-1' },
    });

    expect(named.userIds.get('admin-1')).toBe('actor');
  });

  it('names the owners of the conversation and the run the payload names', async () => {
    const client = {
      aiConversation: { findUnique: vi.fn().mockResolvedValue({ userId: 'conv-owner' }) },
      aiWorkflowExecution: { findUnique: vi.fn().mockResolvedValue({ userId: 'run-owner' }) },
    };
    const named = await subjectsOfPayload(client as never, 'x', {
      data: { conversationId: 'c-1', executionId: 'e-1' },
    });

    expect([...named.userIds]).toEqual([
      ['conv-owner', 'activity'],
      ['run-owner', 'activity'],
    ]);
    expect(client.aiConversation.findUnique).toHaveBeenCalledWith({
      where: { id: 'c-1' },
      select: { userId: true },
    });
    expect(named.dangling).toBe(false);
  });

  it('is dangling when a conversation or run it names no longer exists', async () => {
    const named = await subjectsOfPayload(
      { ...owners(null), aiWorkflowExecution: { findUnique: vi.fn() } } as never,
      'x',
      { data: { conversationId: 'gone' } }
    );

    expect(named).toEqual({ userIds: new Map(), dangling: true, runStartedAt: null });
  });

  it('names nobody in a payload with no data, or a system-owned run', async () => {
    expect(await subjectsOfPayload(owners(null) as never, 'x', null)).toEqual({
      userIds: new Map(),
      dangling: false,
      runStartedAt: null,
    });
    const createdAt = new Date('2026-10-22T08:00:00Z');
    expect(
      await subjectsOfPayload(
        owners({ userId: null, startedAt: null, createdAt } as never) as never,
        'x',
        { data: { executionId: 'scheduled' } }
      )
    ).toEqual({ userIds: new Map(), dangling: false, runStartedAt: createdAt });
  });

  it('says when the run it names started: an event from run memory holds a copy from then', async () => {
    const startedAt = new Date('2026-10-20T09:00:00Z');
    const client = {
      aiConversation: { findUnique: vi.fn() },
      aiWorkflowExecution: {
        findUnique: vi.fn().mockResolvedValue({ userId: 'u-1', startedAt, createdAt: new Date(0) }),
      },
    };

    const named = await subjectsOfPayload(client as never, 'workflow.paused_for_approval', {
      data: { executionId: 'e-1', approverUserIds: ['a-1'] },
    });

    expect(named.runStartedAt).toEqual(startedAt);
    expect(client.aiWorkflowExecution.findUnique).toHaveBeenCalledWith({
      where: { id: 'e-1' },
      select: { userId: true, startedAt: true, createdAt: true },
    });
  });
});

describe('a payload with the people erased since taken out (t-886)', () => {
  const activity = new Map<string, 'activity' | 'actor'>([['u-1', 'activity']]);
  const actor = new Map<string, 'activity' | 'actor'>([['admin-1', 'actor']]);

  it('stops an activity payload, redacted as erasure redacts the row', () => {
    const result = withoutErasedSubjects(
      { event: 'e', data: { workflowId: 'wf', userId: 'u-1', reason: 'theirs' } },
      { userIds: activity, dangling: false },
      ['u-1'],
      false
    );

    expect(result).toEqual({
      stop: true,
      payload: { event: 'e', data: { workflowId: 'wf', userId: null } },
    });
  });

  it('sends an actor payload without who acted', () => {
    const result = withoutErasedSubjects(
      {
        event: 'agent_updated',
        data: { changes: { a: 1 }, actorUserId: 'admin-1', actorUserName: 'Ada' },
      },
      { userIds: actor, dangling: false },
      ['admin-1'],
      false
    );

    expect(result).toEqual({
      stop: false,
      payload: { event: 'agent_updated', data: { changes: { a: 1 }, actorUserId: null } },
    });
  });

  it('leaves a payload alone when nobody it names was erased, or only someone it does not name', () => {
    const payload = { event: 'e', data: { userId: 'u-1' } };

    expect(
      withoutErasedSubjects(payload, { userIds: activity, dangling: false }, [], false)
    ).toEqual({ stop: false, payload: null });
    expect(
      withoutErasedSubjects(payload, { userIds: activity, dangling: false }, ['stranger'], false)
    ).toEqual({ stop: false, payload: null });
  });

  it('stops a dangling payload, to its record keys, only when someone was erased since', () => {
    const payload = {
      event: 'e',
      data: { conversationId: 'gone', prompt: 'theirs', actorUserName: 'Ada', userId: 'u-x' },
    };
    const dangling = { userIds: new Map<string, 'activity' | 'actor'>(), dangling: true };

    expect(withoutErasedSubjects(payload, dangling, [], true)).toEqual({
      stop: true,
      payload: { event: 'e', data: { conversationId: 'gone' } },
    });
    expect(withoutErasedSubjects(payload, dangling, [], false)).toEqual({
      stop: false,
      payload: null,
    });
  });
});
