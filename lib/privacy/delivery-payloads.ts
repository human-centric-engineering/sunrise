/**
 * The webhook and event-hook deliveries whose payload names a person, for
 * erasure (Art. 17) and subject access (Art. 15) (t-783).
 *
 * A delivery row stores the event it sent. Several events name the person
 * whose activity caused them — a chat turn's `userId`, a workflow run's
 * `actorUserId` and the actor's display name, an escalation's `reason` and
 * `metadata`, an approval's `prompt` — or the admin who acted
 * (`agent_updated`, `capability.quarantined`). None of that is reached by the
 * erasure cascade: a delivery has no user column, and since §109 t-739 it
 * outlives the subscription or hook that sent it, as the org's record that
 * the event was sent.
 *
 * **Which rows.** A delivery names the subject when its payload's `data`
 * carries:
 *
 *   • `conversationId` of one of the subject's conversations, `executionId`
 *     of one of their workflow runs, or `userId` = the subject — the event is
 *     about the subject's own activity (basis `activity`);
 *   • `actorUserId` = the subject on one of {@link ADMIN_ACTION_EVENTS}, or the
 *     subject in `approverUserIds` — the subject acted on the org's
 *     configuration, or was asked to (basis `actor`). On any other event
 *     `actorUserId` names the person whose run or conversation it was
 *     (`workflow_failed`, `budget_exceeded`), so it is `activity` — which
 *     matters once that run or conversation has been pruned and no longer
 *     says so itself.
 *
 * Matched by JSON containment on the payload (`@>`), which the GIN index on
 * each table's `payload` serves, so neither the erasure transaction nor the
 * export scans the table. The conversation and run ids are read in the same
 * statement: they cascade away with the person, so erasure must ask before
 * the user row goes.
 *
 * **What erasure does: redact, not delete.** The row stays, as the org's
 * record that an event was sent and where (t-739's ruling that deliveries
 * survive their creator). Of an `activity` row's `data` only the keys in
 * {@link EVENT_RECORD_KEYS} survive — which agent or workflow, which event,
 * the cost — and every free-text or unknown field goes, a fork's own fields
 * included. An `actor` row keeps its data, which describes the org's change,
 * and loses only who made it, as the admin audit log does (`SetNull`). In both,
 * the subject's id becomes `null`, their display name goes, and they leave
 * `approverUserIds`. An `activity` row still waiting to retry stops, and every
 * `activity` row is marked so no retry or replay sends it again (t-793): the
 * event it would send is now about nobody.
 *
 * **What subject access returns.** The same rows, each with the parts of its
 * `data` that are the subject's to see: an `activity` row's record keys and
 * what it said about them ({@link SUBJECT_TEXT_KEYS}); an `actor` row as the
 * fact of the action ({@link EVENT_RECORD_KEYS}); and in both the subject's
 * own id. An allowlist here too: an event about the subject's run can also
 * carry the org's own configuration — a notification step's `webhookUrl`,
 * which often holds its credential, approval links, the rendered `body` an
 * admin's template produced — and none of that is the subject's.
 *
 * An anonymous embed visitor is not a `User` (#705, t-765): their events carry
 * `embedVisitorId` and go with the org's export, erasure and retention, as
 * their conversations do.
 *
 * @see lib/privacy/erase-user.ts — calls {@link eraseSubjectFromDeliveries}
 * @see lib/privacy/export-sources.ts — calls {@link deliveriesNamingSubject}
 */

import { Prisma } from '@prisma/client';
import {
  AWAITING_RETRY_STATUSES,
  SUBJECT_ERASED,
  notRetried,
  notRetriedSuffix,
} from '@/lib/orchestration/webhooks/not-retried';

/** Which delivery table: webhook subscriptions', or event hooks'. */
export type DeliveryTable = 'webhook' | 'hook';

/** Why a delivery names the subject; see the module comment. */
export type DeliveryBasis = 'activity' | 'actor';

/** A delivery whose payload names the subject, as read for erasure or export. */
export interface SubjectDelivery {
  id: string;
  eventType: string;
  status: string;
  lastError: string | null;
  lastAttemptAt: Date | null;
  createdAt: Date;
  payload: Prisma.JsonValue;
  basis: DeliveryBasis;
}

/** The raw-SQL half of a Prisma client or transaction client. */
export type RawClient = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;

const TABLES: Record<DeliveryTable, Prisma.Sql> = {
  webhook: Prisma.raw('ai_webhook_delivery'),
  hook: Prisma.raw('ai_event_hook_delivery'),
};

/**
 * The `data` keys that record WHICH event happened rather than what anyone
 * said: org config ids and names, the run or conversation it concerned, costs
 * and counts. An `activity` row keeps only these through an erasure; an
 * `actor` row's export carries only these. Everything else — `reason`,
 * `metadata`, `prompt`, `error`, `body`, `changes`, approval links, and any
 * key a fork's event adds — is treated as possibly the subject's.
 *
 * An allowlist on purpose: a new event field is then erased by default, and
 * only a deliberate entry here keeps it.
 */
export const EVENT_RECORD_KEYS: ReadonlySet<string> = new Set([
  'agentId',
  'agentSlug',
  'agentName',
  'workflowId',
  'workflowSlug',
  'workflowName',
  'executionId',
  'conversationId',
  'messageId',
  'stepId',
  'failedStepId',
  'capabilityId',
  'capabilitySlug',
  'capabilityName',
  'role',
  'toolName',
  'priority',
  'mode',
  'previousMode',
  'previousStatus',
  'source',
  'notificationChannel',
  'timeoutMinutes',
  'usedUsd',
  'limitUsd',
  'iteration',
  'tokensUsed',
  'costUsd',
  'totalCostUsd',
  'totalTokensUsed',
  'agentVersion',
  'at',
]);

/**
 * The free-text keys of an `activity` row that say something about the
 * subject's own conversation or run, which subject access hands them on top of
 * {@link EVENT_RECORD_KEYS}: an escalation's `reason` and `metadata`, an
 * approval's `prompt`, a failure's message. Erasure drops them.
 */
export const SUBJECT_TEXT_KEYS: ReadonlySet<string> = new Set([
  'reason',
  'metadata',
  'prompt',
  'error',
  'errorMessage',
]);

/**
 * The events whose `actorUserId` is an admin changing the org's configuration
 * or acting on someone else's run, rather than the owner of the activity the
 * event reports. An event not listed here — a fork's included — is read as
 * the actor's own activity, the reading that erases more.
 */
export const ADMIN_ACTION_EVENTS: readonly string[] = [
  'agent_updated',
  'agent.updated',
  'capability.quarantined',
  'capability.unquarantined',
  'execution.force_failed',
];

/** Keys that hold a person's id, each with the display-name key that goes with it. */
const PERSON_KEYS: ReadonlyArray<{ id: string; name: string | null }> = [
  { id: 'userId', name: null },
  { id: 'actorUserId', name: 'actorUserName' },
];

const APPROVERS_KEY = 'approverUserIds';

/** The columns a match reads: never a row's destination or its history. */
const COLUMNS = Prisma.sql`d.id, d."eventType", d.status, d."lastError", d."lastAttemptAt", d."createdAt", d.payload`;

/** `{ data: { [key]: value } }` as a jsonb parameter, for an `@>` match. */
function dataContains(key: string, value: unknown): Prisma.Sql {
  return Prisma.sql`${JSON.stringify({ data: { [key]: value } })}::jsonb`;
}

/**
 * Every delivery in `table` whose payload names `userId`, with the basis it
 * names them on. Call before the user row is deleted: the conversation and run
 * ids it matches on cascade away with it.
 */
export async function deliveriesNamingSubject(
  client: RawClient,
  table: DeliveryTable,
  userId: string
): Promise<SubjectDelivery[]> {
  const t = TABLES[table];
  // Each arm is one containment the GIN index answers; the two joins drive
  // the index once per conversation or run. Every arm returns the columns
  // this needs, so nothing joins back to the table, and `DISTINCT ON` keeps
  // one copy of a row matched twice — the `activity` one, the stronger basis.
  // Ordered as {@link byCreatedAtThenId} orders: `COLLATE "C"` is code-unit
  // order, whatever the database's collation.
  const rows = await client.$queryRaw<
    Array<Omit<SubjectDelivery, 'basis'> & { activity: boolean }>
  >`
    WITH matched AS (
      SELECT ${COLUMNS}, true AS activity
        FROM ai_conversation c
        JOIN ${t} d
          ON d.payload @> jsonb_build_object('data', jsonb_build_object('conversationId', c.id))
       WHERE c."userId" = ${userId}
      UNION ALL
      SELECT ${COLUMNS}, true
        FROM ai_workflow_execution e
        JOIN ${t} d
          ON d.payload @> jsonb_build_object('data', jsonb_build_object('executionId', e.id))
       WHERE e."userId" = ${userId}
      UNION ALL
      SELECT ${COLUMNS}, true FROM ${t} d WHERE d.payload @> ${dataContains('userId', userId)}
      UNION ALL
      SELECT ${COLUMNS}, NOT (d."eventType" = ANY(${[...ADMIN_ACTION_EVENTS]}::text[]))
        FROM ${t} d WHERE d.payload @> ${dataContains('actorUserId', userId)}
      UNION ALL
      SELECT ${COLUMNS}, false FROM ${t} d WHERE d.payload @> ${dataContains(APPROVERS_KEY, [userId])}
    )
    SELECT * FROM (
      SELECT DISTINCT ON (id) *
        FROM matched
       ORDER BY id, activity DESC
    ) one_each
    ORDER BY "createdAt", id COLLATE "C"
  `;
  return rows.map(({ activity, ...row }) => ({
    ...row,
    basis: activity ? 'activity' : 'actor',
  }));
}

/**
 * Oldest first; ids are unique, so a tie on time always resolves, in
 * code-unit order rather than locale order so it sorts the same everywhere.
 * The order both delivery export sections present their rows in.
 */
export function byCreatedAtThenId(
  a: { createdAt: Date; id: string },
  b: { createdAt: Date; id: string }
): number {
  return a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1);
}

/**
 * Whether an event's text was written by an admin acting on the run, though
 * the event is not one of {@link ADMIN_ACTION_EVENTS}: a force-fail also emits
 * `workflow.failed`, marked `source: 'admin-force-fail'`, whose `errorMessage`
 * carries the admin's reason.
 */
function isAdminAuthored(payload: Prisma.JsonValue): boolean {
  return dataOf(payload)?.source === 'admin-force-fail';
}

/** The payload's `data` object, or `null` when the payload has none. */
function dataOf(payload: Prisma.JsonValue): Prisma.JsonObject | null {
  return objectOf(objectOf(payload)?.data);
}

/** `value` when it is a JSON object (not null, not an array), else `null`. */
function objectOf(value: Prisma.JsonValue | undefined): Prisma.JsonObject | null {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

/** `data` with the subject's id nulled, their name dropped, and them out of the approvers. */
function withoutSubject(data: Prisma.JsonObject, userId: string): Prisma.JsonObject {
  const next = { ...data };
  for (const { id, name } of PERSON_KEYS) {
    if (next[id] !== userId) continue;
    next[id] = null;
    if (name) delete next[name];
  }
  const approvers = next[APPROVERS_KEY];
  if (Array.isArray(approvers)) {
    next[APPROVERS_KEY] = approvers.filter((approver) => approver !== userId);
  }
  return next;
}

/** Only the keys of `data` that `keep` admits. */
function pick(data: Prisma.JsonObject, keep: (key: string) => boolean): Prisma.JsonObject {
  return Object.fromEntries(Object.entries(data).filter(([key]) => keep(key)));
}

/**
 * The payload a delivery keeps after the subject's erasure: see the module
 * comment. Everything outside `data` (the event name, the timestamp) is kept.
 * A payload with no `data` object is returned unchanged — nothing in it was
 * matched.
 */
export function erasedPayload(
  payload: Prisma.JsonValue,
  basis: DeliveryBasis,
  userId: string
): Prisma.JsonValue {
  const envelope = objectOf(payload);
  const data = objectOf(envelope?.data);
  if (!envelope || !data) return payload;
  const kept =
    basis === 'activity'
      ? pick(data, (key) => EVENT_RECORD_KEYS.has(key) || isPersonKey(key))
      : data;
  return { ...envelope, data: withoutSubject(kept, userId) };
}

function isPersonKey(key: string): boolean {
  return key === APPROVERS_KEY || PERSON_KEYS.some(({ id, name }) => key === id || key === name);
}

/**
 * The part of a delivery's `data` a subject-access export hands the subject:
 * see the module comment. Other people's ids and names are never in it — an
 * approver list names colleagues, and an admin who force-failed the subject's
 * run is not the subject's data.
 */
export function subjectViewOfPayload(
  payload: Prisma.JsonValue,
  basis: DeliveryBasis,
  userId: string,
  eventType: string
): Prisma.JsonObject {
  // On an admin's action the free text is the admin's — a force-fail's
  // `reason` is their note — even when the run it acted on is the subject's.
  const ownText =
    basis === 'activity' && !ADMIN_ACTION_EVENTS.includes(eventType) && !isAdminAuthored(payload);
  const data = dataOf(payload) ?? {};
  const isSubject = (key: string): boolean => {
    const person = PERSON_KEYS.find(({ id, name }) => key === id || key === name);
    if (!person) return false;
    return data[person.id] === userId;
  };
  const view = pick(data, (key) => {
    if (key === APPROVERS_KEY) return false;
    if (isPersonKey(key)) return isSubject(key);
    return EVENT_RECORD_KEYS.has(key) || (ownText && SUBJECT_TEXT_KEYS.has(key));
  });
  // Named as an approver: say so, without naming the colleagues beside them.
  const approvers = data[APPROVERS_KEY];
  if (Array.isArray(approvers) && approvers.includes(userId)) view[APPROVERS_KEY] = [userId];
  return view;
}

/** Rows written per statement, so one person's history never becomes one huge parameter. */
const WRITE_CHUNK = 500;

/**
 * The `lastError` a stopped row gets: `notRetried`'s wording
 * (`lib/orchestration/webhooks/not-retried.ts`), in SQL, so it is built from
 * the row as the `UPDATE` finds it rather than as it was read. Built from the
 * same functions, so `isStoppedByErasure` recognises it and a manual retry
 * refuses the row (t-793).
 */
const STOPPED_LAST_ERROR = Prisma.sql`CASE WHEN d."lastError" IS NULL OR d."lastError" = ''
  THEN ${notRetried(null, SUBJECT_ERASED)}
  ELSE d."lastError" || ${notRetriedSuffix(SUBJECT_ERASED)} END`;

/**
 * Redact the subject from every delivery in `table` that names them, stop
 * the `activity` rows still waiting to retry, and mark every `activity` row
 * so a retry refuses it (`isStoppedByErasure`). One statement per
 * {@link WRITE_CHUNK} rows, so the transaction's cost tracks the rows
 * rather than a round trip each. Returns the number of rows rewritten.
 *
 * Whether a row stops is decided by the `UPDATE`, against its status at that
 * moment, not as the read found it: the retry worker can deliver a row in
 * between, and a delivered row must not be rewritten as exhausted.
 */
export async function eraseSubjectFromDeliveries(
  client: RawClient,
  table: DeliveryTable,
  userId: string
): Promise<number> {
  const rows = await deliveriesNamingSubject(client, table, userId);
  const writes = rows.map((row) => ({
    id: row.id,
    payload: erasedPayload(row.payload, row.basis, userId),
    activity: row.basis === 'activity',
  }));
  const t = TABLES[table];
  const stopNow = Prisma.sql`(w.activity AND d.status = ANY(${[...AWAITING_RETRY_STATUSES]}::text[]))`;
  // Every `activity` row gets the mark, whatever its status, so a replay or a
  // manual retry refuses it rather than send an event about nobody (t-793). An
  // `exhausted` row is the DLQ's population; a `delivered` one can still be
  // retried by hand. Only the rows still waiting to send also change status.
  // A row already marked, by an earlier erasure of someone else it named, is
  // not marked twice.
  const markNow = Prisma.sql`(w.activity
    AND d."lastError" IS DISTINCT FROM ${notRetried(null, SUBJECT_ERASED)}
    AND right(coalesce(d."lastError", ''), ${notRetriedSuffix(SUBJECT_ERASED).length}) <> ${notRetriedSuffix(SUBJECT_ERASED)})`;
  for (let i = 0; i < writes.length; i += WRITE_CHUNK) {
    const chunk = writes.slice(i, i + WRITE_CHUNK);
    await client.$executeRaw`
      UPDATE ${t} AS d
         SET payload = w.payload,
             status = CASE WHEN ${stopNow} THEN 'exhausted' ELSE d.status END,
             "nextRetryAt" = CASE WHEN ${stopNow} THEN NULL ELSE d."nextRetryAt" END,
             "lastError" = CASE WHEN ${markNow} THEN ${STOPPED_LAST_ERROR} ELSE d."lastError" END
        FROM jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb)
             AS w(id text, payload jsonb, activity boolean)
       WHERE d.id = w.id
    `;
  }
  return writes.length;
}
