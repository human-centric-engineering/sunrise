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
 * The `UNION ALL` of every way a delivery in `table` names `userId`, each arm
 * returning `columns` and an `activity` flag (see the module comment). Each
 * arm is one containment the GIN index answers; the two joins drive the index
 * once per conversation or run. Every arm returns what its caller needs, so
 * nothing joins back to the table. A row can come back from more than one arm.
 */
function matchArms(table: DeliveryTable, userId: string, columns: Prisma.Sql): Prisma.Sql {
  const t = TABLES[table];
  return Prisma.sql`
      SELECT ${columns}, true AS activity
        FROM ai_conversation c
        JOIN ${t} d
          ON d.payload @> jsonb_build_object('data', jsonb_build_object('conversationId', c.id))
       WHERE c."userId" = ${userId}
      UNION ALL
      SELECT ${columns}, true
        FROM ai_workflow_execution e
        JOIN ${t} d
          ON d.payload @> jsonb_build_object('data', jsonb_build_object('executionId', e.id))
       WHERE e."userId" = ${userId}
      UNION ALL
      SELECT ${columns}, true FROM ${t} d WHERE d.payload @> ${dataContains('userId', userId)}
      UNION ALL
      SELECT ${columns}, NOT (d."eventType" = ANY(${[...ADMIN_ACTION_EVENTS]}::text[]))
        FROM ${t} d WHERE d.payload @> ${dataContains('actorUserId', userId)}
      UNION ALL
      SELECT ${columns}, false FROM ${t} d WHERE d.payload @> ${dataContains(APPROVERS_KEY, [userId])}`;
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
  // `DISTINCT ON` keeps one copy of a row matched twice — the `activity` one,
  // the stronger basis. Ordered as {@link byCreatedAtThenId} orders:
  // `COLLATE "C"` is code-unit order, whatever the database's collation.
  const rows = await client.$queryRaw<
    Array<Omit<SubjectDelivery, 'basis'> & { activity: boolean }>
  >`
    WITH matched AS (${matchArms(table, userId, COLUMNS)})
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

/**
 * The `lastError` a row gets when the erasure stops it: `notRetried`'s
 * wording (`lib/orchestration/webhooks/not-retried.ts`), in SQL, so it is
 * built from the row as the `UPDATE` finds it rather than as it was read.
 * For people to read; what a retry refuses on is `stoppedByErasure` (t-809).
 */
const STOPPED_LAST_ERROR = Prisma.sql`CASE WHEN d."lastError" IS NULL OR d."lastError" = ''
  THEN ${notRetried(null, SUBJECT_ERASED)}
  ELSE d."lastError" || ${notRetriedSuffix(SUBJECT_ERASED)} END`;

/** The keys an `activity` row keeps: {@link erasedPayload}'s `pick`. */
const ACTIVITY_KEEP_KEYS: readonly string[] = [
  ...EVENT_RECORD_KEYS,
  APPROVERS_KEY,
  ...PERSON_KEYS.flatMap(({ id, name }) => (name ? [id, name] : [id])),
];

/**
 * {@link erasedPayload}, in SQL, for the `one_each` row `o` (t-806). Each
 * `LATERAL` step is one line of the TypeScript, in the same order:
 *
 *   1. `kept`: an `activity` row keeps only {@link ACTIVITY_KEEP_KEYS} of its
 *      `data`; an `actor` row keeps all of it;
 *   2. each {@link PERSON_KEYS} id equal to the subject becomes `null`, and
 *      its display name goes;
 *   3. the subject leaves `approverUserIds`, when that is an array, the rest
 *      in their order.
 *
 * A payload whose `data` is not an object is left as it is. `erasedPayload()`
 * stays the specification: `smoke:erasure-deliveries` checks this against it
 * over every event shape it writes.
 */
function redactedPayloadSql(userId: string): Prisma.Sql {
  const subject = Prisma.sql`to_jsonb(${userId}::text)`;
  const personSteps = PERSON_KEYS.map(
    ({ id, name }, i) => Prisma.sql`
      CROSS JOIN LATERAL (
        SELECT CASE WHEN ${Prisma.raw(`p${i}`)}.v -> ${id} = ${subject}
                    THEN jsonb_set(${Prisma.raw(`p${i}`)}.v, ${`{${id}}`}::text[], 'null'::jsonb)
                         ${name ? Prisma.sql`- ${name}::text` : Prisma.empty}
                    ELSE ${Prisma.raw(`p${i}`)}.v END
      ) ${Prisma.raw(`p${i + 1}`)}(v)`
  );
  const last = Prisma.raw(`p${PERSON_KEYS.length}`);
  return Prisma.sql`
    SELECT o.id, o.activity,
           CASE WHEN jsonb_typeof(o.payload -> 'data') = 'object'
                THEN jsonb_set(o.payload, '{data}', approvers.v)
                ELSE o.payload END AS payload
      FROM one_each o
      CROSS JOIN LATERAL (
        SELECT CASE WHEN jsonb_typeof(o.payload -> 'data') <> 'object' THEN '{}'::jsonb
                    WHEN o.activity
                    THEN (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
                            FROM jsonb_each(o.payload -> 'data') AS e
                           WHERE e.key = ANY(${ACTIVITY_KEEP_KEYS}::text[]))
                    ELSE o.payload -> 'data' END
      ) p0(v)
      ${Prisma.join(personSteps, '')}
      CROSS JOIN LATERAL (
        SELECT CASE WHEN jsonb_typeof(${last}.v -> ${APPROVERS_KEY}) = 'array'
                    THEN jsonb_set(${last}.v, ${`{${APPROVERS_KEY}}`}::text[], (
                      SELECT coalesce(jsonb_agg(a.e ORDER BY a.i), '[]'::jsonb)
                        FROM jsonb_array_elements(${last}.v -> ${APPROVERS_KEY})
                             WITH ORDINALITY AS a(e, i)
                       WHERE a.e <> ${subject}))
                    ELSE ${last}.v END
      ) approvers(v)`;
}

/**
 * Redact the subject from every delivery in `table` that names them, stop
 * the `activity` rows still waiting to retry, and mark every `activity` row
 * `stoppedByErasure` so a retry or a replay refuses it (t-793, t-809).
 * Returns the number of rows rewritten.
 *
 * One statement, with no payload passing through Node (t-806): match, redact
 * ({@link redactedPayloadSql}) and write all happen in Postgres, so a heavy
 * history costs the erasure transaction an index scan and a rewrite rather
 * than a round trip per row.
 *
 * Whether a row stops is decided against its status as the `UPDATE` finds
 * it, not as the match read it: the retry worker can deliver a row in
 * between, and a delivered row must not be rewritten as exhausted.
 */
export async function eraseSubjectFromDeliveries(
  client: RawClient,
  table: DeliveryTable,
  userId: string
): Promise<number> {
  const t = TABLES[table];
  const stopNow = Prisma.sql`(r.activity AND d.status = ANY(${[...AWAITING_RETRY_STATUSES]}::text[]))`;
  // Every `activity` row is marked, whatever its status, so a replay or a
  // manual retry refuses it rather than send an event about nobody (t-793). An
  // `exhausted` row is the DLQ's population; a `delivered` one can still be
  // retried by hand. Only the rows still waiting to send also change status.
  // A row already marked, by an earlier erasure of someone else it named,
  // keeps its `lastError` as it is.
  const markNow = Prisma.sql`(r.activity AND NOT d."stoppedByErasure")`;
  return client.$executeRaw`
    WITH matched AS (${matchArms(table, userId, Prisma.sql`d.id, d.payload`)}),
    one_each AS (
      SELECT DISTINCT ON (id) id, payload, activity
        FROM matched
       ORDER BY id, activity DESC
    ),
    redacted AS (${redactedPayloadSql(userId)})
    UPDATE ${t} AS d
       SET payload = r.payload,
           status = CASE WHEN ${stopNow} THEN 'exhausted' ELSE d.status END,
           "nextRetryAt" = CASE WHEN ${stopNow} THEN NULL ELSE d."nextRetryAt" END,
           "lastError" = CASE WHEN ${markNow} THEN ${STOPPED_LAST_ERROR} ELSE d."lastError" END,
           "stoppedByErasure" = d."stoppedByErasure" OR r.activity
      FROM redacted r
     WHERE d.id = r.id
  `;
}
