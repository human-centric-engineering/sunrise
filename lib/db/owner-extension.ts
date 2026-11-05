/**
 * Owner chokepoint — a narrowed caller reads only rows it may read (§115 t-801).
 *
 * The tenancy layer (`lib/db/tenancy-extension.ts`) draws the wall between
 * orgs. Inside one org the only thing that kept a member's personal rows
 * from another member was each route remembering to narrow its query, one
 * route at a time. This layer checks the resolved query instead, below every
 * route and every library function. `lib/db/client.ts` applies it over the
 * tenancy layer.
 *
 * **Who is checked.** The caller the guard entered as the subject
 * (`lib/auth/subject-context.ts`) when the policy narrowed them to one user:
 * `filter.userId` is set. A platform admin, an `admin` API key, a job, a
 * guard-less route and a read inside `runAcrossOwners(reason, fn)` are not
 * narrowed, and for them this layer sends exactly the query it was handed.
 *
 * **What is checked**, on the models `lib/db/owner-classification.ts` marks
 * `enforced` (rulings 1–3 on the feature, journal 2026-10-14):
 *
 *   • `findMany` / `count` / `aggregate` / `groupBy` must carry a filter that
 *     *confines* the read: every row it can match is one the caller may read.
 *     The `where` is analysed as a tree — any `AND` conjunct that confines
 *     confines the whole; an `OR` confines when every arm does; `NOT` never
 *     does. A leaf confines when it names the owner as the subject — by the
 *     owner column, or by the relation its foreign key is (`user: { id: me }`)
 *     — or names no owner and the caller may read ownerless rows of that kind
 *     (`session.unattributedReads`). So `{ OR: [{ userId: me }, { userId: null }] }`
 *     passes for a caller admitted to ownerless rows, and `{ agentId }` alone
 *     does not. A model's `alsoVisible` arm confines too, for a caller that
 *     reads shares (`OwnerReader.readsShared`, a `withAdminAuth` request): a
 *     conversation's `share` filtered to live shares (`revokedAt: null`, no
 *     expiry or one in the future). A child owned `through` a parent (a message, through its
 *     conversation) confines when its filter on that relation would confine
 *     the parent.
 *   • `findUnique` (and `findUniqueOrThrow`) runs whatever its filter, and the
 *     row that comes back is checked: someone else's, or an ownerless one the
 *     caller may not read, is refused. A route that fetches by id and checks
 *     the owner afterwards keeps working, and gains a backstop for the day it
 *     forgets. Where the row's own owner column cannot decide — a `through`
 *     owner, or a model with an `alsoVisible` arm — the read runs narrowed to
 *     {@link readablePredicate} instead, and only a miss asks (on the tenancy
 *     layer, by the same unique key) whether a row matched that this caller
 *     may not read, to refuse it rather than report it absent.
 *   • `findFirst` (and `findFirstOrThrow`) with a filter that does not confine
 *     it has {@link readablePredicate} added to that filter. Checking its row
 *     afterwards would refuse or pass depending on which matching row the
 *     database returned first; narrowed, it returns the caller's first match,
 *     or none.
 *   • A write that returns the row it writes — `update`, `upsert`, `delete`,
 *     `updateManyAndReturn` — must carry a filter that confines it, or it is
 *     refused before it runs. It would otherwise read another member's row
 *     back to the caller; checking that row afterwards is too late, as the
 *     write has happened.
 *   • An `include` / `select` reaching an enforced model from any root (a
 *     `user.findUnique({ include: { aiUserMemories: true } })`) must confine
 *     that relation with its own `where`, or it is refused. A `_count` of
 *     one is held to the same rule. The exception is the ownership relation
 *     itself, followed out of a node that is checked — a conversation's
 *     `messages`, a message's `conversation`: the far side is readable exactly
 *     when the near side is, so it inherits the check.
 *   • A to-one relation cannot carry a `where`. When it reaches an enforced
 *     model whose own owner column decides a row (a run's `dataset`, an
 *     experiment variant's `evaluationRun`), the row it returns is checked as
 *     a single-row read is: the owner column is selected with it, and a row
 *     this caller may not read refuses the whole read (§115 t-803). A write's
 *     read-back is checked after the write: inside a transaction the refusal
 *     rolls the write back; outside one the write stands and the caller is
 *     answered 404, so a returning write that includes such a relation belongs
 *     in a transaction. A route that must survive the related row changing
 *     hands reads it on its own instead (a run's dataset, t-803).
 *     A to-one reaching a `through` owner or an `alsoVisible` model has no
 *     column to decide by, and is refused.
 *
 * A refusal throws {@link OwnerReadRefusedError} in every environment. There
 * is no log-only mode: that records a leak rather than stopping it.
 * `handleAPIError` answers it as a 404, so a refusal does not confirm the row
 * exists. Code that must read across owners for a narrowed caller says so
 * with `runAcrossOwners(reason, fn)`, which is logged.
 *
 * **What is not checked**, and why:
 *   • **Whether a write is allowed.** Whether a member may change another
 *     member's row is a write decision the routes make (`canAdminister`); this
 *     layer refuses only the read a returning write would carry back. A
 *     `create`, or a write that returns a count (`updateMany`, `deleteMany`),
 *     returns nothing the caller did not send.
 *   • **A relation filter that only tests existence**
 *     (`aiAgent.findMany({ where: { userMemories: { some: … } } })`): it
 *     returns the root's rows, not the personal ones.
 *   • **Raw SQL** (`model === undefined`). No `where` reaches it; every raw
 *     read of an enforced table is in the manifest
 *     `tests/unit/lib/db/owner-raw-sql-manifest.test.ts` keeps.
 *
 * **What it tells the guard.** A checked read that passed is reported
 * (`onConfinedRead`), and so is a read of a personal model not enforced yet
 * (`onUncheckedRead`): the guard counts the first as the route having used
 * the policy's answer only when there was none of the second
 * (`reportOwnershipGap` in `lib/auth/guards.ts`).
 *
 * **Cost.** Off the enforced models a read pays one set lookup, plus a walk
 * of its `include` / `select` when it has one. An enforced read under a
 * narrowed caller pays the subject lookup (memoised per request) and one walk
 * of its `where`. Measured in the design doc, Spike register item 8.
 *
 * @see lib/db/owner-classification.ts — which models, and how each owner is reached
 * @see lib/auth/subject-context.ts — who is asking
 * @see .context/auth/authorization.md — "The owner chokepoint"
 */

import type { UnattributedReadKind, UnattributedReads } from '@/lib/auth/orphan-reads';
import type { SubjectReadScope } from '@/lib/auth/subject-context';
import {
  ownerClassificationOf,
  type OwnerClassification,
  type OwnerPath,
} from '@/lib/db/owner-classification';
import type { TenancyClient } from '@/lib/db/tenancy-extension';
import {
  readInlineSchema,
  readRuntimeDataModel,
  type RuntimeDataModel,
} from '@/lib/tenancy/classification';

/** Reads whose filter must confine them: their result cannot be checked row by row. */
const FILTER_CHECKED_OPS: ReadonlySet<string> = new Set([
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

/**
 * Reads of one row by a unique key: run, then the row is checked — except on
 * `through` and `alsoVisible` models, where the read is narrowed to the
 * caller's predicate and a miss is resolved with `existsOutside`.
 */
const RESULT_CHECKED_OPS: ReadonlySet<string> = new Set(['findUnique', 'findUniqueOrThrow']);

/** Reads of the first match: the caller's own predicate is added to the filter. */
const NARROWED_OPS: ReadonlySet<string> = new Set(['findFirst', 'findFirstOrThrow']);

/** Writes that return the rows they write: their filter must confine them. */
const RETURNING_WRITE_OPS: ReadonlySet<string> = new Set([
  'update',
  'upsert',
  'delete',
  'updateManyAndReturn',
]);

function isReadOp(operation: string): boolean {
  return (
    FILTER_CHECKED_OPS.has(operation) ||
    RESULT_CHECKED_OPS.has(operation) ||
    NARROWED_OPS.has(operation)
  );
}

/** Why a read was refused. */
export type OwnerRefusalReason =
  /** A list, count or aggregate whose filter does not confine it. */
  | 'unconfined-filter'
  /** A single-row read that returned a row this caller may not read. */
  | 'foreign-row'
  /** A write that returns its row, whose filter does not confine it. */
  | 'unconfined-write'
  /** An `include` / `select` / `_count` of an enforced relation with no confining `where`. */
  | 'unconfined-relation'
  /** A fork's read rule (`owner: { reader }`) threw, or returned no usable `where`. */
  | 'read-rule-failed';

/**
 * A narrowed caller's read of rows it may not read. Thrown in every
 * environment; `handleAPIError` answers it as a 404 so the refusal does not
 * confirm the row exists. The message names the model and operation and never
 * a row's content.
 */
export class OwnerReadRefusedError extends Error {
  constructor(
    readonly model: string,
    readonly operation: string,
    readonly reason: OwnerRefusalReason,
    detail: string
  ) {
    super(
      `Refused ${model}.${operation} for a caller narrowed to their own rows: ${detail} ` +
        'Narrow the query with session.subjectFilter, or wrap a deliberate crossing in ' +
        'runAcrossOwners(reason, fn). See .context/auth/authorization.md ("The owner chokepoint").'
    );
    this.name = 'OwnerReadRefusedError';
  }
}

/** The caller a read is checked for: whose rows, which ownerless kinds, and whether shares count. */
export interface OwnerReader {
  userId: string;
  unattributedReads: UnattributedReads;
  /**
   * Whether a model's `alsoVisible` arms admit rows for this caller. A share is
   * its owner's consent to the admin surface, where every shared read is
   * audit-logged (`.context/security/conversation-access.md`) — not to other
   * members — so only a `withAdminAuth` request reads through one.
   */
  readsShared: boolean;
}

/**
 * The reader a scope narrows to, or `null` when it does not narrow — no
 * subject, a deliberate crossing, or a caller who may see every subject.
 */
export function readerFor(scope: SubjectReadScope): OwnerReader | null {
  if (scope.kind !== 'subject' || scope.filter.userId === undefined) return null;
  return {
    userId: scope.filter.userId,
    unattributedReads: scope.unattributedReads,
    readsShared: scope.readsShared,
  };
}

/** One model's fields, indexed once so the analysis never scans them. */
interface ModelIndex {
  /** Every field name, scalar and relation. */
  fields: ReadonlySet<string>;
  /** Each relation field's target model. */
  relations: ReadonlyMap<string, string>;
  /** Each relation field's relation name, which the two ends of a relation share. */
  relationNames: ReadonlyMap<string, string>;
  /** The relation fields that are lists (`Type[]`); every other relation is to-one. */
  lists: ReadonlySet<string>;
}

/** What the analysis reads about the schema and the classification. */
export interface OwnerSchema {
  /** Per model, its fields — built once from the runtime data model. */
  models: ReadonlyMap<string, ModelIndex>;
  /** Models the layer enforces. */
  enforced: ReadonlySet<string>;
  /** Personal models not enforced yet: a read of one is not checked, and the guard is told. */
  unchecked: ReadonlySet<string>;
  /**
   * Per enforced model, the to-one relation whose foreign key is its owner
   * column (`user` for `userId`), so `user: { id: me }` confines as
   * `userId: me` does. Absent when the schema declares none.
   */
  ownerRelation: ReadonlyMap<string, string>;
  /** The classification of a model, or `null`. Injected so tests can classify a fixture. */
  classify: (model: string) => OwnerClassification | null;
}

/** Derive {@link OwnerSchema} from a generated client and the enforced set. */
export function readOwnerSchema(
  client: unknown,
  enforced: readonly string[],
  classify: (model: string) => OwnerClassification | null = ownerClassificationOf
): OwnerSchema {
  const rdm = readRuntimeDataModel(client);
  const enforcedSet = new Set(enforced);
  for (const model of enforced) assertEnforceable(model, classify(model), rdm, enforcedSet);

  // The compact runtime data model does not say which relations are lists;
  // the schema text does. Only needed once something is enforced.
  const lists: ReadonlyMap<string, Set<string>> = enforced.length > 0
    ? listRelationsIn(readInlineSchema(client))
    : new Map();

  const models = new Map<string, ModelIndex>();
  const unchecked = new Set<string>();
  for (const [name, model] of Object.entries(rdm.models)) {
    const relationFields = model.fields.filter((f) => f.kind === 'object');
    models.set(name, {
      fields: new Set(model.fields.map((f) => f.name)),
      relations: new Map(relationFields.map((f) => [f.name, f.type])),
      relationNames: new Map(
        relationFields.flatMap((f) =>
          f.relationName === undefined ? [] : [[f.name, f.relationName] as const]
        )
      ),
      lists: lists.get(name) ?? new Set(),
    });
    if (!enforcedSet.has(name) && classify(name)?.kind === 'personal') unchecked.add(name);
  }

  const ownerRelation = new Map<string, string>();
  if (enforced.length > 0) {
    const schemaText = readInlineSchema(client);
    for (const model of enforced) {
      const c = classify(model);
      if (c?.kind !== 'personal' || !('column' in c.owner)) continue;
      const relation = ownerRelationIn(schemaText, model, c.owner.column);
      if (relation !== null) ownerRelation.set(model, relation);
    }
  }

  return { models, enforced: enforcedSet, unchecked, ownerRelation, classify };
}

/**
 * The relation field of `model` declared `@relation(fields: [column],
 * references: [id])`, read from the schema text: the compact runtime data
 * model does not record which fields a relation's foreign key is.
 */
function ownerRelationIn(schemaText: string, model: string, column: string): string | null {
  let inside = false;
  for (const line of schemaText.split('\n')) {
    if (!inside) {
      inside = new RegExp(`^model\\s+${model}\\s*\\{`).test(line);
      continue;
    }
    if (line.startsWith('}')) return null;
    const relation = /^\s*(\w+)\s+\w+\??\s+@relation\((.*)\)/.exec(line);
    if (
      relation &&
      new RegExp(`\\bfields:\\s*\\[\\s*${column}\\s*\\]`).test(relation[2]) &&
      /\breferences:\s*\[\s*id\s*\]/.test(relation[2])
    ) {
      return relation[1];
    }
  }
  return null;
}

/**
 * Per model, the fields declared as lists (`name Type[]`), read from the
 * schema text. A scalar list (`tags String[]`) is listed too; only relation
 * fields are ever looked up in it.
 */
function listRelationsIn(schemaText: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  let current: Set<string> | null = null;
  for (const line of schemaText.split('\n')) {
    const open = /^model\s+(\w+)\s*\{/.exec(line);
    if (open) {
      current = new Set();
      out.set(open[1], current);
      continue;
    }
    if (line.startsWith('}')) {
      current = null;
      continue;
    }
    const field = current === null ? null : /^\s*(\w+)\s+\w+\[\]/.exec(line);
    if (field) current?.add(field[1]);
  }
  return out;
}

/**
 * How each `alsoVisible` arm is reached: the to-one relation on the personal
 * model whose state admits the row. `'active-share'` is a conversation's
 * share while it is live — `conversationVisibilityWhere`'s third arm.
 */
const ALSO_VISIBLE_RELATION = { 'active-share': 'share' } as const;

/**
 * Refuse, at construction, to enforce a model this layer cannot fully check.
 *
 * A `through` owner is checked as its parent's predicate, so the parent must
 * be enforced too — otherwise a child would be held to a rule its parent is
 * not. A single-row read of a model whose readability is not on the row
 * itself (a `through` owner, or an `alsoVisible` arm) that misses asks
 * whether the row exists by selecting its `id`, so the model needs one. Failing here rather than at the first query
 * is what keeps a half-supported model from being switched on by a one-line
 * classification change.
 */
function assertEnforceable(
  model: string,
  c: OwnerClassification | null,
  rdm: RuntimeDataModel,
  enforced: ReadonlySet<string>
): void {
  if (!c || c.kind !== 'personal') {
    throw new Error(`Owner layer: ${model} is enforced but not classified personal`);
  }
  const fields = rdm.models[model]?.fields ?? [];
  const scalar = (name: string) => fields.some((f) => f.kind === 'scalar' && f.name === name);
  if ('column' in c.owner) {
    if (!scalar(c.owner.column)) {
      throw new Error(`Owner layer: ${model}.${c.owner.column} is not a scalar column of ${model}`);
    }
  } else if ('reader' in c.owner) {
    if (typeof c.owner.reader !== 'function') {
      throw new Error(`Owner layer: ${model}'s owner.reader is not a function`);
    }
    // The rule is the whole answer: an ownerless or alsoVisible arm beside it
    // would be a second rule the fork's own one never sees.
    if (c.ownerless !== undefined || (c.alsoVisible ?? []).length > 0) {
      throw new Error(`Owner layer: ${model} has a read rule and an ownerless or alsoVisible arm`);
    }
  } else {
    const { field, parent } = c.owner.through;
    if (!fields.some((f) => f.kind === 'object' && f.name === field && f.type === parent)) {
      throw new Error(`Owner layer: ${model}.${field} is not a relation to ${parent}`);
    }
    if (!enforced.has(parent)) {
      throw new Error(
        `Owner layer: ${model} is owned through ${parent}, which is not enforced — enforce the parent first`
      );
    }
  }
  for (const arm of c.alsoVisible ?? []) {
    const relation = ALSO_VISIBLE_RELATION[arm];
    if (!fields.some((f) => f.kind === 'object' && f.name === relation)) {
      throw new Error(`Owner layer: ${model} declares ${arm} but has no ${relation} relation`);
    }
  }
  if (!confirmsByOwnerColumn(c) && !scalar('id')) {
    throw new Error(`Owner layer: ${model} has no id to confirm a single-row read by`);
  }
}

/**
 * Whether a returned row's own owner column decides if it is readable. Not so
 * for a `through` owner (the owner is on the parent) or an `alsoVisible` arm
 * (the share's state is on another row): those reads are narrowed instead.
 */
function confirmsByOwnerColumn(
  c: Extract<OwnerClassification, { kind: 'personal' }>
): c is Extract<OwnerClassification, { kind: 'personal' }> & { owner: { column: string } } {
  return 'column' in c.owner && (c.alsoVisible ?? []).length === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function personal(
  schema: OwnerSchema,
  model: string
): Extract<OwnerClassification, { kind: 'personal' }> | null {
  const c = schema.classify(model);
  return c?.kind === 'personal' ? c : null;
}

/** May this reader read ownerless rows of `kind`? Absent kind: nobody narrowed may. */
function readsOwnerless(reader: OwnerReader, kind: UnattributedReadKind | undefined): boolean {
  return kind !== undefined && reader.unattributedReads[kind];
}

/** A scalar filter value that pins the column to exactly `id`. */
function pinsTo(value: unknown, id: string): boolean {
  if (value === id) return true;
  if (!isRecord(value)) return false;
  if (value.equals === id) return true;
  // `in: []` matches nothing, so it confines too.
  return Array.isArray(value.in) && value.in.every((v: unknown) => v === id);
}

/** A scalar filter value that pins the column to null. */
function pinsToNull(value: unknown): boolean {
  return value === null || (isRecord(value) && value.equals === null);
}

/** The inner `where` of a to-one relation filter: `{ is: W }` or the bare `W`. */
function toOneInner(value: Record<string, unknown>): unknown {
  return 'is' in value ? value.is : 'isNot' in value ? undefined : value;
}

/**
 * Does `where` on `model` confine the read to rows `reader` may read?
 *
 * Every key of a `where` object is a conjunct, so one confining key confines
 * the whole. `OR` confines when every arm does (an empty `OR` matches
 * nothing). `NOT` never confines. A compound unique key
 * (`userId_agentId_key: { … }`) is a conjunction of its fields.
 *
 * Exported for the parity test: the route layer's disposition and this
 * function must agree on what narrowed means.
 */
export function whereConfines(
  schema: OwnerSchema,
  model: string,
  where: unknown,
  reader: OwnerReader
): boolean {
  if (!isRecord(where)) return false;
  const c = personal(schema, model);
  // A fork's read rule is never proven from a filter: the read is narrowed by
  // it instead (`narrowsByRule`).
  if (!c || 'reader' in c.owner) return false;
  const fields = schema.models.get(model)?.fields;
  const ownerRelation = schema.ownerRelation.get(model);

  for (const [key, value] of Object.entries(where)) {
    if (key === 'AND') {
      const conjuncts = Array.isArray(value) ? value : [value];
      if (conjuncts.some((w: unknown) => whereConfines(schema, model, w, reader))) return true;
      continue;
    }
    if (key === 'OR') {
      if (
        Array.isArray(value) &&
        value.every((w: unknown) => whereConfines(schema, model, w, reader))
      ) {
        return true;
      }
      continue;
    }
    if (key === 'NOT') continue;
    if (ownerLeafConfines(schema, c.owner, c.ownerless, key, value, reader)) return true;
    if (key === ownerRelation && ownerRelationConfines(c.ownerless, value, reader)) return true;
    if (
      reader.readsShared &&
      (c.alsoVisible ?? []).some((arm) => ALSO_VISIBLE_RELATION[arm] === key) &&
      activeShareConfines(value)
    ) {
      return true;
    }
    // A compound unique key: not a field, and its value names fields.
    if (!fields?.has(key) && isRecord(value)) {
      if (whereConfines(schema, model, value, reader)) return true;
    }
  }
  return false;
}

/** Does the `key: value` conjunct pin this model's owner to something the reader may read? */
function ownerLeafConfines(
  schema: OwnerSchema,
  owner: OwnerPath,
  ownerless: UnattributedReadKind | undefined,
  key: string,
  value: unknown,
  reader: OwnerReader
): boolean {
  if ('column' in owner) {
    if (key !== owner.column) return false;
    return pinsTo(value, reader.userId) || (pinsToNull(value) && readsOwnerless(reader, ownerless));
  }
  if ('reader' in owner) return false;
  const { field, parent } = owner.through;
  if (key !== field) return false;
  // A child with no parent: its own ownerless arm.
  if (value === null || (isRecord(value) && value.is === null)) {
    return readsOwnerless(reader, ownerless);
  }
  if (!isRecord(value)) return false;
  // The parent's predicate, analysed as the parent's: the child inherits its
  // ownerless and alsoVisible arms (`owner-classification.ts`, OwnerPath).
  return whereConfines(schema, parent, toOneInner(value), reader);
}

/**
 * Does a filter on the owner relation (`user: { id: me }`, `user: { is: { id: me } }`)
 * pin the owner as `userId: me` would? `user: null` is the ownerless arm.
 */
function ownerRelationConfines(
  ownerless: UnattributedReadKind | undefined,
  value: unknown,
  reader: OwnerReader
): boolean {
  if (value === null || (isRecord(value) && value.is === null)) {
    return readsOwnerless(reader, ownerless);
  }
  if (!isRecord(value)) return false;
  const inner = toOneInner(value);
  return isRecord(inner) && pinsTo(inner.id, reader.userId);
}

/**
 * How far in the past an active-share filter's `expiresAt > t` may put `t`
 * and still count as "not expired": the `where` is built a moment before it
 * is checked. Anything older would admit shares that have already expired.
 */
const SHARE_CLOCK_SKEW_MS = 60_000;

/** An `expiresAt` conjunct that leaves out every expired share. */
function excludesExpired(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  const bound = value.gt ?? value.gte;
  const at =
    bound instanceof Date ? bound.getTime() : typeof bound === 'string' ? Date.parse(bound) : NaN;
  return Number.isFinite(at) && at >= Date.now() - SHARE_CLOCK_SKEW_MS;
}

/**
 * Does a filter on the share relation select only live shares —
 * `revokedAt: null` and an expiry in the future or none? The shape
 * `conversationVisibilityWhere` emits, and the one
 * {@link readablePredicate} builds.
 */
function activeShareConfines(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const inner = toOneInner(value);
  if (!isRecord(inner) || !pinsToNull(inner.revokedAt)) return false;
  if ('expiresAt' in inner) return excludesExpired(inner.expiresAt);
  const { OR } = inner;
  return (
    Array.isArray(OR) &&
    OR.length > 0 &&
    OR.every(
      (arm: unknown) => isRecord(arm) && 'expiresAt' in arm && excludesExpired(arm.expiresAt)
    )
  );
}

/**
 * The `where` selecting exactly the rows of `model` that `reader` may read:
 * its own, ownerless ones where the policy admits them, and each
 * `alsoVisible` arm — through the parent for a `through` owner. A fork's read
 * rule (`owner: { reader }`) is the whole answer for its model, and a
 * `through` child of one is the rule under the relation. Used to narrow a
 * `findFirst`, to confirm a single-row read, and for a fork's read rule to
 * narrow every read; {@link whereConfines} holds for it by construction except
 * under a read rule, which no filter proves (pinned in the tests).
 *
 * `operation` names the read in the refusal a failing read rule raises.
 */
export function readablePredicate(
  schema: OwnerSchema,
  model: string,
  reader: OwnerReader,
  operation = 'read'
): Record<string, unknown> {
  const c = personal(schema, model);
  if (!c) throw new Error(`Owner layer: ${model} is not personal`);
  const arms: Record<string, unknown>[] = [];
  if ('column' in c.owner) {
    const column = c.owner.column;
    arms.push({ [column]: reader.userId });
    if (readsOwnerless(reader, c.ownerless)) arms.push({ [column]: null });
  } else if ('reader' in c.owner) {
    arms.push(ruleWhere(model, c.owner.reader, reader, operation));
  } else {
    const { field, parent } = c.owner.through;
    arms.push({ [field]: { is: readablePredicate(schema, parent, reader, operation) } });
    if (readsOwnerless(reader, c.ownerless)) arms.push({ [field]: null });
  }
  for (const arm of reader.readsShared ? (c.alsoVisible ?? []) : []) {
    arms.push({
      // An owned row only, as `conversationVisibilityWhere`'s share arm: a
      // share is the owner's consent, and a row nobody owns has no owner to
      // give it — so the two faces agree about an ownerless, shared row.
      ...('column' in c.owner ? { [c.owner.column]: { not: null } } : {}),
      [ALSO_VISIBLE_RELATION[arm]]: {
        is: { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      },
    });
  }
  return arms.length === 1 ? arms[0] : { OR: arms };
}

/**
 * A fork's read rule, run for `reader`, failing closed. A rule that throws, or
 * returns anything but a non-empty object, refuses the read: `{}` would admit
 * every row, which is a model with no owner — classify that `not-personal`.
 * The answer is a fresh copy, so a rule handing back a shared constant is not
 * changed by what the layer adds to it.
 */
function ruleWhere(
  model: string,
  rule: (reader: OwnerReader) => object,
  reader: OwnerReader,
  operation: string
): Record<string, unknown> {
  let where: unknown;
  try {
    where = rule({ ...reader, unattributedReads: { ...reader.unattributedReads } });
  } catch {
    // The rule's own error is not surfaced: it could carry row content.
    throw new OwnerReadRefusedError(model, operation, 'read-rule-failed', 'its read rule threw.');
  }
  if (!isRecord(where) || Object.keys(where).length === 0) {
    throw new OwnerReadRefusedError(
      model,
      operation,
      'read-rule-failed',
      'its read rule returned no where to narrow by.'
    );
  }
  return { ...where };
}

/**
 * Is `model` read by a fork's rule — its own (`owner: { reader }`), or a
 * parent's it is owned `through`? Such a read is narrowed by the rule rather
 * than refused for want of a confining filter.
 */
export function narrowsByRule(schema: OwnerSchema, model: string): boolean {
  let current = model;
  // Bounded: a `through` chain is a few links; a cycle is a misclassification.
  for (let depth = 0; depth < 16; depth++) {
    const c = personal(schema, current);
    if (!c || 'column' in c.owner) return false;
    if ('reader' in c.owner) return true;
    current = c.owner.through.parent;
  }
  return false;
}

/**
 * May `reader` read a row of `model` whose owner column holds `owner`? Decides
 * only for a model whose owner column is the whole answer; a read of one
 * owned `through` a parent, or with an `alsoVisible` arm, is narrowed instead.
 */
export function rowReadable(
  schema: OwnerSchema,
  model: string,
  owner: unknown,
  reader: OwnerReader
): boolean {
  const c = personal(schema, model);
  if (!c) return true;
  if (owner === reader.userId) return true;
  return owner === null && readsOwnerless(reader, c.ownerless);
}

/** An enforced relation a read's `include` / `select` reaches, with the `where` it carries. */
interface EnforcedNode {
  /** Dotted path from the root, for the refusal message. */
  path: string;
  model: string;
  /** Absent for a to-one relation or a bare `_count`, which cannot carry one. */
  where: unknown;
  /**
   * The relation fields from the root to this relation — or, for a `_count`,
   * to the node whose `_count` it is — so a read rule's `where` can be put
   * there.
   */
  keys: readonly string[];
  /** A to-one relation: it cannot carry a `where`, so a read rule cannot narrow it. */
  toOne: boolean;
  /** For a `_count` of this relation: the relation's name in the `_count`. */
  counted?: string;
}

/**
 * A to-one relation to an enforced model whose owner column decides a row
 * (`a run's dataset`): it cannot carry a `where`, so the row it returns is
 * checked instead, as a single-row read is.
 */
interface RowCheckedNode {
  /** Dotted path from the root, for the refusal message. */
  path: string;
  /** The relation fields from the root to this node, in order. */
  keys: readonly string[];
  model: string;
  /** The owner column the returned row is checked on. */
  column: string;
}

/** What a read's `include` / `select` reaches, found in one pure walk. */
export interface SelectionScan {
  enforced: EnforcedNode[];
  /** To-one relations whose returned rows are checked rather than their filter. */
  rowChecked: RowCheckedNode[];
  /** Whether it reaches a personal model not enforced yet. */
  touchesUnchecked: boolean;
}

/**
 * Walk a read's `include` / `select` once, at any depth. Pure, and needs no
 * subject: the reader is looked up only when the walk found an enforced
 * relation, and then each one is checked against it.
 */
export function scanSelection(
  schema: OwnerSchema,
  model: string,
  args: unknown,
  rootChecked = false
): SelectionScan {
  const scan: SelectionScan = { enforced: [], rowChecked: [], touchesUnchecked: false };
  scanArgs(schema, model, args, model, [], rootChecked, scan);
  return scan;
}

/**
 * Does the relation `key` on `model` join a personal child to its parent
 * along the child's ownership relation, in either direction? A conversation's
 * `messages`, and a message's `conversation`, both do.
 *
 * Along such an edge the rows on the far side are readable exactly when the
 * near side's are (`OwnerPath`: the child inherits the parent's visibility),
 * so an edge leaving a node that is itself checked needs no `where` of its
 * own. Leaving a node nothing checks — a `create`'s returned row, or a model
 * that is not enforced — it does.
 */
function inheritsAlong(schema: OwnerSchema, model: string, key: string, target: string): boolean {
  const here = personal(schema, model);
  if (here && 'through' in here.owner && here.owner.through.field === key) return true;
  const there = personal(schema, target);
  if (!there || !('through' in there.owner) || there.owner.through.parent !== model) return false;
  const name = schema.models.get(model)?.relationNames.get(key);
  return (
    name !== undefined &&
    schema.models.get(target)?.relationNames.get(there.owner.through.field) === name
  );
}

function scanArgs(
  schema: OwnerSchema,
  model: string,
  args: unknown,
  path: string,
  keys: readonly string[],
  checked: boolean,
  scan: SelectionScan
): void {
  if (!isRecord(args)) return;
  scanNode(schema, model, args.include, path, keys, checked, scan);
  scanNode(schema, model, args.select, path, keys, checked, scan);
}

function scanNode(
  schema: OwnerSchema,
  model: string,
  node: unknown,
  path: string,
  keys: readonly string[],
  checked: boolean,
  scan: SelectionScan
): void {
  if (!isRecord(node)) return;
  const relations = schema.models.get(model)?.relations;
  if (!relations) return;
  for (const [key, value] of Object.entries(node)) {
    if (value === false || value === undefined) continue;
    if (key === '_count') {
      // `_count: true` counts every relation; `_count: { select }` the named ones.
      // Prisma counts list relations only, so `true` names those.
      const lists = schema.models.get(model)?.lists;
      const counted: [string, unknown][] =
        value === true
          ? [...relations.keys()].filter((rel) => lists?.has(rel)).map((rel) => [rel, true])
          : isRecord(value) && isRecord(value.select)
            ? Object.entries(value.select)
            : [];
      for (const [rel, sel] of counted) {
        const target = relations.get(rel);
        if (target === undefined || !schema.enforced.has(target) || sel === false) continue;
        if (checked && inheritsAlong(schema, model, rel, target)) continue;
        scan.enforced.push({
          path: `${path}._count.${rel}`,
          model: target,
          where: isRecord(sel) ? sel.where : undefined,
          keys,
          toOne: false,
          counted: rel,
        });
      }
      continue;
    }
    const target = relations.get(key);
    if (target === undefined) continue;
    const here = `${path}.${key}`;
    const hereKeys = [...keys, key];
    // Every include of an enforced relation must carry a `where` that confines
    // it — unless it follows the ownership relation out of a checked node,
    // where the far side is readable exactly when this side is. A to-one
    // relation cannot take a `where`: when the target's own owner column
    // decides its row (a run's `dataset`), the row it returns is checked,
    // as a single-row read is; otherwise (a `through` owner, an `alsoVisible`
    // arm) reading up to it from anywhere else is refused.
    if (schema.enforced.has(target)) {
      if (!(checked && inheritsAlong(schema, model, key, target))) {
        const c = personal(schema, target);
        const toOne = !schema.models.get(model)?.lists.has(key);
        if (toOne && c !== null && confirmsByOwnerColumn(c)) {
          scan.rowChecked.push({
            path: here,
            keys: hereKeys,
            model: target,
            column: c.owner.column,
          });
        } else {
          scan.enforced.push({
            path: here,
            model: target,
            where: isRecord(value) ? value.where : undefined,
            keys: hereKeys,
            toOne,
          });
        }
      }
      scanArgs(schema, target, value, here, hereKeys, true, scan);
      continue;
    }
    if (schema.unchecked.has(target)) scan.touchesUnchecked = true;
    scanArgs(schema, target, value, here, hereKeys, false, scan);
  }
}

/**
 * `args` with each row-checked relation's owner column selected, so the
 * returned row can be checked — and, per node, whether that column was added
 * (and must be stripped from the answer). Leaves `args` itself untouched.
 */
function withRowOwnerColumns(
  args: unknown,
  nodes: readonly RowCheckedNode[]
): { args: unknown; strip: boolean[] } {
  let out = args;
  const strip = nodes.map((node) => {
    const next = atRelation(out, node.keys, node.column);
    out = next.args;
    return next.strip;
  });
  return { args: out, strip };
}

/** Descend `keys` through `include` / `select` and select `column` at the end. */
function atRelation(
  args: unknown,
  keys: readonly string[],
  column: string
): { args: unknown; strip: boolean } {
  if (!isRecord(args)) return { args, strip: false };
  const [key, ...rest] = keys;
  for (const container of ['include', 'select'] as const) {
    const node = args[container];
    if (!isRecord(node) || !(key in node)) continue;
    const value = node[key];
    if (rest.length > 0) {
      const inner = atRelation(value, rest, column);
      return { args: { ...args, [container]: { ...node, [key]: inner.args } }, strip: inner.strip };
    }
    // `true` and an `include`-only object return every scalar already.
    if (!isRecord(value)) return { args, strip: false };
    const sent = withOwnerColumn(value, column);
    return { args: { ...args, [container]: { ...node, [key]: sent.args } }, strip: sent.strip };
  }
  return { args, strip: false };
}

/** Every object found at the end of `keys` in a result, across lists at any level. */
function rowsAt(result: unknown, keys: readonly string[]): Record<string, unknown>[] {
  if (Array.isArray(result)) return result.flatMap((r: unknown) => rowsAt(r, keys));
  if (!isRecord(result)) return [];
  if (keys.length === 0) return [result];
  const [key, ...rest] = keys;
  return rowsAt(result[key], rest);
}

/** The first enforced relation in `scan` whose `where` does not confine it for `reader`, or `null`. */
function firstUnconfined(
  schema: OwnerSchema,
  scan: SelectionScan,
  reader: OwnerReader
): string | null {
  for (const node of scan.enforced) {
    if (narrowsRelation(schema, node)) continue;
    if (!whereConfines(schema, node.model, node.where, reader)) return node.path;
  }
  return null;
}

/**
 * Is this relation narrowed by a fork's read rule rather than held to its own
 * `where`? A to-many one is: the rule is ANDed into its `where`. A to-one one
 * cannot carry a `where`, and no column on its row decides, so it is refused.
 */
function narrowsRelation(schema: OwnerSchema, node: EnforcedNode): boolean {
  return !node.toOne && narrowsByRule(schema, node.model);
}

/** `args` with `fn` applied to the value at the end of `keys`, through `include` / `select`. */
function updateAt(
  args: unknown,
  keys: readonly string[],
  fn: (value: unknown) => unknown
): unknown {
  if (keys.length === 0) return fn(args);
  if (!isRecord(args)) return args;
  const [key, ...rest] = keys;
  let out = args;
  for (const container of ['include', 'select'] as const) {
    const node = out[container];
    if (!isRecord(node) || !(key in node)) continue;
    out = { ...out, [container]: { ...node, [key]: updateAt(node[key], rest, fn) } };
  }
  return out;
}

/** A relation's args (`true` or an object) with `rule` ANDed into its `where`. */
function relationWith(value: unknown, rule: Record<string, unknown>): Record<string, unknown> {
  const base = isRecord(value) ? value : {};
  return { ...base, where: base.where === undefined ? rule : andWith(base.where, rule) };
}

/**
 * `args` with each to-many relation a read rule governs narrowed by that rule:
 * the rule ANDed into the relation's `where`, or into its entry in a `_count`.
 * A `_count: true` is spelled out over the node's list relations first, so the
 * one being narrowed can carry a `where`.
 */
function withRuleNarrowing(
  schema: OwnerSchema,
  rootModel: string,
  args: unknown,
  nodes: readonly EnforcedNode[],
  reader: OwnerReader,
  operation: string
): unknown {
  let out = args;
  for (const node of nodes) {
    const rule = readablePredicate(schema, node.model, reader, operation);
    const counted = node.counted;
    if (counted === undefined) {
      out = updateAt(out, node.keys, (value) => relationWith(value, rule));
      continue;
    }
    const owner = modelAt(schema, rootModel, node.keys);
    out = updateAt(out, node.keys, (value) => {
      if (!isRecord(value)) return value;
      let next = value;
      for (const container of ['include', 'select'] as const) {
        const holder = next[container];
        if (!isRecord(holder) || holder._count === undefined || holder._count === false) continue;
        const count = holder._count;
        const select: Record<string, unknown> =
          count === true
            ? Object.fromEntries(
                [...(schema.models.get(owner)?.lists ?? [])]
                  .filter((rel) => schema.models.get(owner)?.relations.has(rel))
                  .map((rel) => [rel, true])
              )
            : isRecord(count) && isRecord(count.select)
              ? count.select
              : {};
        const countArgs = isRecord(count) ? count : {};
        next = {
          ...next,
          [container]: {
            ...holder,
            _count: {
              ...countArgs,
              select: { ...select, [counted]: relationWith(select[counted], rule) },
            },
          },
        };
      }
      return next;
    });
  }
  return out;
}

/** The model at the end of a relation path from `root`. */
function modelAt(schema: OwnerSchema, root: string, keys: readonly string[]): string {
  let model = root;
  for (const key of keys) model = schema.models.get(model)?.relations.get(key) ?? model;
  return model;
}

/**
 * The first enforced relation this read's `include` / `select` reaches without
 * a confining `where`, as a dotted path — or `null` when every one is confined.
 */
export function unconfinedRelation(
  schema: OwnerSchema,
  model: string,
  args: unknown,
  reader: OwnerReader
): string | null {
  return firstUnconfined(schema, scanSelection(schema, model, args), reader);
}

/**
 * The typed boundary for Prisma's top-level `$allOperations` hook, which
 * types `args` and `query` as `any` — as in `tenancy-extension.ts`.
 */
interface OperationParams {
  model?: string;
  operation: string;
  args: unknown;
  query: (args: unknown) => Promise<unknown>;
}

/** What the layer reads from the outside; `lib/db/client.ts` wires the real ones. */
export interface OwnerExtensionOptions {
  /** The schema and the enforced set — {@link readOwnerSchema} on the base client. */
  schema: OwnerSchema;
  /** Whose rows the current call stack may read (`getSubjectReadScope`). */
  getSubjectReadScope: () => Promise<SubjectReadScope>;
  /**
   * Told when an enforced read under a narrowed caller passed the check
   * (`noteConfinedRead`). The guard counts that as the route having used the
   * policy's answer (`reportOwnershipGap`): the data layer narrowed the read
   * for it — but only when the route read no personal model this layer does
   * not check yet, which {@link onUncheckedRead} reports.
   */
  onConfinedRead: () => void;
  /**
   * Told when a read reaches a personal model not enforced yet, for any
   * caller (`noteUncheckedRead`). Nothing checked that read, so a confined
   * read elsewhere in the route says nothing about it.
   */
  onUncheckedRead: () => void;
}

/**
 * Ensure a single-row read returns the owner column, so the row can be checked.
 * Returns the args to send and whether the column must be stripped afterwards.
 */
function withOwnerColumn(args: unknown, column: string): { args: unknown; strip: boolean } {
  if (!isRecord(args)) return { args, strip: false };
  if (isRecord(args.select)) {
    if (args.select[column] === true) return { args, strip: false };
    return { args: { ...args, select: { ...args.select, [column]: true } }, strip: true };
  }
  if (isRecord(args.omit) && args.omit[column] === true) {
    const { [column]: _dropped, ...omit } = args.omit;
    return { args: { ...args, omit }, strip: true };
  }
  return { args, strip: false };
}

/** Prisma's not-found error, which a `findUniqueOrThrow` raises on a miss. */
function isNotFound(err: unknown): boolean {
  return isRecord(err) && err.code === 'P2025';
}

/** `where` with `predicate` added as one more conjunct, keeping any `AND` it carries. */
function andWith(where: unknown, predicate: Record<string, unknown>): Record<string, unknown> {
  const base = isRecord(where) ? where : {};
  const existing: unknown[] =
    base.AND === undefined ? [] : Array.isArray(base.AND) ? base.AND : [base.AND];
  return { ...base, AND: [...existing, predicate] };
}

/**
 * Does a row match this unique `where` at all? Asked on `client` — the tenancy
 * layer, below this one — so the org's scope is set and the owner check is
 * not. Not on the operation's own `query`: a second call to it runs with no
 * tenancy scope, where the policies hide every row (§115 t-802, found by the
 * two-member harness). Outside any interactive transaction the caller is in,
 * so a row that transaction created and has not committed is not seen: the
 * read then answers "none" — which never discloses a row, and only loses the
 * loud refusal for that one case.
 */
async function existsOutside(
  client: TenancyClient,
  model: string,
  where: unknown
): Promise<boolean> {
  const delegate: unknown = (client as unknown as Record<string, unknown>)[
    model.charAt(0).toLowerCase() + model.slice(1)
  ];
  if (!isRecord(delegate) || typeof delegate.findUnique !== 'function') {
    throw new Error(`Owner layer: no client delegate for ${model}`);
  }
  const findUnique = delegate.findUnique as (args: unknown) => Promise<unknown>;
  return isRecord(await findUnique.call(delegate, { where, select: { id: true } }));
}

/** Apply the owner chokepoint to an already tenancy-extended client. */
export function withOwnerChecks(
  client: TenancyClient,
  options: OwnerExtensionOptions
): TenancyClient {
  const { schema } = options;

  async function handleOperation(params: OperationParams): Promise<unknown> {
    const { model, operation, query } = params;
    if (model === undefined || schema.enforced.size === 0) return query(params.args);

    const isRead = isReadOp(operation);
    const isChecked = schema.enforced.has(model) && (isRead || RETURNING_WRITE_OPS.has(operation));
    const scan = scanSelection(schema, model, params.args, isChecked);
    if (scan.touchesUnchecked || (isRead && schema.unchecked.has(model))) {
      options.onUncheckedRead();
    }

    if (!isChecked && scan.enforced.length === 0 && scan.rowChecked.length === 0) {
      return query(params.args);
    }

    const reader = readerFor(await options.getSubjectReadScope());
    if (reader === null) return query(params.args);

    const relation = firstUnconfined(schema, scan, reader);
    if (relation !== null) {
      throw new OwnerReadRefusedError(
        model,
        operation,
        'unconfined-relation',
        `${relation} reads an enforced model with no where that confines it.`
      );
    }

    // To-one relations checked on the rows they return: their owner column is
    // selected, and every query this operation sends is checked on its answer.
    // A write's read-back is checked after the write — inside a transaction the
    // refusal rolls it back; outside one the write stands.
    // To-many relations a fork's read rule governs are narrowed by it.
    const ruled = scan.enforced.filter((node) => narrowsRelation(schema, node));
    const narrowedArgs =
      ruled.length === 0
        ? params.args
        : withRuleNarrowing(schema, model, params.args, ruled, reader, operation);
    const rowChecks = scan.rowChecked;
    const prepared =
      rowChecks.length === 0
        ? { args: narrowedArgs, strip: [] }
        : withRowOwnerColumns(narrowedArgs, rowChecks);
    const args = prepared.args;
    const send =
      rowChecks.length === 0
        ? query
        : async (sent: unknown): Promise<unknown> => {
            const result = await query(sent);
            rowChecks.forEach((node, i) => {
              for (const row of rowsAt(result, node.keys)) {
                if (!rowReadable(schema, node.model, row[node.column], reader)) {
                  throw new OwnerReadRefusedError(
                    model,
                    operation,
                    'foreign-row',
                    `${node.path} returned a row that belongs to someone else.`
                  );
                }
                if (prepared.strip[i]) delete row[node.column];
              }
            });
            if (isRead) options.onConfinedRead();
            return result;
          };

    if (!isChecked) return send(args);

    const where = isRecord(args) ? args.where : undefined;
    if (whereConfines(schema, model, where, reader)) {
      if (isRead) options.onConfinedRead();
      return send(args);
    }

    const foreignRow = () =>
      new OwnerReadRefusedError(
        model,
        operation,
        'foreign-row',
        'the row it returned belongs to someone else.'
      );

    // A fork's read rule: no filter proves it, so the read is narrowed by it
    // instead of refused (§115 ruling, 2026-11-05). A first match and a read by
    // unique key take the narrowed paths below, as a `through` owner does.
    if (
      narrowsByRule(schema, model) &&
      !NARROWED_OPS.has(operation) &&
      !RESULT_CHECKED_OPS.has(operation)
    ) {
      const rule = readablePredicate(schema, model, reader, operation);
      const narrowed = { ...(isRecord(args) ? args : {}), where: andWith(where, rule) };
      if (FILTER_CHECKED_OPS.has(operation)) {
        options.onConfinedRead();
        return send(narrowed);
      }
      // A returning write: a row outside the rule is not found by it, so it is
      // not written. By unique key, that miss is refused rather than reported
      // absent when the row exists — and an upsert is refused before it runs,
      // or it would create a second row beside one the caller cannot see.
      if (operation === 'upsert') {
        if (
          (await existsOutside(client, model, where)) &&
          !(await existsOutside(client, model, narrowed.where))
        ) {
          throw foreignRow();
        }
        return send(narrowed);
      }
      if (operation === 'updateManyAndReturn') return send(narrowed);
      try {
        return await send(narrowed);
      } catch (err) {
        if (isNotFound(err) && (await existsOutside(client, model, where))) throw foreignRow();
        throw err;
      }
    }

    if (RETURNING_WRITE_OPS.has(operation)) {
      throw new OwnerReadRefusedError(
        model,
        operation,
        'unconfined-write',
        'it returns the row it writes, and its where does not confine it to rows this caller may read.'
      );
    }
    if (FILTER_CHECKED_OPS.has(operation)) {
      throw new OwnerReadRefusedError(
        model,
        operation,
        'unconfined-filter',
        'its where does not confine the read to rows this caller may read.'
      );
    }

    const c = personal(schema, model);
    if (c === null) throw new Error(`Owner layer: ${model} is not personal`);

    // The first match of a filter that does not confine it: narrowed to the
    // rows this caller may read, so the answer does not depend on which match
    // the database happens to return first.
    if (NARROWED_OPS.has(operation)) {
      const own = readablePredicate(schema, model, reader, operation);
      options.onConfinedRead();
      return send({
        ...(isRecord(args) ? args : {}),
        where: { AND: where === undefined ? [own] : [where, own] },
      });
    }

    // A read by unique key whose filter does not confine it, where the row's
    // own owner column decides: run it, then check the row that came back.
    if (confirmsByOwnerColumn(c)) {
      const column = c.owner.column;
      const sent = withOwnerColumn(args, column);
      const row = await send(sent.args);
      if (!isRecord(row)) return row;
      if (!rowReadable(schema, model, row[column], reader)) throw foreignRow();
      options.onConfinedRead();
      if (!sent.strip) return row;
      const { [column]: _owner, ...rest } = row;
      return rest;
    }

    // Where it does not — a `through` owner, or an `alsoVisible` arm — the
    // read runs narrowed to what this caller may read, in the caller's own
    // transaction: a readable row costs nothing extra. Only a miss asks
    // whether some row matched that this caller may not read, to refuse it
    // rather than report it absent.
    let row: unknown;
    let miss: Error | null = null;
    try {
      row = await send({
        ...(isRecord(args) ? args : {}),
        where: andWith(where, readablePredicate(schema, model, reader, operation)),
      });
    } catch (err) {
      if (!(err instanceof Error) || !isNotFound(err)) throw err;
      miss = err;
    }
    if (isRecord(row)) {
      options.onConfinedRead();
      return row;
    }
    if (await existsOutside(client, model, where)) throw foreignRow();
    if (miss !== null) throw miss;
    return row;
  }

  // Applied over the tenancy layer, so its `$transaction` override hands this
  // layer's hook the `tx` client too (tenancy-extension.ts, "Transactions").
  const extended: unknown = client.$extends({
    name: 'sunrise-owner',
    query: {
      $allOperations: (params) => handleOperation(params),
    },
  });
  return extended as TenancyClient;
}
