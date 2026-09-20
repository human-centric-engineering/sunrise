/**
 * Tenancy chokepoint — the one place a query learns which org it runs for
 * (§107 t-706).
 *
 * `lib/db/client.ts` applies {@link withTenancy} to the client every importer
 * receives, so no route handler, job or script learns about `orgId`: the
 * guard entered the org (`lib/tenancy/context.ts`), and this extension reads
 * it below the handler. It does two things, and only these two:
 *
 *   • **Stamps `orgId` on every create** of a tenant-owned row — both modes,
 *     one code path: at `single` the org is the install org, at `multi` the
 *     context's. The walk runs on every write whatever the root model (an
 *     `AiAgent` update can carry a nested `embedTokens.create`) and stamps
 *     create-shaped nodes only. Stamping an update payload would `SET
 *     "orgId"` and move a row between orgs wherever RLS is not enforcing —
 *     every `single` install (design doc, Spike register item 2). The stamp
 *     takes the form the row already uses — the scalar `orgId`, or
 *     `org: { connect }` when the row names a relation that carries its own
 *     foreign key (Prisma's checked create form forbids the scalar there).
 *     An explicit `orgId` or `org` is never overwritten; under `runAsSystem`
 *     nothing is stamped.
 *   • **Scopes each operation at `multi`** as
 *     `$transaction([set_config('app.current_org', org, true), op])` — the
 *     transaction-local GUC the `org_isolation` policies read — and gives an
 *     interactive or batch `$transaction` one setter at its top. `runAsSystem`
 *     sets `app.bypass_rls` instead. An operation that needs an org and has
 *     no context throws before any SQL is sent: a path nobody taught to enter
 *     an org fails loud instead of reading wide.
 *
 * At `single` no `set_config` is ever issued — the extension is behaviour-
 * neutral there apart from the stamped column, and the test proves it through
 * the real Prisma runtime on a recording adapter.
 *
 * **What is wrapped at `multi`, and what is not.** Every op on a tenant-owned
 * model, every raw op, every read on a non-tenant model that reaches a
 * tenant-owned one through a relation (an `include` / `select` / `_count`, a
 * relation filter, a relation `orderBy` — under the policies those joined
 * rows are silently absent without the GUC), and — when a context exists —
 * every write on any model (a nested create under a non-tenant root reaches
 * tenant-owned children and runs inside the root's statement). Other reads
 * on non-tenant models stay unwrapped, and a no-context write on a non-tenant root passes through: that
 * is `POST /orgs/switch` writing `Session.activeOrgId` before any org is
 * chosen, with the policies' `WITH CHECK` as the backstop (§107 planning
 * decision, 2026-09-18).
 *
 * **Transactions.** The per-op wrap issued from inside an interactive
 * transaction runs on a different connection and escapes it (item 1 — a write
 * made that way survived a rollback), so the extension replaces
 * `$transaction`: one setter at the top, and every op bound to that
 * transaction passes through. "Bound" is read off Prisma's undocumented
 * `__internalParams.transaction`, not off an ALS flag alone — an op issued on
 * the root client from inside a callback is not bound, and an ALS-keyed
 * pass-through let it run unwrapped on another connection (it read 0 rows).
 * The replacement delegates to the runtime's own `$transaction` with the
 * **outermost** client as `this`, so a later `$extends` layer's hooks fire on
 * the `tx` client too; closing over an inner layer would make them silently
 * skip inside transactions. `tests/unit/lib/db/tenancy-extension.test.ts`
 * pins the undocumented parameter: a Prisma release that drops it fails there.
 *
 * **Bypass: GUC, not a second role** (item 9, decided here). `runAsSystem`
 * runs on the same client and pool and sets `app.bypass_rls` for its
 * transaction. A second `BYPASSRLS` pool would have to be handed to
 * `runAsSystem`'s callback as a different client — a signature change every
 * consumer and fork would feel — and the GUC arm must exist in the policies
 * regardless, for the migrate role under FORCE (item 7). The exposure is a
 * SQL injection through a raw site, which `tests/unit/db-raw-sql-allowlist.test.ts`
 * keeps deliberate: every `*Unsafe` site today passes values as parameters.
 *
 * The read-side owner predicate is **§115 `f-mt-owner-predicate`**, a later
 * `$extends` layer; nothing here prepares for it beyond delegating
 * `$transaction` correctly.
 *
 * @see .context/tenancy/context.md — the data-layer section
 * @see .context/architecture/multi-tenancy-design.md — Spike register items 1, 2, 8, 9
 * @see scripts/spikes/rls-chokepoint-spike.ts — the measured prototype
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  classifyModels,
  foreignKeyRelations,
  readInlineSchema,
  readRuntimeDataModel,
  type RuntimeDataModel,
  type RuntimeDataModelField,
} from '@/lib/tenancy/classification';
import type { TenantContext } from '@/lib/tenancy/context';

/** What the extension reads from the outside; `lib/db/client.ts` wires the real ones. */
export interface TenancyExtensionOptions {
  /** `TENANCY_MODE=multi`? Read per operation, never cached. */
  isMultiTenant: () => boolean;
  /** The raw tenant context — `null` when nothing entered one. */
  getTenantContext: () => TenantContext | null;
  /** The org a `single` install stamps when nothing entered a context. */
  installOrgId: string;
}

/** Operations that carry create-shaped data at the root. */
const CREATE_OPS: ReadonlySet<string> = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'upsert',
]);

/** Every operation that writes rows; each is walked for nested creates. */
const WRITE_OPS: ReadonlySet<string> = new Set([
  ...CREATE_OPS,
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
]);

const SET_ORG = (orgId: string): Prisma.Sql =>
  Prisma.sql`SELECT set_config('app.current_org', ${orgId}, true)`;
const SET_BYPASS: Prisma.Sql = Prisma.sql`SELECT set_config('app.bypass_rls', 'on', true)`;

/** Marks the async subtree of a scoped transaction: the org its setter named. */
interface TxScope {
  orgId: string | null;
}
const txScope = new AsyncLocalStorage<TxScope>();

/**
 * The typed boundary for Prisma's top-level `$allOperations` hook, which
 * types `args` and `query` as `any`. `__internalParams` is not on Prisma's
 * declared type at all: it is set on every call, and `transaction` is
 * present exactly for an op bound to an interactive (`itx`) or batch
 * transaction — pinned by test, because it is undocumented.
 */
interface OperationParams {
  model?: string;
  operation: string;
  args: unknown;
  query: (args: unknown) => Promise<unknown>;
  __internalParams?: { transaction?: { kind?: string } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What the walks read about the schema, derived once from the base client. */
export interface TenancySchema {
  rdm: RuntimeDataModel;
  /** Model names whose rows belong to one org. */
  tenantOwned: ReadonlySet<string>;
  /** Per model, the relation fields whose foreign key lives on that model. */
  fkRelations: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Derive {@link TenancySchema} from a generated client. */
export function readTenancySchema(client: unknown): TenancySchema {
  const rdm = readRuntimeDataModel(client);
  return {
    rdm,
    tenantOwned: new Set(classifyModels(rdm).tenantOwned.map((m) => m.model)),
    fkRelations: foreignKeyRelations(readInlineSchema(client)),
  };
}

/**
 * Stamp the org on a create row in the form the row already uses. Prisma's
 * create input is checked XOR unchecked: a row naming a relation whose
 * foreign key lives on this model (`creator: { connect }`) is the checked
 * form and cannot carry a scalar FK, so it gets `org: { connect }`; any
 * other row gets the scalar `orgId`.
 */
function stampOrg(
  schema: TenancySchema,
  model: string,
  row: Record<string, unknown>,
  orgId: string
): void {
  const fkFields = schema.fkRelations.get(model);
  // A key set to `undefined` is one Prisma strips, so it decides nothing:
  // `profile: profileId ? { connect } : undefined` is the unchecked form.
  const checkedForm =
    fkFields !== undefined &&
    Object.entries(row).some(([k, v]) => v !== undefined && fkFields.has(k));
  if (checkedForm) row.org = { connect: { id: orgId } };
  else row.orgId = orgId;
}

/**
 * Walk a write payload, stamping the org on create-shaped nodes of
 * tenant-owned models and descending everything else for the nested creates
 * it may carry. `stamp` is true only for create data: a create / createMany
 * payload, an upsert's `create` branch, a connectOrCreate's `create`.
 */
export function injectOrgId(
  schema: TenancySchema,
  model: string,
  data: unknown,
  orgId: string,
  stamp: boolean
): unknown {
  if (Array.isArray(data)) {
    return data.map((d: unknown) => injectOrgId(schema, model, d, orgId, stamp));
  }
  if (!isRecord(data)) return data;
  const row: Record<string, unknown> = { ...data };
  if (stamp && schema.tenantOwned.has(model) && row.orgId === undefined && row.org === undefined) {
    stampOrg(schema, model, row, orgId);
  }
  for (const field of schema.rdm.models[model]?.fields ?? []) {
    if (field.kind !== 'object') continue;
    const nested = row[field.name];
    if (!isRecord(nested)) continue;
    row[field.name] = walkRelation(schema, field, nested, orgId);
  }
  return row;
}

/**
 * The verbs a relation argument may carry, and how each is walked. A create
 * reached through the org relation itself (`org.update({ data: { aiAgents:
 * { create } } })`) is descended but not stamped: the nesting supplies the
 * org, and Prisma's `...WithoutOrgInput` refuses an explicit `orgId` there.
 */
function walkRelation(
  schema: TenancySchema,
  field: RuntimeDataModelField,
  relation: Record<string, unknown>,
  orgId: string
): Record<string, unknown> {
  const target = field.type;
  const backRelation = schema.rdm.models[target]?.fields.find(
    (f) => f.kind === 'object' && f.relationName === field.relationName
  );
  const viaOrg = backRelation?.name === 'org' && backRelation.type === 'Org';
  const stampCreates = !viaOrg;
  const out: Record<string, unknown> = { ...relation };
  const each = (value: unknown, fn: (x: Record<string, unknown>) => unknown): unknown =>
    Array.isArray(value)
      ? value.map((x: unknown) => (isRecord(x) ? fn(x) : x))
      : isRecord(value)
        ? fn(value)
        : value;

  if (out.create !== undefined) {
    out.create = injectOrgId(schema, target, out.create, orgId, stampCreates);
  }
  if (isRecord(out.createMany)) {
    out.createMany = {
      ...out.createMany,
      data: injectOrgId(schema, target, out.createMany.data, orgId, stampCreates),
    };
  }
  if (out.connectOrCreate !== undefined) {
    out.connectOrCreate = each(out.connectOrCreate, (x) => ({
      ...x,
      create: injectOrgId(schema, target, x.create, orgId, stampCreates),
    }));
  }
  if (out.update !== undefined) {
    out.update = each(out.update, (x) => {
      // To-one shorthand: `relation: { update: { ...fields } }` has no
      // `data` / `where` wrapper — the object IS the update payload.
      if (x.data === undefined && x.where === undefined) {
        return injectOrgId(schema, target, x, orgId, false);
      }
      return { ...x, data: injectOrgId(schema, target, x.data, orgId, false) };
    });
  }
  if (out.upsert !== undefined) {
    out.upsert = each(out.upsert, (x) => ({
      ...x,
      create: injectOrgId(schema, target, x.create, orgId, stampCreates),
      update: injectOrgId(schema, target, x.update, orgId, false),
    }));
  }
  return out;
}

/** Stamp the root payload of a write, whichever shape the operation carries. */
function injectIntoArgs(
  schema: TenancySchema,
  model: string,
  operation: string,
  args: unknown,
  orgId: string
): unknown {
  if (!isRecord(args)) return args;
  if (operation === 'upsert') {
    return {
      ...args,
      create: injectOrgId(schema, model, args.create, orgId, true),
      update: injectOrgId(schema, model, args.update, orgId, false),
    };
  }
  if (args.data === undefined) return args;
  return {
    ...args,
    data: injectOrgId(schema, model, args.data, orgId, CREATE_OPS.has(operation)),
  };
}

/** Boolean combinators a `where` nests relation filters under. */
const WHERE_COMBINATORS: ReadonlySet<string> = new Set(['AND', 'OR', 'NOT']);
/** The wrappers a relation filter takes: list relations and to-one ones. */
const RELATION_FILTERS: ReadonlySet<string> = new Set(['some', 'every', 'none', 'is', 'isNot']);

/**
 * Does a read on `model` reach a tenant-owned table through a relation —
 * an `include` / `select` (a `_count` too), a relation filter in `where`, or
 * a relation `orderBy`, at any depth through non-tenant relations? Such a
 * read on a non-tenant root must be scoped like a tenant-owned one: under
 * the policies its joined rows are simply absent without the GUC, so
 * `aiCapability.findMany({ include: { agents } })` would answer "no agents"
 * for every org rather than fail. The descent stops at a tenant-owned
 * relation (the answer is yes) and at scalars.
 */
export function reachesTenantRelation(
  schema: TenancySchema,
  model: string,
  args: unknown
): boolean {
  if (!isRecord(args)) return false;
  return (
    selectionReaches(schema, model, args.include) ||
    selectionReaches(schema, model, args.select) ||
    whereReaches(schema, model, args.where) ||
    orderByReaches(schema, model, args.orderBy)
  );
}

function relationsOf(schema: TenancySchema, model: string): Map<string, string> {
  const relations = new Map<string, string>();
  for (const f of schema.rdm.models[model]?.fields ?? []) {
    if (f.kind === 'object') relations.set(f.name, f.type);
  }
  return relations;
}

function hasTenantRelation(schema: TenancySchema, model: string): boolean {
  for (const target of relationsOf(schema, model).values()) {
    if (schema.tenantOwned.has(target)) return true;
  }
  return false;
}

/** `include` / `select`: a relation key, `_count`, or a nested selection on a non-tenant relation. */
function selectionReaches(schema: TenancySchema, model: string, node: unknown): boolean {
  if (!isRecord(node)) return false;
  const relations = relationsOf(schema, model);
  for (const [key, value] of Object.entries(node)) {
    if (key === '_count') {
      if (value === true && hasTenantRelation(schema, model)) return true;
      if (isRecord(value) && selectionReaches(schema, model, value.select)) return true;
      continue;
    }
    const target = relations.get(key);
    if (target === undefined || value === false) continue;
    if (schema.tenantOwned.has(target)) return true;
    if (reachesTenantRelation(schema, target, value)) return true;
  }
  return false;
}

/** `where`: a relation filter, through combinators and non-tenant relations. */
function whereReaches(schema: TenancySchema, model: string, node: unknown): boolean {
  if (Array.isArray(node)) return node.some((n: unknown) => whereReaches(schema, model, n));
  if (!isRecord(node)) return false;
  const relations = relationsOf(schema, model);
  for (const [key, value] of Object.entries(node)) {
    if (WHERE_COMBINATORS.has(key)) {
      if (whereReaches(schema, model, value)) return true;
      continue;
    }
    const target = relations.get(key);
    if (target === undefined) continue;
    if (schema.tenantOwned.has(target)) return true;
    if (!isRecord(value)) continue;
    // `{ some: {…} }` on a list, `{ is: {…} }` or the bare where on a to-one.
    const inner = Object.keys(value).some((k) => RELATION_FILTERS.has(k))
      ? Object.entries(value)
          .filter(([k]) => RELATION_FILTERS.has(k))
          .map(([, v]) => v)
      : [value];
    if (inner.some((w) => whereReaches(schema, target, w))) return true;
  }
  return false;
}

/** `orderBy`: a relation key (`{ agents: { _count } }` or a to-one's field), through non-tenant relations. */
function orderByReaches(schema: TenancySchema, model: string, node: unknown): boolean {
  if (Array.isArray(node)) return node.some((n: unknown) => orderByReaches(schema, model, n));
  if (!isRecord(node)) return false;
  const relations = relationsOf(schema, model);
  for (const [key, value] of Object.entries(node)) {
    const target = relations.get(key);
    if (target === undefined) continue;
    if (schema.tenantOwned.has(target)) return true;
    if (orderByReaches(schema, target, value)) return true;
  }
  return false;
}

type InteractiveFn = (tx: Prisma.TransactionClient) => Promise<unknown>;
type TxArg = InteractiveFn | Promise<unknown>[];
type TxOptions = {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
};
type RuntimeTx = (this: unknown, arg: TxArg, options?: TxOptions) => Promise<unknown>;

function noContextError(what: string): Error {
  return new Error(
    `No tenant context for ${what} at TENANCY_MODE=multi: this call stack was not entered for an org. ` +
      'Every request and job must run inside runAsOrg / runAsSystem / forEachOrg (see .context/tenancy/context.md).'
  );
}

/**
 * Apply the tenancy chokepoint to a Prisma client. Returns the extended
 * client `lib/db/client.ts` exports; the four callers typed against
 * `Prisma.TransactionClient` compile against it unchanged (item 8).
 */
export function withTenancy(base: PrismaClient, options: TenancyExtensionOptions): TenancyClient {
  const schema = readTenancySchema(base);

  // The runtime's own `$transaction`, read by property get (the client is a
  // Proxy whose descriptor trap does not list it) and deliberately unbound —
  // it is re-bound to the outermost client on every call.
  const runtimeTx = Reflect.get(base, '$transaction') as RuntimeTx;

  /** The context this operation runs for: at `single`, the install org when none was entered. */
  function resolveContext(multi: boolean): TenantContext | null {
    const entered = options.getTenantContext();
    if (entered || multi) return entered;
    return { orgId: options.installOrgId, source: 'implicit' };
  }

  async function handleOperation(params: OperationParams): Promise<unknown> {
    const { model, operation, query } = params;
    const multi = options.isMultiTenant();
    const ctx = resolveContext(multi);
    const isWrite = model !== undefined && WRITE_OPS.has(operation);

    let args = params.args;
    if (isWrite && ctx?.orgId) {
      args = injectIntoArgs(schema, model, operation, args, ctx.orgId);
    }
    if (!multi) return query(args);

    const isRaw = model === undefined;
    const isTenantModel = model !== undefined && schema.tenantOwned.has(model);
    const needsScope =
      isTenantModel ||
      isRaw ||
      (isWrite && ctx !== null) ||
      (model !== undefined && reachesTenantRelation(schema, model, args));
    if (!needsScope) return query(args);
    if (!ctx) throw noContextError(`${model ?? 'raw SQL'}.${operation}`);

    if (params.__internalParams?.transaction !== undefined) {
      // Bound to a transaction this extension opened: its setter already ran.
      // A transaction opened for one org must not carry an op for another
      // (a `runAsOrg` nested inside the callback), and an op bound to a
      // transaction whose scope is gone has no setter to rely on.
      const scope = txScope.getStore();
      if (!scope) {
        throw new Error(
          `${model ?? 'raw SQL'}.${operation} is bound to a transaction outside the scope that opened it`
        );
      }
      if (scope.orgId !== ctx.orgId) {
        throw new Error(
          `${model ?? 'raw SQL'}.${operation} runs for org ${ctx.orgId ?? 'system'} inside a transaction opened for ${scope.orgId ?? 'system'}`
        );
      }
      return query(args);
    }

    const setter = ctx.orgId === null ? SET_BYPASS : SET_ORG(ctx.orgId);
    // The base client's raw call so the setter itself is not wrapped again.
    const result = await runtimeTx.call(base, [base.$executeRaw(setter), query(args)]);
    return (result as unknown[])[1];
  }

  const withHooks = base.$extends({
    name: 'sunrise-tenancy',
    query: {
      $allOperations: (params) => handleOperation(params),
    },
  });

  const scopedTransaction = function (this: unknown, arg: TxArg, txOptions?: TxOptions) {
    const outermost: unknown = Prisma.getExtensionContext(this);
    const delegate = (a: TxArg, o?: TxOptions) => runtimeTx.call(outermost, a, o);
    const multi = options.isMultiTenant();
    const ctx = resolveContext(multi);
    // At `single`, and with no context at `multi`, the transaction is the
    // runtime's own; in the latter case each op inside still answers to the
    // per-op rule, so a tenant-owned or raw op throws and a system-model
    // write (the switch route) passes.
    if (!multi || !ctx) return delegate(arg, txOptions);

    const setter = ctx.orgId === null ? SET_BYPASS : SET_ORG(ctx.orgId);
    const scope: TxScope = { orgId: ctx.orgId };
    if (typeof arg !== 'function') {
      // Batch: the setter leads, and the caller's results are sliced back.
      const outer = outermost as Pick<PrismaClient, '$executeRaw'>;
      return txScope.run(scope, () =>
        delegate([outer.$executeRaw(setter), ...arg], txOptions).then((r) =>
          (r as unknown[]).slice(1)
        )
      );
    }
    return delegate(
      (tx: Prisma.TransactionClient) =>
        txScope.run(scope, async () => {
          // Issued inside the scope: bound to the transaction, so it passes
          // through the per-op rule rather than being wrapped onto another
          // connection.
          await tx.$executeRaw(setter);
          return arg(tx);
        }),
      txOptions
    );
  } as PrismaClient['$transaction'];

  // The extended client is a `PrismaClient` at runtime less `$on`; its
  // `$extends` result type is not structurally assignable to the class (the
  // delegates' generics differ in shape), so the one assertion is here.
  const extended: unknown = withHooks.$extends({ client: { $transaction: scopedTransaction } });
  return extended as TenancyClient;
}

/**
 * The client `lib/db/client.ts` exports: a `PrismaClient` less `$on`, the one
 * member Prisma drops from an extended client (event-emitter logging belongs
 * on the base client, and nothing in Sunrise uses it). Named from the base
 * type rather than from `$extends`'s own result type on purpose: typing the
 * exported client as the extended type made `tsc` exhaust a 4 GB heap after
 * 150 s across this tree (baseline 7 s) — every `prisma.model.op` call site
 * re-instantiates the dynamic extension types. Every call site, `Pick` and
 * `typeof prisma.x.y` a caller writes today is unchanged.
 */
export type TenancyClient = Omit<PrismaClient, '$on'>;
