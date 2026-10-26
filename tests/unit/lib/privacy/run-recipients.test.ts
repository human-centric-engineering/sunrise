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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Prisma } from '@prisma/client';
import { ErasureDeferredError } from '@/lib/privacy/erasure-deadline';
import {
  ERASED_VALUE,
  PRE_PASS_PAGE_TIMEOUT_MS,
  RUN_CLOCK_SKEW_MS,
  RUN_PAGE_SIZE,
  eraseFromRunInputs,
  findErasedSinceCopy,
  findErasedSinceRunStarted,
  preRedactSubjectFromRuns,
  redactSubjectFromRunsSince,
  redactErased,
  redactPerson,
  redactTurns,
  toStoredJson,
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
  supervisorReport?: Prisma.JsonValue | null;
};
/** A row of one of the run's side tables, found by the run it belongs to. */
type SideRow = { id: string; executionId: string } & Record<string, Prisma.JsonValue | string>;
type SideRows = { steps?: SideRow[]; dispatches?: SideRow[]; events?: SideRow[] };

function sqlOf(call: unknown[]): string {
  const strings = call[0] as TemplateStringsArray;
  return strings.join('?');
}

/** A side-table delegate: the run's rows are read by `$queryRaw`, written by `updateMany`. */
function makeSideDelegate() {
  return { updateMany: vi.fn(async (..._args: unknown[]) => ({ count: 1 })) };
}

/** The three side tables a run keeps rows in, as a tx exposes them (t-882). */
function makeSideTables() {
  return {
    aiWorkflowRunningStep: makeSideDelegate(),
    aiWorkflowStepDispatch: makeSideDelegate(),
    aiWorkflowExecutionLeaseEvent: makeSideDelegate(),
  };
}

/**
 * Answer a side-table read (`SELECT s.id, s.turns ...`) with the rows of the
 * run it was asked about, or null when `call` is not one. The real SQL narrows
 * by the row's own text; here every row of the run comes back and the code
 * under test decides what to write.
 */
function sideRowsFor(side: SideRows, call: unknown[]): SideRow[] | null {
  const sql = sqlOf(call);
  const executionId = call[1];
  const table = sql.includes('SELECT s.id, s.turns')
    ? side.steps
    : sql.includes('SELECT d.id, d.result')
      ? side.dispatches
      : sql.includes('SELECT l.id, l.metadata')
        ? side.events
        : undefined;
  if (
    !sql.includes('SELECT s.id, s.turns') &&
    !sql.includes('SELECT d.id, d.result') &&
    !sql.includes('SELECT l.id, l.metadata')
  )
    return null;
  return (table ?? []).filter((r) => r.executionId === executionId);
}

/** A tx whose raw reads page through the given rows by table. */
function makeTx(schedules: ScheduleRow[][], executions: ExecutionRow[][], side: SideRows = {}) {
  const pages = { schedules: [...schedules], executions: [...executions] };
  return {
    $queryRaw: vi.fn((...call: unknown[]) => {
      const sql = sqlOf(call);
      const sideRows = sideRowsFor(side, call);
      if (sideRows) return Promise.resolve(sideRows);
      if (sql.includes('ai_workflow_schedule'))
        return Promise.resolve(pages.schedules.shift() ?? []);
      if (sql.includes('ai_workflow_execution')) {
        return Promise.resolve(pages.executions.shift() ?? []);
      }
      throw new Error(`unexpected query: ${sql}`);
    }),
    aiWorkflowSchedule: { update: vi.fn() },
    aiWorkflowExecution: { update: vi.fn() },
    ...makeSideTables(),
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
      sqlOf(c).includes('FROM ai_workflow_execution e')
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

describe('eraseFromRunInputs — supervisor report and side rows (t-882)', () => {
  const cleanRun = (id: string, extra: Partial<ExecutionRow> = {}): ExecutionRow => ({
    id,
    inputData: { region: 'eu' },
    executionTrace: [],
    ...extra,
  });

  it('redacts the person from a supervisor report: their id in prose, their address as a whole value', async () => {
    const report: Prisma.JsonValue = {
      verdict: 'pass',
      summary: `Step approve was signed off by ${USER_ID} after review.`,
      recipient: ADDRESS,
      findings: ['retained: nothing sensitive'],
    };
    const tx = makeTx([[]], [[cleanRun('exec-report', { supervisorReport: report })]]);

    const result = await run(tx);

    expect(result.executionsRedacted).toBe(1);
    expect(tx.aiWorkflowExecution.update).toHaveBeenCalledWith({
      where: { id: 'exec-report' },
      data: {
        supervisorReport: {
          verdict: 'pass',
          summary: `Step approve was signed off by ${ERASED_VALUE} after review.`,
          recipient: ERASED_VALUE,
          findings: ['retained: nothing sensitive'],
        },
      },
    });
  });

  it('rewrites side rows of a run whose own columns do not name them, and counts the run once', async () => {
    const tx = makeTx([[]], [[cleanRun('exec-side')]], {
      steps: [
        {
          id: 'step-1',
          executionId: 'exec-side',
          turns: [{ role: 'user', content: `Please ask ${USER_ID} to confirm` }],
        },
      ],
      dispatches: [
        {
          id: 'disp-1',
          executionId: 'exec-side',
          result: { sentTo: ADDRESS, messageId: 'msg-77' },
        },
      ],
      events: [
        {
          id: 'evt-1',
          executionId: 'exec-side',
          metadata: { actorUserId: USER_ID, reason: 'stuck' },
        },
      ],
    });

    const result = await run(tx);

    expect(result.executionsRedacted).toBe(1);
    expect(tx.aiWorkflowExecution.update).not.toHaveBeenCalled();
    expect(tx.aiWorkflowRunningStep.updateMany).toHaveBeenCalledWith({
      where: { id: 'step-1' },
      data: { turns: [{ role: 'user', content: `Please ask ${ERASED_VALUE} to confirm` }] },
    });
    expect(tx.aiWorkflowStepDispatch.updateMany).toHaveBeenCalledWith({
      where: { id: 'disp-1' },
      data: { result: { sentTo: ERASED_VALUE, messageId: 'msg-77' } },
    });
    expect(tx.aiWorkflowExecutionLeaseEvent.updateMany).toHaveBeenCalledWith({
      where: { id: 'evt-1' },
      data: { metadata: { actorUserId: ERASED_VALUE, reason: 'stuck' } },
    });
  });

  it('writes no side row that names someone else, while still rewriting one that names them', async () => {
    const tx = makeTx([[]], [[cleanRun('exec-other'), cleanRun('exec-mine')]], {
      steps: [
        { id: 'step-other', executionId: 'exec-other', turns: [{ content: 'ask cmsomeoneelse' }] },
      ],
      dispatches: [
        { id: 'disp-other', executionId: 'exec-other', result: { to: 'gone@bar.com.au' } },
        { id: 'disp-mine', executionId: 'exec-mine', result: { to: ADDRESS } },
      ],
      events: [
        { id: 'evt-other', executionId: 'exec-other', metadata: { actorUserId: ACTOR } },
        { id: 'evt-null', executionId: 'exec-mine', metadata: null },
      ],
    });

    const result = await run(tx);

    // Positive control: the run that does name them was rewritten, so the
    // side rows of the other run were read and judged, not skipped.
    expect(result.executionsRedacted).toBe(1);
    expect(tx.aiWorkflowStepDispatch.updateMany).toHaveBeenCalledOnce();
    expect(tx.aiWorkflowStepDispatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'disp-mine' } })
    );
    expect(tx.aiWorkflowRunningStep.updateMany).not.toHaveBeenCalled();
    expect(tx.aiWorkflowExecutionLeaseEvent.updateMany).not.toHaveBeenCalled();
  });

  it('narrows the runs it reads by the supervisor report and one EXISTS per side table, never string_agg', async () => {
    const tx = makeTx([[]], [[]]);

    await run(tx);

    const execCall = tx.$queryRaw.mock.calls.find((c) =>
      sqlOf(c).includes('FROM ai_workflow_execution e')
    );
    expect(execCall).toBeDefined();
    const sql = sqlOf(execCall as unknown[]);
    expect(sql).toContain('e."supervisorReport"::text');
    expect(sql).toContain('EXISTS (SELECT 1 FROM ai_workflow_running_step s');
    expect(sql).toContain('EXISTS (SELECT 1 FROM ai_workflow_step_dispatch d');
    expect(sql).toContain('EXISTS (SELECT 1 FROM ai_workflow_execution_lease_event l');
    expect(sql).not.toContain('string_agg');
    // The report is also selected, so redactRunRow can rewrite it.
    expect(sql.split('FROM ai_workflow_execution e')[0]).toContain('e."supervisorReport"');
  });

  it('reads each side table narrowed by that table’s own text, for this run and this person', async () => {
    const tx = makeTx([[]], [[cleanRun('exec-side')]]);

    await run(tx);

    const reads = tx.$queryRaw.mock.calls.filter((c) =>
      /SELECT (s\.id, s\.turns|d\.id, d\.result|l\.id, l\.metadata)/.test(sqlOf(c))
    );
    const tables = reads.map((c) => sqlOf(c).match(/FROM (ai_workflow_\w+) [sdl]\n/)?.[1]);
    expect(tables).toEqual([
      'ai_workflow_running_step',
      'ai_workflow_step_dispatch',
      'ai_workflow_execution_lease_event',
    ]);
    for (const call of reads) {
      expect(sqlOf(call)).toContain('strpos(');
      expect(sqlOf(call)).toContain('"executionId" =');
      expect(call).toContain('exec-side');
      expect(call).toContain(USER_ID);
    }
  });

  it('drops a turn’s reasoning that names the person from a running step, and redacts the rest', async () => {
    const keptReasoning = { text: 'weighing the options', signature: 'sig-keep' };
    const tx = makeTx([[]], [[cleanRun('exec-think')]], {
      steps: [
        {
          id: 'step-think',
          executionId: 'exec-think',
          turns: [
            {
              role: 'assistant',
              reasoning: { text: `${USER_ID} asked for this`, signature: 'sig-gone' },
              content: `Notify ${USER_ID}`,
            },
            { role: 'assistant', reasoning: keptReasoning, content: 'next' },
          ],
        },
      ],
    });

    const result = await run(tx);

    expect(result.executionsRedacted).toBe(1);
    expect(tx.aiWorkflowRunningStep.updateMany).toHaveBeenCalledWith({
      where: { id: 'step-think' },
      data: {
        turns: [
          { role: 'assistant', content: `Notify ${ERASED_VALUE}` },
          { role: 'assistant', reasoning: keptReasoning, content: 'next' },
        ],
      },
    });
  });

  it('carries on when a side row was deleted since the read (updateMany count 0)', async () => {
    const tx = makeTx(
      [[]],
      [[cleanRun('exec-gone'), cleanRun('exec-next', { inputData: { to: ADDRESS } })]],
      {
        steps: [{ id: 'step-gone', executionId: 'exec-gone', turns: [{ content: USER_ID }] }],
        dispatches: [{ id: 'disp-gone', executionId: 'exec-gone', result: { to: ADDRESS } }],
      }
    );
    tx.aiWorkflowRunningStep.updateMany.mockResolvedValue({ count: 0 });
    tx.aiWorkflowStepDispatch.updateMany.mockResolvedValue({ count: 0 });

    const result = await run(tx);

    // Both writes were attempted and found nothing; the erasure went on to the next run.
    expect(tx.aiWorkflowRunningStep.updateMany).toHaveBeenCalledOnce();
    expect(tx.aiWorkflowStepDispatch.updateMany).toHaveBeenCalledOnce();
    expect(tx.aiWorkflowExecution.update).toHaveBeenCalledWith({
      where: { id: 'exec-next' },
      data: { inputData: { to: ERASED_VALUE } },
    });
    expect(result.executionsRedacted).toBe(2);
  });
});

describe('redactTurns (t-882)', () => {
  const redact = (value: Prisma.JsonValue) =>
    redactPerson(value, subject, ERASED_VALUE)?.value ?? value;

  it('drops a turn’s reasoning that names the person, and still redacts the rest of the turn', () => {
    const turns: Prisma.JsonValue = [
      {
        role: 'assistant',
        reasoning: { text: `ask ${USER_ID}`, signature: 'sig-1' },
        content: `Done for ${USER_ID}`,
        toolCalls: [{ id: 'tc-1', args: { to: ADDRESS } }],
      },
    ];

    expect(redactTurns(turns, redact)).toEqual([
      {
        role: 'assistant',
        content: `Done for ${ERASED_VALUE}`,
        toolCalls: [{ id: 'tc-1', args: { to: ERASED_VALUE } }],
      },
    ]);
  });

  it('keeps the reasoning of a turn whose reasoning does not name them, byte for byte', () => {
    const reasoning = { text: 'compare the two quotes', signature: 'sig-keep' };
    const turns: Prisma.JsonValue = [
      { role: 'assistant', reasoning, content: `Sent to ${USER_ID}` },
    ];

    const out = redactTurns(turns, redact) as Array<Record<string, Prisma.JsonValue>>;

    expect(out[0].content).toBe(`Sent to ${ERASED_VALUE}`);
    expect(JSON.stringify(out[0].reasoning)).toBe(JSON.stringify(reasoning));
  });

  it('redacts a value that is not an array as a whole', () => {
    expect(redactTurns({ note: USER_ID, reasoning: `r ${USER_ID}` }, redact)).toEqual({
      note: ERASED_VALUE,
      reasoning: `r ${ERASED_VALUE}`,
    });
    expect(redactTurns(`by ${USER_ID}`, redact)).toBe(`by ${ERASED_VALUE}`);
  });
});

describe('toStoredJson (t-882)', () => {
  it('stores undefined as null', () => {
    expect(toStoredJson(undefined)).toBeNull();
  });

  it('round-trips through JSON: a Date becomes its ISO string and undefined members vanish', () => {
    expect(
      toStoredJson({ at: new Date('2026-10-26T12:00:00.000Z'), gone: undefined, n: 3 })
    ).toEqual({ at: '2026-10-26T12:00:00.000Z', n: 3 });
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
  });
});

describe('preRedactSubjectFromRuns with a deadline (t-845)', () => {
  const started = new Date('2026-10-17T12:00:00.000Z');
  const NOW = new Date('2026-10-20T12:00:00.000Z');

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const page = (start: number, n: number): ExecutionRow[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `exec-${String(start + i).padStart(5, '0')}`,
      inputData: {},
      executionTrace: [{ output: { approverUserIds: [USER_ID] } }],
    }));

  /** A client that runs each page against `tx`, which also takes the statement bounds. */
  function makeClient(pages: ExecutionRow[][], onTransaction?: () => void) {
    const tx = { ...makeTx([], pages), $executeRaw: vi.fn(async (..._call: unknown[]) => 1) };
    const client = {
      $queryRaw: vi.fn(async () => [{ now: started }]),
      $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>, _options?: unknown) => {
        onTransaction?.();
        return fn(tx);
      }),
    };
    return { client, tx };
  }

  it('caps each page at the time left, with a 2s connection wait, and bounds its statements to it', async () => {
    const { client, tx } = makeClient([page(0, 2)]);

    await preRedactSubjectFromRuns(
      client as never,
      subject,
      () => undefined,
      new Date(NOW.getTime() + 20_000)
    );

    expect(client.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 20_000,
      maxWait: 2_000,
    });
    const [strings, ...values] = tx.$executeRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(strings.join('?')).toContain('statement_timeout');
    expect(values).toEqual(['20000ms', '20000ms']);
  });

  it('keeps the page timeout as the cap when much more time than that is left', async () => {
    const { client } = makeClient([page(0, 2)]);

    await preRedactSubjectFromRuns(
      client as never,
      subject,
      () => undefined,
      new Date(NOW.getTime() + 60 * 60_000)
    );

    expect(client.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: PRE_PASS_PAGE_TIMEOUT_MS,
      maxWait: 2_000,
    });
  });

  it('opens no page and throws a deferral when the deadline has already passed', async () => {
    const { client } = makeClient([page(0, 2)]);
    const committed: number[] = [];

    const error = await preRedactSubjectFromRuns(
      client as never,
      subject,
      (n) => committed.push(n),
      new Date(NOW.getTime() - 1)
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ErasureDeferredError);
    expect((error as ErasureDeferredError).stage).toBe('a run pre-pass page');
    expect(client.$transaction).not.toHaveBeenCalled();
    expect(committed).toEqual([]);
  });

  it('stops between pages once time runs out, keeping what the earlier pages committed', async () => {
    // The first (full) page takes the rest of the time.
    const { client } = makeClient([page(0, RUN_PAGE_SIZE), page(RUN_PAGE_SIZE, 2)], () => {
      if (client.$transaction.mock.calls.length === 1) {
        vi.setSystemTime(new Date(NOW.getTime() + 11_000));
      }
    });
    const committed: number[] = [];

    const error = await preRedactSubjectFromRuns(
      client as never,
      subject,
      (n) => committed.push(n),
      new Date(NOW.getTime() + 10_000)
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ErasureDeferredError);
    expect(client.$transaction).toHaveBeenCalledTimes(1);
    expect(committed).toEqual([RUN_PAGE_SIZE]);
  });

  it('turns a page that fails after the deadline into a deferral, keeping the failure as the cause', async () => {
    const { client } = makeClient([]);
    const failure = new Error('canceling statement due to statement timeout');
    client.$transaction.mockImplementation(async () => {
      vi.setSystemTime(new Date(NOW.getTime() + 11_000));
      throw failure;
    });

    const error = await preRedactSubjectFromRuns(
      client as never,
      subject,
      () => undefined,
      new Date(NOW.getTime() + 10_000)
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ErasureDeferredError);
    expect((error as ErasureDeferredError).cause).toBe(failure);
  });

  it('rethrows a page failure unchanged while time remains', async () => {
    const { client } = makeClient([]);
    client.$transaction.mockRejectedValue(new Error('deadlock detected'));

    await expect(
      preRedactSubjectFromRuns(
        client as never,
        subject,
        () => undefined,
        new Date(NOW.getTime() + 10_000)
      )
    ).rejects.toThrow('deadlock detected');
  });
});

describe('redactSubjectFromRunsSince (t-843)', () => {
  const since = new Date('2026-10-20T10:00:00.000Z');

  /** A client whose id reads page through `pages`, and whose row reads come from `rows`. */
  function makeClient(pages: string[][], rows: Record<string, ExecutionRow>, side: SideRows = {}) {
    const tx = {
      $queryRaw: vi.fn(async (...call: unknown[]) => {
        const sideRows = sideRowsFor(side, call);
        if (sideRows) return sideRows;
        const id = call[1] as string;
        return rows[id]
          ? [{ outputData: null, errorMessage: null, supervisorReport: null, ...rows[id] }]
          : [];
      }),
      aiWorkflowExecution: { update: vi.fn() },
      ...makeSideTables(),
    };
    const client = {
      $queryRaw: vi.fn(async () => (pages.shift() ?? []).map((id) => ({ id }))),
      $transaction: vi.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    return { client, tx };
  }

  it('reads the runs not finished or written since, without narrowing by their text', async () => {
    const { client } = makeClient([[]], {});

    await redactSubjectFromRunsSince(client as never, subject, since);

    const call = client.$queryRaw.mock.calls[0] as unknown[];
    const sql = sqlOf(call);
    expect(sql).toContain("e.status IN ('pending', 'running')");
    expect(sql).toContain('"updatedAt" >=');
    expect(sql).not.toContain('strpos');
    expect(sql).not.toContain('FOR NO KEY UPDATE');
    expect(call).toContain(since);
    expect(call).toContain(RUN_CLOCK_SKEW_MS);
  });

  it('locks and redacts each run in a transaction of its own, and counts the ones that named them', async () => {
    const { client, tx } = makeClient([['exec-1', 'exec-2']], {
      'exec-1': { id: 'exec-1', inputData: {}, executionTrace: [{ output: { to: ADDRESS } }] },
      'exec-2': {
        id: 'exec-2',
        inputData: {},
        executionTrace: [{ output: { to: 'keep@bar.com' } }],
      },
    });

    const result = await redactSubjectFromRunsSince(client as never, subject, since);

    expect(result).toEqual({ redacted: 1, failed: 0, lastError: null });
    expect(client.$transaction).toHaveBeenCalledTimes(2);
    const rowRead = tx.$queryRaw.mock.calls[0];
    expect(sqlOf(rowRead)).toContain('FOR NO KEY UPDATE');
    expect(rowRead).toContain('exec-1');
    expect(tx.aiWorkflowExecution.update).toHaveBeenCalledOnce();
    expect(tx.aiWorkflowExecution.update).toHaveBeenCalledWith({
      where: { id: 'exec-1' },
      data: { executionTrace: [{ output: { to: ERASED_VALUE } }] },
    });
  });

  it('reads the supervisor report with the row it locks, and redacts it', async () => {
    const { client, tx } = makeClient([['exec-rep']], {
      'exec-rep': {
        id: 'exec-rep',
        inputData: {},
        executionTrace: [],
        supervisorReport: { summary: `Approved by ${USER_ID}` },
      },
    });

    const result = await redactSubjectFromRunsSince(client as never, subject, since);

    expect(sqlOf(tx.$queryRaw.mock.calls[0])).toContain('e."supervisorReport"');
    expect(result.redacted).toBe(1);
    expect(tx.aiWorkflowExecution.update).toHaveBeenCalledWith({
      where: { id: 'exec-rep' },
      data: { supervisorReport: { summary: `Approved by ${ERASED_VALUE}` } },
    });
  });

  it('redacts a side row written since, and counts the run, when its own columns are clean', async () => {
    const { client, tx } = makeClient(
      [['exec-clean', 'exec-late']],
      {
        'exec-clean': { id: 'exec-clean', inputData: {}, executionTrace: [] },
        'exec-late': { id: 'exec-late', inputData: {}, executionTrace: [] },
      },
      {
        dispatches: [
          { id: 'disp-keep', executionId: 'exec-clean', result: { to: 'keep@bar.com' } },
          { id: 'disp-late', executionId: 'exec-late', result: { to: ADDRESS, ok: true } },
        ],
      }
    );

    const result = await redactSubjectFromRunsSince(client as never, subject, since);

    // Positive control: exec-clean's side row was read and left; exec-late's was rewritten.
    expect(result).toEqual({ redacted: 1, failed: 0, lastError: null });
    expect(tx.aiWorkflowExecution.update).not.toHaveBeenCalled();
    expect(tx.aiWorkflowStepDispatch.updateMany).toHaveBeenCalledOnce();
    expect(tx.aiWorkflowStepDispatch.updateMany).toHaveBeenCalledWith({
      where: { id: 'disp-late' },
      data: { result: { to: ERASED_VALUE, ok: true } },
    });
  });

  it('carries on past a run it cannot lock, and says how many it missed', async () => {
    const { client, tx } = makeClient([['exec-1', 'exec-2']], {
      'exec-2': { id: 'exec-2', inputData: {}, executionTrace: [{ output: { to: ADDRESS } }] },
    });
    const run = client.$transaction.getMockImplementation();
    client.$transaction
      .mockRejectedValueOnce(new Error('lock timeout'))
      .mockImplementation((fn) => run!(fn));

    const result = await redactSubjectFromRunsSince(client as never, subject, since);

    expect(result).toEqual({ redacted: 1, failed: 1, lastError: 'lock timeout' });
    expect(tx.aiWorkflowExecution.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'exec-2' } })
    );
    // Waits for a connection as the engine's writes do, not Prisma's 2 s.
    expect(client.$transaction).toHaveBeenLastCalledWith(
      expect.any(Function),
      expect.objectContaining({ maxWait: 10_000 })
    );
  });

  it('pages on by id', async () => {
    const first = Array.from(
      { length: RUN_PAGE_SIZE },
      (_, i) => `exec-${String(i).padStart(5, '0')}`
    );
    const { client } = makeClient([first, []], {});

    await redactSubjectFromRunsSince(client as never, subject, since);

    expect(client.$queryRaw).toHaveBeenCalledTimes(2);
    expect(client.$queryRaw.mock.calls[1]).toContain(first.at(-1));
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

describe('findErasedSinceCopy (§122 t-901)', () => {
  const hash = (a: string) => createHash('sha256').update(a).digest('hex');
  type Receipt = { subjectUserId: string; subjectEmailHash: string | null };

  function makeWriterTx(since: Receipt[]) {
    return {
      $queryRaw: vi.fn(async () => since),
      dataErasureReceipt: {
        findMany: vi.fn(async () =>
          since.map((r) => ({ ...r, metadata: { addressVerified: true } }))
        ),
      },
      user: { findMany: vi.fn(async () => []) },
    };
  }

  it('asks for receipts since the copy was taken, less the margin, and is null when none', async () => {
    const tx = makeWriterTx([]);
    const takenAt = new Date('2026-10-22T12:00:00Z');

    expect(await findErasedSinceCopy(tx as never, takenAt, [{ to: ADDRESS }])).toBeNull();

    const call = tx.$queryRaw.mock.calls[0] as unknown[];
    expect(sqlOf(call)).toContain('"erasedAt" >=');
    expect(call).toContain(takenAt);
    expect(call).toContain(RUN_CLOCK_SKEW_MS);
  });

  it('matches what the copy names as findErasedSinceRunStarted does', async () => {
    const tx = makeWriterTx([{ subjectUserId: USER_ID, subjectEmailHash: hash(ADDRESS) }]);

    const erased = await findErasedSinceCopy(tx as never, new Date(), [
      { summary: `Approved by ${USER_ID}`, to: ADDRESS },
    ]);

    expect(erased).toEqual({ addresses: [ADDRESS], userIds: [USER_ID] });
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
