/**
 * Schedules and workflow runs that name a person, for erasure (Art. 17)
 * (t-804).
 *
 * `config-recipients.ts` removes a person from workflow *definitions*. Two more
 * kinds of data hold them, and no foreign key reaches either:
 *
 *   • **A schedule's `inputTemplate`** — free-form JSON handed to every cron
 *     tick as the run's input. It is the documented home of a per-user
 *     scheduled workflow's literal address (`{ userEmail: 'x@co.com' }`, read by
 *     a `{{input.userEmail}}` recipient), so left alone it keeps emailing the
 *     erased person. A matching value is blanked — `''`, or taken out of a list
 *     — the same disposition t-791 gave a step's `to`: the step it feeds then
 *     has no recipient and **fails when it runs**, and its error strategy
 *     decides what follows. The schedule stays enabled, so the failure is seen
 *     rather than the workflow quietly stopping, and the admin who owns it
 *     points it somewhere else.
 *   • **A run's input and trace** — another person's run keeps a copy of
 *     everything it was given and did: the schedule's input (`inputData`), and
 *     each step's config and output (`executionTrace`), which is where a run
 *     **paused at an approval** keeps its `approverUserIds` and its
 *     notification target — what the approval routes read until retention
 *     prunes the run. Each is redacted the way t-791 redacts a definition: the
 *     person's id leaves every approver list, a notification target that is
 *     their address is removed (the channel and its type stay), and any other
 *     value that is their address or their id becomes `[erased]` — the record
 *     keeps its shape and says something was taken out, as a webhook
 *     delivery's destination does. The subject's **own** runs are not read:
 *     they cascade with the user row.
 *
 * **Matching** is the rule the rest of erasure uses: an address exact on
 * `normaliseAddress()`, compared in code, and only when verified (`address` is
 * null otherwise, and no address is touched); an id exact. Rows are narrowed in
 * SQL by a substring test on their text, as `config-recipients.ts` does, then
 * matched in code. An address that SQL cannot search is narrowed by its domain
 * when that can be searched, and otherwise every row is read — in pages either
 * way, so a large run table is never held in memory at once.
 *
 * **Reading.** Every row is read `FOR NO KEY UPDATE`, so an admin's write to a
 * schedule waits for the erasure rather than landing between its read and its
 * write. **A run still executing** holds its input, definition and trace in
 * memory and writes the trace whole after each step, so its next write could
 * restore what this removed. The engine's writes therefore check, holding the
 * run's row, for anyone erased since the run started
 * ({@link findErasedSinceRunStarted}), and take them out before they commit
 * (t-843). Holding the row orders the two: a write queued behind this lock
 * sees the receipt once erasure commits, and an erasure queued behind a write
 * reads what it wrote. A write that commits while an erasure is open, to a
 * row erasure's pass did not lock, is reached by the pass after the commit
 * ({@link redactSubjectFromRunsSince}).
 *
 * Schedules are configuration: each change is audit-logged, naming the
 * schedule and never the address. Runs are records: they are counted in the
 * erasure's `User erased` log line, as redacted deliveries are.
 *
 * @see lib/privacy/erase-user.ts — calls {@link eraseFromRunInputs}
 * @see lib/privacy/config-recipients.ts — the definitions these runs were made from
 */

import { Prisma, type PrismaClient } from '@prisma/client';
import { normaliseAddress } from '@/lib/orchestration/webhooks/destination';
import { asciiSearchTerm, isJsonObject, type PersonMatch } from '@/lib/privacy/config-recipients';
import { inBoundedTransaction } from '@/lib/privacy/erasure-deadline';
import {
  matchErasedSubjects,
  stringsIn,
  subjectEmailHash,
  WRITER_TRANSACTION_OPTIONS,
  type ErasedSubjects,
} from '@/lib/privacy/erased-subjects';

/** Written on the audit row as the reason for every schedule changed here. */
const ERASURE_REASON = 'A person this schedule named was erased.';

/** What a redacted value in a run's record reads as afterwards. */
export const ERASED_VALUE = '[erased]';

/** Rows read per page. */
export const RUN_PAGE_SIZE = 200;

/** How long one pre-pass page may take: a full-table scan on a large install. */
export const PRE_PASS_PAGE_TIMEOUT_MS = 5 * 60_000;

/**
 * How far behind the database an app host's clock may run before a run it
 * rewrote during the pre-pass could be missed. Generous on purpose: a wider
 * window only re-reads more runs, while a narrower one can leave a person in.
 */
export const RUN_CLOCK_SKEW_MS = 5 * 60_000;

export interface RunRecipientsSubject {
  /** The person being erased. */
  userId: string;
  /** Their normalised address, or null when it was never verified. */
  address: string | null;
  /** Who asked for the erasure: the audit rows are written as them. */
  actorUserId: string;
}

export interface RunRecipientsResult {
  /** Schedules whose input template named the person. */
  schedulesChanged: number;
  /** Other people's runs whose input or trace named the person. */
  executionsRedacted: number;
}

type RunClient = Pick<
  Prisma.TransactionClient,
  '$queryRaw' | 'aiWorkflowSchedule' | 'aiWorkflowExecution' | 'aiAdminAuditLog'
>;

/** What {@link redactPerson} took out of one value. */
export interface Redaction {
  value: Prisma.JsonValue;
  /** How many values were removed or replaced. */
  removed: number;
}

/**
 * `value` without the person, or null when it does not name them. Pure.
 *
 * - An `approverUserIds` list loses their id.
 * - A `notificationChannel` whose `target` is their address loses the target;
 *   the channel and its type stay.
 * - Anywhere else, a string that is their address or their id is taken out of
 *   a list, or replaced by `replacement` where it stands alone.
 *
 * `replacement` is `''` for configuration (the builder's own empty value, so a
 * step fed by it fails as one with no recipient) and {@link ERASED_VALUE} for a
 * record.
 */
export function redactPerson(
  value: Prisma.JsonValue,
  subject: PersonMatch,
  replacement: string
): Redaction | null {
  const { userId, address } = subject;
  let removed = 0;
  const names = (v: Prisma.JsonValue | undefined): boolean =>
    typeof v === 'string' &&
    ((userId !== null && v === userId) || (address !== null && normaliseAddress(v) === address));

  const walk = (v: Prisma.JsonValue): Prisma.JsonValue => {
    if (typeof v === 'string') {
      if (names(v)) {
        removed += 1;
        return replacement;
      }
      // An id inside a longer string — an approval's `actor: 'admin:<id>'` —
      // names them too (review round 2). A cuid is unique, so replacing it
      // where it appears cannot touch anyone else; an address is not
      // searched for inside free text, where a substring is someone else's.
      if (userId !== null && v.includes(userId)) {
        removed += 1;
        return v.split(userId).join(ERASED_VALUE);
      }
      return v;
    }
    if (Array.isArray(v)) {
      const kept = v.filter((entry) => !names(entry));
      removed += v.length - kept.length;
      return kept.map(walk);
    }
    if (!isJsonObject(v)) return v;
    const out: Prisma.JsonObject = {};
    for (const [key, entry] of Object.entries(v)) {
      if (entry === undefined) continue;
      if (key === 'notificationChannel' && isJsonObject(entry) && names(entry.target)) {
        const { target: _erased, ...rest } = entry;
        removed += 1;
        out[key] = walk(rest);
        continue;
      }
      out[key] = walk(entry);
    }
    return out;
  };

  const next = walk(value);
  return removed === 0 ? null : { value: next, removed };
}

/**
 * `value` without anyone in `erased`, by the rule erasure applies to a run
 * ({@link redactPerson} with {@link ERASED_VALUE}): the same value when it
 * names none of them. For a writer holding a copy of a run read before the
 * erasure — the approval pause (t-841).
 */
export function redactErased(value: Prisma.JsonValue, erased: ErasedSubjects): Prisma.JsonValue {
  const subjects: PersonMatch[] = [
    ...erased.addresses.map((address) => ({ userId: null, address })),
    ...erased.userIds.map((userId) => ({ userId, address: null })),
  ];
  let current = value;
  for (const subject of subjects) {
    current = redactPerson(current, subject, ERASED_VALUE)?.value ?? current;
  }
  return current;
}

type RunWriterClient = Pick<Prisma.TransactionClient, '$queryRaw' | 'dataErasureReceipt' | 'user'>;

/**
 * Anyone erased since the run started whom `values` name, or null when nobody
 * was (t-843): for the engine's writes of a run it holds in memory. Call
 * inside the transaction that writes the run, **after** the write has locked
 * its row, so an erasure that held the row first has committed and its
 * receipt is seen.
 *
 * The first query is the whole cost when nobody was erased: receipts by
 * `erasedAt`, which is indexed, since the run's `startedAt` less
 * {@link RUN_CLOCK_SKEW_MS}. Both are stamped by app hosts' clocks, and the
 * margin also covers a definition read just before the run started, and a
 * receipt stamped before its erasure committed. Anything found is then
 * matched as {@link matchErasedSubjects} matches it: an id exact, an address
 * only when erasure matched it verified and no live account holds it now.
 */
export async function findErasedSinceRunStarted(
  tx: RunWriterClient,
  executionId: string,
  values: unknown[]
): Promise<ErasedSubjects | null> {
  const receipts = await tx.$queryRaw<
    Array<{ subjectUserId: string; subjectEmailHash: string | null }>
  >`SELECT r."subjectUserId", r."subjectEmailHash"
     FROM data_erasure_receipt r
     WHERE r."erasedAt" >= (SELECT coalesce(e."startedAt", e."createdAt")
         FROM ai_workflow_execution e WHERE e.id = ${executionId})
       - ${RUN_CLOCK_SKEW_MS} * interval '1 millisecond'`;
  if (receipts.length === 0) return null;

  // An id is matched in the strings, which is where redaction can take it out
  // of: a key naming it is left, as erasure's own pass leaves it (review
  // round 1).
  const strings = stringsIn(values);
  const hashes = new Set(receipts.flatMap((r) => (r.subjectEmailHash ? [r.subjectEmailHash] : [])));
  const addresses = new Set<string>();
  for (const value of strings) {
    if (value.includes('@') && hashes.has(subjectEmailHash(value))) addresses.add(value);
  }
  const erased = await matchErasedSubjects(tx, {
    addresses,
    userIds: receipts
      .map((r) => r.subjectUserId)
      .filter((id) => strings.some((value) => value.includes(id))),
  });
  return erased.addresses.length > 0 || erased.userIds.length > 0 ? erased : null;
}

/**
 * A schedule's input template with `address` blanked, or null when it does
 * not name it: erasure's disposition for a template, shared with a scheduler
 * tick that holds a copy read before the erasure (t-839). Only the address:
 * an input template is free-form, and an id in one is not a recipient erasure
 * has a disposition for.
 */
export function blankAddressInTemplate(
  template: Prisma.JsonValue,
  address: string | null
): Redaction | null {
  return redactPerson(template, { userId: null, address }, '');
}

/** The domain of an address, for narrowing when the whole address cannot be searched. */
function domainOf(address: string): string | null {
  const at = address.lastIndexOf('@');
  return at >= 0 && at < address.length - 1 ? address.slice(at + 1) : null;
}

/**
 * The substring SQL narrows by: the address, else its domain, else nothing
 * (read every row). Each is a superset of the rows whose value normalises to
 * the address, because `translate()` folds exactly the characters
 * `toLowerCase()` folds into ASCII.
 */
function searchTermFor(address: string | null): { term: string | null; scanAll: boolean } {
  if (address === null) return { term: null, scanAll: false };
  const whole = asciiSearchTerm(address);
  if (whole) return { term: whole, scanAll: false };
  const domain = domainOf(address);
  const byDomain = domain ? asciiSearchTerm(domain) : null;
  return byDomain ? { term: byDomain, scanAll: false } : { term: null, scanAll: true };
}

/**
 * Remove the person from every schedule's input template, and redact them
 * from other people's runs, inside the erasure transaction.
 */
export async function eraseFromRunInputs(
  tx: RunClient,
  subject: RunRecipientsSubject,
  /**
   * When {@link preRedactSubjectFromRuns} ran, the database time it started:
   * runs are then read only if written since, or not yet finished. Null (the
   * pre-pass failed, or was not run) reads every run.
   */
  runsChangedSince: Date | null = null
): Promise<RunRecipientsResult> {
  const schedulesChanged = subject.address ? await eraseFromSchedules(tx, subject) : 0;
  const executionsRedacted = await eraseFromExecutions(tx, subject, runsChangedSince);
  return { schedulesChanged, executionsRedacted };
}

async function eraseFromSchedules(tx: RunClient, subject: RunRecipientsSubject): Promise<number> {
  const { term, scanAll } = searchTermFor(subject.address);
  let changed = 0;
  let after = '';
  for (;;) {
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        name: string;
        workflowId: string;
        orgId: string | null;
        inputTemplate: Prisma.JsonValue;
      }>
    >`SELECT s.id, s.name, s."workflowId", s."orgId", s."inputTemplate"
       FROM ai_workflow_schedule s
       CROSS JOIN LATERAL (SELECT translate(s."inputTemplate"::text,
         'ABCDEFGHIJKLMNOPQRSTUVWXYZK', 'abcdefghijklmnopqrstuvwxyzk') AS folded) f
       WHERE s.id > ${after}
         AND (${scanAll} OR (${term}::text IS NOT NULL AND strpos(f.folded, ${term}::text) > 0))
       ORDER BY s.id LIMIT ${RUN_PAGE_SIZE} FOR NO KEY UPDATE OF s`;
    for (const row of rows) {
      const change = blankAddressInTemplate(row.inputTemplate, subject.address);
      if (!change) continue;
      await tx.aiWorkflowSchedule.update({
        where: { id: row.id },
        data: { inputTemplate: change.value ?? {} },
      });
      await tx.aiAdminAuditLog.create({
        data: {
          userId: subject.actorUserId,
          action: 'workflow_schedule.recipient_erased',
          entityType: 'workflow_schedule',
          entityId: row.id,
          entityName: row.name,
          changes: { inputTemplateValuesCleared: { from: change.removed, to: 0 } },
          metadata: { reason: ERASURE_REASON, workflowId: row.workflowId, orgId: row.orgId },
        },
      });
      changed += 1;
    }
    if (rows.length < RUN_PAGE_SIZE) break;
    after = rows[rows.length - 1].id;
  }
  return changed;
}

type RunRow = {
  id: string;
  inputData: Prisma.JsonValue;
  executionTrace: Prisma.JsonValue;
  outputData: Prisma.JsonValue | null;
  errorMessage: string | null;
};

/** Write `row` without the person, inside `tx`; false when it does not name them. */
async function redactRunRow(
  tx: RunClient,
  row: RunRow,
  subject: RunRecipientsSubject
): Promise<boolean> {
  // Every column a run copies them into: its input, its trace, the step
  // outputs the engine writes to `outputData` on completion (an approval's
  // `actor` among them), and an error message (review round 3).
  const input = redactPerson(row.inputData, subject, ERASED_VALUE);
  const trace = redactPerson(row.executionTrace, subject, ERASED_VALUE);
  const output =
    row.outputData === null ? null : redactPerson(row.outputData, subject, ERASED_VALUE);
  const error =
    row.errorMessage === null ? null : redactPerson(row.errorMessage, subject, ERASED_VALUE);
  if (!input && !trace && !output && !error) return false;
  await tx.aiWorkflowExecution.update({
    where: { id: row.id },
    data: {
      ...(input ? { inputData: input.value ?? {} } : {}),
      ...(trace ? { executionTrace: trace.value ?? [] } : {}),
      ...(output ? { outputData: output.value ?? Prisma.DbNull } : {}),
      ...(error && typeof error.value === 'string' ? { errorMessage: error.value } : {}),
    },
  });
  return true;
}

/**
 * One page of other people's runs naming the person, redacted, inside `tx`.
 * `since` narrows to the runs the pre-pass may have missed: those written
 * after it started, and every run not yet finished — an executing run holds
 * its trace in memory and can write it back. Null reads every run.
 */
async function redactExecutionsPage(
  tx: RunClient,
  subject: RunRecipientsSubject,
  after: string,
  since: Date | null
): Promise<{ lastId: string | null; size: number; redacted: number }> {
  const { userId } = subject;
  const { term, scanAll } = searchTermFor(subject.address);
  // The id is a cuid, so already lower-case in the folded text. `updatedAt` is
  // stamped by the app process's clock (Prisma's @updatedAt) while `since` is
  // the database's, so the cut-off is moved back by RUN_CLOCK_SKEW_MS (review
  // round 2): a run rewritten during the pre-pass by a worker whose clock runs
  // behind is still re-read. `updatedAt` is UTC wall time, compared in UTC.
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      inputData: Prisma.JsonValue;
      executionTrace: Prisma.JsonValue;
      outputData: Prisma.JsonValue | null;
      errorMessage: string | null;
    }>
  >`SELECT e.id, e."inputData", e."executionTrace", e."outputData", e."errorMessage"
     FROM ai_workflow_execution e
     CROSS JOIN LATERAL (SELECT translate(e."inputData"::text || e."executionTrace"::text
         || coalesce(e."outputData"::text, '') || coalesce(e."errorMessage", ''),
         'ABCDEFGHIJKLMNOPQRSTUVWXYZK', 'abcdefghijklmnopqrstuvwxyzk') AS folded) f
     WHERE e.id > ${after}
       AND e."userId" IS DISTINCT FROM ${userId}
       AND (${since}::timestamptz IS NULL
         OR e."updatedAt" >= ((${since}::timestamptz - ${RUN_CLOCK_SKEW_MS} * interval '1 millisecond') AT TIME ZONE 'UTC')
         OR e.status IN ('pending', 'running', 'paused_for_approval'))
       AND (${scanAll}
         OR strpos(f.folded, ${userId}) > 0
         OR (${term}::text IS NOT NULL AND strpos(f.folded, ${term}::text) > 0))
     ORDER BY e.id LIMIT ${RUN_PAGE_SIZE} FOR NO KEY UPDATE OF e`;
  let redacted = 0;
  for (const row of rows) {
    if (await redactRunRow(tx, row, subject)) redacted += 1;
  }
  return { lastId: rows.length ? rows[rows.length - 1].id : null, size: rows.length, redacted };
}

async function eraseFromExecutions(
  tx: RunClient,
  subject: RunRecipientsSubject,
  since: Date | null
): Promise<number> {
  let redacted = 0;
  let after = '';
  for (;;) {
    const page = await redactExecutionsPage(tx, subject, after, since);
    redacted += page.redacted;
    if (page.size < RUN_PAGE_SIZE || page.lastId === null) break;
    after = page.lastId;
  }
  return redacted;
}

/**
 * How the pass after the commit waits for one run: behind an engine write
 * (`RUN_WRITE_TRANSACTION_OPTIONS` in the engine) or another writer, and for a
 * connection as a plain query does.
 */
const RUN_ROW_TRANSACTION_OPTIONS = { ...WRITER_TRANSACTION_OPTIONS, maxWait: 10_000 } as const;

/** A client the pre-pass can open its own short transactions on. */
type PrePassClient = Pick<PrismaClient, '$queryRaw' | '$transaction'>;

/**
 * The run redaction, ahead of the erasure transaction, one committed page at a
 * time — as `preRedactSubjectFromDeliveries` does for deliveries (t-806), and
 * for the same reason: a large run table, folded and searched inside the
 * transaction's 60 s, would time it out, and an erasure that times out erases
 * nothing. Returns the database time it started at, which the transaction's
 * own pass then narrows to ({@link eraseFromRunInputs}'s `runsChangedSince`).
 *
 * Call it only once nothing will refuse the erasure. If the transaction then
 * fails, these runs stay redacted while the account still exists — accepted,
 * as for deliveries: it is what the erasure was asked to do, and a retry
 * completes it. `onCommitted` hears each page's count as it commits.
 *
 * With a `deadline` (t-845), each page is capped at the time left and none is
 * started once it has passed: `ErasureDeferredError` is thrown, and the
 * pages already committed stay redacted.
 */
export async function preRedactSubjectFromRuns(
  client: PrePassClient,
  subject: Pick<RunRecipientsSubject, 'userId' | 'address'>,
  onCommitted: (redacted: number) => void,
  deadline?: Date
): Promise<Date> {
  const [{ now }] = await client.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`;
  const full: RunRecipientsSubject = { ...subject, actorUserId: '' };
  let after = '';
  for (;;) {
    // A page may scan the whole table to fill itself when the person is named
    // in few runs, so it is not held to Prisma's 5 s default (review round 3);
    // each page commits on its own, outside the erasure's 60 s.
    const runPage = (tx: Prisma.TransactionClient) => redactExecutionsPage(tx, full, after, null);
    const page = deadline
      ? await inBoundedTransaction(
          client,
          deadline,
          'a run pre-pass page',
          runPage,
          PRE_PASS_PAGE_TIMEOUT_MS
        )
      : await client.$transaction(runPage, { timeout: PRE_PASS_PAGE_TIMEOUT_MS });
    onCommitted(page.redacted);
    if (page.size < RUN_PAGE_SIZE || page.lastId === null) break;
    after = page.lastId;
  }
  return now;
}

/**
 * The run redaction once more, after the erasure has committed (t-843), over
 * every other person's run not yet finished or written since `since`. A
 * running workflow's write that committed while the erasure was open, to a
 * row the erasure's pass had not locked, names the person from what the run
 * held in memory; nothing else reaches it, since the engine found no receipt
 * then. Writes after the commit find the receipt themselves
 * ({@link findErasedSinceRunStarted}).
 *
 * Each run is locked and read in a transaction of its own, rather than
 * narrowed by its text as the other passes are (review rounds 1 and 2):
 * Postgres tests a row's text against its committed version before it waits
 * for the row's lock, so a write still open would be passed over, and a page
 * holding every run it locked until it filled would keep the engine's writes
 * waiting meanwhile. Paused runs not written since are left: no engine write
 * of them is open, and the transaction's pass reached them.
 * Returns how many runs it redacted, and how many it could not (with the last
 * error), so the caller can say so.
 */
export async function redactSubjectFromRunsSince(
  client: PrePassClient,
  subject: Pick<RunRecipientsSubject, 'userId' | 'address'>,
  since: Date
): Promise<{ redacted: number; failed: number; lastError: string | null }> {
  const full: RunRecipientsSubject = { ...subject, actorUserId: '' };
  let redacted = 0;
  let failed = 0;
  let lastError: string | null = null;
  let after = '';
  for (;;) {
    // `updatedAt` is the app host's clock and `since` too, but the cut-off
    // is moved back as `redactExecutionsPage`'s is, for hosts that disagree.
    const ids = await client.$queryRaw<Array<{ id: string }>>`SELECT e.id
       FROM ai_workflow_execution e
       WHERE e.id > ${after}
         AND e."userId" IS DISTINCT FROM ${subject.userId}
         AND (e.status IN ('pending', 'running')
           OR e."updatedAt" >= ((${since}::timestamptz - ${RUN_CLOCK_SKEW_MS} * interval '1 millisecond') AT TIME ZONE 'UTC'))
       ORDER BY e.id LIMIT ${RUN_PAGE_SIZE}`;
    for (const { id } of ids) {
      // One run that cannot be locked or written does not end the pass for the
      // rest (review round 3); the caller hears how many there were.
      try {
        const changed = await client.$transaction(async (tx) => {
          const [row] = await tx.$queryRaw<RunRow[]>`SELECT e.id, e."inputData", e."executionTrace",
               e."outputData", e."errorMessage"
             FROM ai_workflow_execution e WHERE e.id = ${id} FOR NO KEY UPDATE`;
          return row ? redactRunRow(tx, row, full) : false;
        }, RUN_ROW_TRANSACTION_OPTIONS);
        if (changed) redacted += 1;
      } catch (error) {
        failed += 1;
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    if (ids.length < RUN_PAGE_SIZE) break;
    after = ids[ids.length - 1].id;
  }
  return { redacted, failed, lastError };
}
