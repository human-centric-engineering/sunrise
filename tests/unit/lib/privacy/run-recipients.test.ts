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
import { describe, it, expect, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import {
  ERASED_VALUE,
  RUN_PAGE_SIZE,
  eraseFromRunInputs,
  preRedactSubjectFromRuns,
  redactPerson,
} from '@/lib/privacy/run-recipients';

const USER_ID = 'cmuser00000000000000erase';
const ADDRESS = 'gone@bar.com';
const ACTOR = 'cmuser00000000000000actor';
const subject = { userId: USER_ID, address: ADDRESS };

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
      redactPerson({ cc: '', tags: ['', 'ops'] }, { userId: '', address: ADDRESS }, '')
    ).toBeNull();
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
type ExecutionRow = { id: string; inputData: Prisma.JsonValue; executionTrace: Prisma.JsonValue };

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
    expect(committed).toEqual([RUN_PAGE_SIZE, 2]);
  });
});
