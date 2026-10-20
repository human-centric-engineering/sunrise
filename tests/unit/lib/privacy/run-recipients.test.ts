/**
 * Tests: lib/privacy/run-recipients.ts — schedules and runs that name an erased
 * person (t-804).
 *
 * `redactPerson` is pure and tested on values. The two passes run against a
 * hand-built transaction whose `$queryRaw` routes on the SQL text, as
 * `config-recipients.test.ts` does; the real narrowing SQL is proved against
 * Postgres by `npm run smoke:erasure-config`.
 *
 * @see lib/privacy/run-recipients.ts
 */
import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import {
  ERASED_VALUE,
  PRE_PASS_PAGE_TIMEOUT_MS,
  RUN_CLOCK_SKEW_MS,
  RUN_PAGE_SIZE,
  eraseFromRunInputs,
  findErasedSinceRunStarted,
  preRedactSubjectFromRuns,
  redactSubjectFromRunsSince,
  redactErased,
  redactPerson,
} from '@/lib/privacy/run-recipients';

const USER_ID = 'cmuser00000000000000erase';
const ADDRESS = 'gone@bar.com';
const ACTOR = 'cmuser00000000000000actor';
const subject = { userId: USER_ID, address: ADDRESS };

describe('redactErased (t-841)', () => {
  it('applies the run rule for every erased address and id', () => {
    const pause = {
      prompt: 'Approve the send to x',
      previous: { to: 'Gone@Example.com', cc: ['keep@example.com'] },
      approverUserIds: ['cmgone', 'cmkept'],
      notificationChannel: { type: 'email', target: 'gone@example.com' },
      actor: 'admin:cmgone',
    };

    expect(redactErased(pause, { addresses: ['gone@example.com'], userIds: ['cmgone'] })).toEqual({
      prompt: 'Approve the send to x',
      previous: { to: ERASED_VALUE, cc: ['keep@example.com'] },
      approverUserIds: ['cmkept'],
      notificationChannel: { type: 'email' },
      actor: `admin:${ERASED_VALUE}`,
    });
  });

  it('returns the same value when it names none of them', () => {
    const value = { approverUserIds: ['cmkept'] };
    expect(redactErased(value, { addresses: ['x@example.com'], userIds: ['y'] })).toBe(value);
  });
});

describe('redactPerson', () => {
  it('takes their id out of an approver list and their address off a notification channel', () => {
    const trace: Prisma.JsonValue = [
      {
        stepId: 'approve',
        status: 'awaiting_approval',
        output: {
          approverUserIds: [USER_ID, 'cmuser00000000000000other'],
          notificationChannel: { type: 'email', target: ' Gone@BAR.com ' },
        },
        input: {
          approverUserIds: [USER_ID],
          notificationChannel: { type: 'email', target: ADDRESS },
        },
      },
    ];

    const change = redactPerson(trace, subject, ERASED_VALUE);

    expect(change?.value).toEqual([
      {
        stepId: 'approve',
        status: 'awaiting_approval',
        output: {
          approverUserIds: ['cmuser00000000000000other'],
          // The channel and its type stay; only where it pointed goes.
          notificationChannel: { type: 'email' },
        },
        input: { approverUserIds: [], notificationChannel: { type: 'email' } },
      },
    ]);
    expect(change?.removed).toBe(4);
  });

  it('replaces a standalone address with the replacement, and drops one from a list', () => {
    const change = redactPerson(
      { userEmail: 'GONE@bar.com', cc: [ADDRESS, 'keep@bar.com'], note: 'gone@bar.com is cc' },
      subject,
      ''
    );

    expect(change?.value).toEqual({
      userEmail: '',
      cc: ['keep@bar.com'],
      note: 'gone@bar.com is cc',
    });
    expect(change?.removed).toBe(2);
  });

  it('an empty id names nobody: empty strings in a template are left alone (review round 1)', () => {
    expect(
      redactPerson({ cc: '', tags: ['', 'ops'] }, { userId: null, address: ADDRESS }, '')
    ).toBeNull();
  });

  it('replaces their id inside a longer string, such as an approval actor label (review round 2)', () => {
    const change = redactPerson(
      { actor: `admin:${USER_ID}`, note: 'approved' },
      { userId: USER_ID, address: null },
      ERASED_VALUE
    );
    expect(change?.value).toEqual({ actor: `admin:${ERASED_VALUE}`, note: 'approved' });
  });

  it('answers null for a value that does not name them', () => {
    expect(redactPerson({ to: 'keep@bar.com', approverUserIds: ['x'] }, subject, '')).toBeNull();
  });

  it('with no verified address, matches only the id', () => {
    const change = redactPerson(
      { to: ADDRESS, approverUserIds: [USER_ID] },
      { userId: USER_ID, address: null },
      ERASED_VALUE
    );
    expect(change?.value).toEqual({ to: ADDRESS, approverUserIds: [] });
  });
});

type ScheduleRow = {
  id: string;
  name: string;
  workflowId: string;
  orgId: string | null;
  inputTemplate: Prisma.JsonValue;
};
type ExecutionRow = {
  id: string;
  inputData: Prisma.JsonValue;
  executionTrace: Prisma.JsonValue;
  outputData?: Prisma.JsonValue | null;
  errorMessage?: string | null;
};

function sqlOf(call: unknown[]): string {
  const strings = call[0] as TemplateStringsArray;
  return strings.join('?');
}

/** A tx whose raw reads page through the given rows by table. */
function makeTx(schedules: ScheduleRow[][], executions: ExecutionRow[][]) {
  const pages = { schedules: [...schedules], executions: [...executions] };
  return {
    $queryRaw: vi.fn((...call: unknown[]) => {
      const sql = sqlOf(call);
      if (sql.includes('ai_workflow_schedule'))
        return Promise.resolve(pages.schedules.shift() ?? []);
      if (sql.includes('ai_workflow_execution')) {
        return Promise.resolve(pages.executions.shift() ?? []);
      }
      throw new Error(`unexpected query: ${sql}`);
    }),
    aiWorkflowSchedule: { update: vi.fn() },
    aiWorkflowExecution: { update: vi.fn() },
    aiAdminAuditLog: { create: vi.fn() },
  };
}

function run(tx: ReturnType<typeof makeTx>, address: string | null = ADDRESS) {
  return eraseFromRunInputs(tx as never, { userId: USER_ID, address, actorUserId: ACTOR });
}

describe('eraseFromRunInputs — schedules', () => {
  const schedule = (inputTemplate: Prisma.JsonValue, id = 'sched-1'): ScheduleRow => ({
    id,
    name: 'Weekly digest',
    workflowId: 'wf-1',
    orgId: 'org-a',
    inputTemplate,
  });

  it('blanks their address in the template and audits it without the address', async () => {
    const tx = makeTx([[schedule({ userEmail: 'Gone@Bar.com', region: 'eu' })]], [[]]);

    const result = await run(tx);

    expect(result.schedulesChanged).toBe(1);
    expect(tx.aiWorkflowSchedule.update).toHaveBeenCalledWith({
      where: { id: 'sched-1' },
      data: { inputTemplate: { userEmail: '', region: 'eu' } },
    });
    expect(tx.aiAdminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: ACTOR,
        action: 'workflow_schedule.recipient_erased',
        entityType: 'workflow_schedule',
        entityId: 'sched-1',
        changes: { inputTemplateValuesCleared: { from: 1, to: 0 } },
        metadata: expect.objectContaining({ workflowId: 'wf-1', orgId: 'org-a' }),
      }),
    });
    expect(JSON.stringify(tx.aiAdminAuditLog.create.mock.calls).toLowerCase()).not.toContain(
      ADDRESS
    );
  });

  it('leaves the schedule enabled: nothing but the template is written', async () => {
    const tx = makeTx([[schedule({ userEmail: ADDRESS })]], [[]]);

    await run(tx);

    const [args] = tx.aiWorkflowSchedule.update.mock.calls[0] as [{ data: object }];
    expect(Object.keys(args.data)).toEqual(['inputTemplate']);
  });

  it('writes nothing for a template the narrowing matched that names someone else', async () => {
    const tx = makeTx([[schedule({ userEmail: 'gone@bar.com.au' })]], [[]]);

    expect((await run(tx)).schedulesChanged).toBe(0);
    expect(tx.aiWorkflowSchedule.update).not.toHaveBeenCalled();
    expect(tx.aiAdminAuditLog.create).not.toHaveBeenCalled();
  });

  it('does not read schedules at all for an unverified account', async () => {
    const tx = makeTx([[schedule({ userEmail: ADDRESS })]], [[]]);

    await run(tx, null);

    expect(tx.$queryRaw.mock.calls.some((c) => sqlOf(c).includes('ai_workflow_schedule'))).toBe(
      false
    );
    expect(tx.aiWorkflowSchedule.update).not.toHaveBeenCalled();
  });

  it('reads the rows it rewrites FOR NO KEY UPDATE', async () => {
    const tx = makeTx([[]], [[]]);

    await run(tx);

    for (const call of tx.$queryRaw.mock.calls) {
      expect(sqlOf(call)).toContain('FOR NO KEY UPDATE');
    }
  });
});

describe('eraseFromRunInputs — runs', () => {
  it('redacts a paused run: its approvers, its notification target and its input', async () => {
    const paused: ExecutionRow = {
      id: 'exec-paused',
      inputData: { userEmail: ADDRESS },
      executionTrace: [
        {
          stepId: 'approve',
          status: 'awaiting_approval',
          output: {
            approverUserIds: [USER_ID],
            notificationChannel: { type: 'email', target: ADDRESS },
          },
        },
      ],
    };
    const tx = makeTx([[]], [[paused]]);

    const result = await run(tx);

    expect(result.executionsRedacted).toBe(1);
    expect(tx.aiWorkflowExecution.update).toHaveBeenCalledWith({
      where: { id: 'exec-paused' },
      data: {
        inputData: { userEmail: ERASED_VALUE },
        executionTrace: [
          {
            stepId: 'approve',
            status: 'awaiting_approval',
            output: { approverUserIds: [], notificationChannel: { type: 'email' } },
          },
        ],
      },
    });
  });

  it('redacts a completed run’s outputData and errorMessage too (review round 3)', async () => {
    const done: ExecutionRow = {
      id: 'exec-done',
      inputData: {},
      executionTrace: [],
      outputData: {
        approve: { approved: true, actor: `admin:${USER_ID}` },
        notify: { to: ADDRESS },
      },
      errorMessage: `Rejected by ${USER_ID}`,
    };
    const tx = makeTx([[]], [[done]]);

    expect((await run(tx)).executionsRedacted).toBe(1);
    expect(tx.aiWorkflowExecution.update).toHaveBeenCalledWith({
      where: { id: 'exec-done' },
      data: {
        outputData: {
          approve: { approved: true, actor: `admin:${ERASED_VALUE}` },
          notify: { to: ERASED_VALUE },
        },
        errorMessage: `Rejected by ${ERASED_VALUE}`,
      },
    });
  });

  it('never reads the subject’s own runs: they cascade with the user row', async () => {
    const tx = makeTx([[]], [[]]);

    await run(tx);

    const execSql = tx.$queryRaw.mock.calls.find((c) => sqlOf(c).includes('ai_workflow_execution'));
    expect(execSql).toBeDefined();
    expect(sqlOf(execSql as unknown[])).toContain('"userId" IS DISTINCT FROM');
    expect(execSql).toContain(USER_ID);
  });

  it('pages through runs rather than reading them all at once', async () => {
    const page = (start: number, n: number): ExecutionRow[] =>
      Array.from({ length: n }, (_, i) => ({
        id: `exec-${String(start + i).padStart(5, '0')}`,
        inputData: {},
        executionTrace: [{ output: { approverUserIds: [USER_ID] } }],
      }));
    const tx = makeTx([[]], [page(0, RUN_PAGE_SIZE), page(RUN_PAGE_SIZE, 3)]);

    const result = await run(tx);

    expect(result.executionsRedacted).toBe(RUN_PAGE_SIZE + 3);
    const execCalls = tx.$queryRaw.mock.calls.filter((c) =>
      sqlOf(c).includes('ai_workflow_execution')
    );
    expect(execCalls).toHaveLength(2);
    // The second page starts after the last id of the first.
    expect(execCalls[1]).toContain(`exec-${String(RUN_PAGE_SIZE - 1).padStart(5, '0')}`);
  });

  it('writes nothing to a run the narrowing matched that names someone else', async () => {
    const tx = makeTx(
      [[]],
      [[{ id: 'exec-x', inputData: { to: 'gone@bar.co' }, executionTrace: [] }]]
    );

    expect((await run(tx)).executionsRedacted).toBe(0);
    expect(tx.aiWorkflowExecution.update).not.toHaveBeenCalled();
  });
});

describe('eraseFromRunInputs — after the pre-pass', () => {
  it('reads only runs written since the pre-pass started, or not yet finished', async () => {
    const since = new Date('2026-10-17T12:00:00.000Z');
    const tx = makeTx([[]], [[]]);

    await eraseFromRunInputs(
      tx as never,
      { userId: USER_ID, address: ADDRESS, actorUserId: ACTOR },
      since
    );

    const execCall = tx.$queryRaw.mock.calls.find((c) =>
      sqlOf(c).includes('ai_workflow_execution')
    );
    expect(execCall).toBeDefined();
    const sql = sqlOf(execCall as unknown[]);
    expect(sql).toContain('"updatedAt" >=');
    // Moved back for app-host clock skew, since updatedAt is the app's clock.
    expect(execCall).toContain(RUN_CLOCK_SKEW_MS);
    expect(sql).toContain("'paused_for_approval'");
    expect(execCall).toContain(since);
  });
});

describe('preRedactSubjectFromRuns', () => {
  it('commits each page in its own transaction and returns the database time it started', async () => {
    const started = new Date('2026-10-17T12:00:00.000Z');
    const page = (start: number, n: number): ExecutionRow[] =>
      Array.from({ length: n }, (_, i) => ({
        id: `exec-${String(start + i).padStart(5, '0')}`,
        inputData: {},
        executionTrace: [{ output: { approverUserIds: [USER_ID] } }],
      }));
    const tx = makeTx([], [page(0, RUN_PAGE_SIZE), page(RUN_PAGE_SIZE, 2)]);
    const client = {
      $queryRaw: vi.fn(async () => [{ now: started }]),
      $transaction: vi.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const committed: number[] = [];

    const result = await preRedactSubjectFromRuns(
      client as never,
      { userId: USER_ID, address: ADDRESS },
      (n) => committed.push(n)
    );

    expect(result).toBe(started);
    expect(client.$transaction).toHaveBeenCalledTimes(2);
    // Not Prisma's 5 s default: a page may scan the whole table (review round 3).
    expect(client.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: PRE_PASS_PAGE_TIMEOUT_MS,
    });
    expect(committed).toEqual([RUN_PAGE_SIZE, 2]);
    // The pre-pass narrows by the person's text (the flag the post-commit
    // pass sets is off).
    expect(tx.$queryRaw.mock.calls[0].slice(1)[5]).toBe(false);
  });
});

describe('redactSubjectFromRunsSince (t-843)', () => {
  it('pages over the runs written since, or not yet finished, and returns how many it redacted', async () => {
    const since = new Date('2026-10-20T10:00:00.000Z');
    const tx = makeTx(
      [],
      [[{ id: 'exec-1', inputData: {}, executionTrace: [{ output: { to: ADDRESS } }] }]]
    );
    const client = {
      $queryRaw: vi.fn(),
      $transaction: vi.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    };

    const redacted = await redactSubjectFromRunsSince(
      client as never,
      { userId: USER_ID, address: ADDRESS },
      since
    );

    expect(redacted).toBe(1);
    const call = tx.$queryRaw.mock.calls[0];
    expect(sqlOf(call)).toContain('"updatedAt" >=');
    expect(call).toContain(since);
    // Every candidate is locked, not only rows whose committed text names
    // them: a running workflow's write still open is waited for (review round 1).
    // The values in order: after, userId, since, since, skew, then the
    // read-every-candidate flag the text test is OR-ed with.
    expect(sqlOf(call)).toMatch(/AND \(\?\s+OR strpos/);
    expect(call.slice(1)[5]).toBe(true);
    expect(tx.aiWorkflowExecution.update).toHaveBeenCalledWith({
      where: { id: 'exec-1' },
      data: { executionTrace: [{ output: { to: ERASED_VALUE } }] },
    });
  });
});

describe('findErasedSinceRunStarted (t-843)', () => {
  const hash = (a: string) => createHash('sha256').update(a).digest('hex');
  type Receipt = { subjectUserId: string; subjectEmailHash: string | null };

  function makeWriterTx(sinceStart: Receipt[], verified = true) {
    return {
      $queryRaw: vi.fn(async () => sinceStart),
      dataErasureReceipt: {
        findMany: vi.fn(async () =>
          sinceStart.map((r) => ({ ...r, metadata: { addressVerified: verified } }))
        ),
      },
      user: { findMany: vi.fn(async () => []) },
    };
  }

  it('is null after the one query when nobody was erased since the run started', async () => {
    const tx = makeWriterTx([]);

    expect(await findErasedSinceRunStarted(tx as never, 'exec-1', [{ to: ADDRESS }])).toBeNull();

    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    const call = tx.$queryRaw.mock.calls[0] as unknown[];
    expect(sqlOf(call)).toContain('"erasedAt" >=');
    // From the run's own start, moved back for app-host clock skew.
    expect(sqlOf(call)).toContain('"startedAt"');
    expect(call).toContain('exec-1');
    expect(call).toContain(RUN_CLOCK_SKEW_MS);
    expect(tx.dataErasureReceipt.findMany).not.toHaveBeenCalled();
  });

  it('returns the address and the id the run names, matched as erasure matches them', async () => {
    const tx = makeWriterTx([{ subjectUserId: USER_ID, subjectEmailHash: hash(ADDRESS) }]);

    const erased = await findErasedSinceRunStarted(tx as never, 'exec-1', [
      { to: ' Gone@BAR.com ' },
      [{ output: { approverUserIds: [USER_ID] } }],
    ]);

    expect(erased).toEqual({ addresses: [ADDRESS], userIds: [USER_ID] });
  });

  it('is null when the run names nobody erased since it started', async () => {
    const tx = makeWriterTx([{ subjectUserId: USER_ID, subjectEmailHash: hash(ADDRESS) }]);

    const erased = await findErasedSinceRunStarted(tx as never, 'exec-1', [
      { to: 'keep@bar.com' },
      'cmuser00000000000000other',
    ]);

    expect(erased).toBeNull();
  });

  it('is null when their id is only a key, which redaction does not rewrite', async () => {
    const tx = makeWriterTx([{ subjectUserId: USER_ID, subjectEmailHash: null }]);

    const erased = await findErasedSinceRunStarted(tx as never, 'exec-1', [
      { scores: { [USER_ID]: 3 } },
    ]);

    expect(erased).toBeNull();
  });

  it('leaves an address erasure did not match as verified', async () => {
    const tx = makeWriterTx([{ subjectUserId: USER_ID, subjectEmailHash: hash(ADDRESS) }], false);

    expect(await findErasedSinceRunStarted(tx as never, 'exec-1', [{ to: ADDRESS }])).toBeNull();
  });
});

describe('eraseFromRunInputs — narrowing an address SQL cannot search', () => {
  it('narrows by the domain when the local part is not plain ASCII', async () => {
    const tx = makeTx([[]], [[]]);

    await eraseFromRunInputs(tx as never, {
      userId: USER_ID,
      address: 'zoë@example.com',
      actorUserId: ACTOR,
    });

    const execCall = tx.$queryRaw.mock.calls.find((c) =>
      sqlOf(c).includes('ai_workflow_execution')
    );
    // The domain is the search term, and the scan-everything flag is off.
    expect(execCall).toContain('example.com');
    expect(execCall).not.toContain('zoë@example.com');
  });

  it('reads every row when neither the address nor its domain can be searched', async () => {
    const tx = makeTx([[]], [[]]);

    await eraseFromRunInputs(tx as never, {
      userId: USER_ID,
      address: 'zoë@exämple.com',
      actorUserId: ACTOR,
    });

    const scheduleCall = tx.$queryRaw.mock.calls.find((c) =>
      sqlOf(c).includes('ai_workflow_schedule')
    );
    // scanAll is the first boolean parameter after the page cursor.
    expect(scheduleCall).toContain(true);
  });

  it('a run with no output and no error is only rewritten where it names them', async () => {
    const run1: ExecutionRow = {
      id: 'exec-plain',
      inputData: { to: ADDRESS },
      executionTrace: [],
      outputData: null,
      errorMessage: null,
    };
    const tx = makeTx([[]], [[run1]]);

    await run(tx);

    expect(tx.aiWorkflowExecution.update).toHaveBeenCalledWith({
      where: { id: 'exec-plain' },
      data: { inputData: { to: ERASED_VALUE } },
    });
  });
});
