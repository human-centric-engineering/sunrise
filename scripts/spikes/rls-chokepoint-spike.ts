/**
 * RLS chokepoint spike (§107 t-704) — throwaway.
 *
 * `rls-isolation-spike.mjs` proved the pooled `SET`-vs-`SET LOCAL` leak and the
 * `NULLIF` policy form with bare `pg`. This one asks the questions 3.2 / 3.3
 * cannot be sized without, using the REAL generated Prisma client against a
 * migrated database:
 *
 *   Q1  extension × interactive / batch transactions
 *   Q2  raw SQL through the extension
 *   Q3  nested creates and `orgId`
 *   Q4  per-op cost, direct vs pooled; the leak re-test through a pooler
 *   Q5  dormant policies are inert
 *   Q6  types (`Prisma.TransactionClient`) and layered `$extends`
 *   Q7  FORCE RLS vs the migrate role; the bypass GUC
 *   Q8  deriving the tenant-owned set from `_runtimeDataModel`
 *
 * It creates a login role, dormant policies on the four `orgId` tables that
 * exist today, a handful of `spike-*` rows, and removes all of it on every
 * path. Run it against a THROWAWAY database that has `prisma migrate deploy`
 * applied — never the dev or production DB.
 *
 *   # local (see the docker commands in the design doc's spike register)
 *   SPIKE_ADMIN_URL=postgresql://postgres:postgres@localhost:5433/postgres \
 *   SPIKE_POOLED_URL=postgresql://postgres:postgres@localhost:6433/postgres \
 *   npx tsx scripts/spikes/rls-chokepoint-spike.ts
 *
 *   # Neon preview branch (direct URL for admin work, -pooler URL for the app)
 *   SPIKE_ADMIN_URL=<direct> SPIKE_POOLED_URL=<pooled> npx tsx scripts/spikes/rls-chokepoint-spike.ts
 *
 * Findings are written to the design doc, not read from this output later.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const ADMIN_URL = process.env.SPIKE_ADMIN_URL;
const POOLED_URL = process.env.SPIKE_POOLED_URL; // optional
if (!ADMIN_URL) {
  console.error('SPIKE_ADMIN_URL is required (a privileged DSN to a THROWAWAY migrated database).');
  process.exit(1);
}

// Per-run role names: a pooler keeps server connections authenticated as a role
// by OID, so dropping and recreating `spike_app` between runs left PgBouncer
// handing out sessions for a role whose grants no longer existed.
const RUN_ID = randomBytes(3).toString('hex');
const APP_ROLE = `spike_app_${RUN_ID}`;
const OWNER_ROLE = `spike_owner_${RUN_ID}`;
const APP_PW = `Sp1ke_${randomBytes(12).toString('hex')}`;
const INSTALL_ORG = 'install'; // lib/tenancy/constants.ts INSTALL_ORG_ID
const ORG_B = 'spike_org_b';
const N_OPS = Number(process.env.SPIKE_N ?? 100);

function withCreds(url: string, user: string, pw: string): string {
  const u = new URL(url);
  u.username = user;
  u.password = pw;
  return u.toString();
}

const APP_URL = withCreds(ADMIN_URL, APP_ROLE, APP_PW);
const APP_POOLED_URL = POOLED_URL ? withCreds(POOLED_URL, APP_ROLE, APP_PW) : undefined;

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const findings: string[] = [];
function section(title: string) {
  console.log(`\n=== ${title} ===`);
}
function report(ok: boolean | 'info', what: string, detail?: unknown) {
  const tag = ok === 'info' ? 'INFO' : ok ? 'PASS' : 'FAIL';
  const line = `${tag}  ${what}${detail === undefined ? '' : ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))}`;
  console.log('  ' + line);
  findings.push(line);
}
function errCode(e: unknown): string {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    // An RLS violation arrives as P2039 with the Postgres message inside meta.driverAdapterError.
    const meta = e.meta as
      { code?: string; message?: string; driverAdapterError?: { message?: string } } | undefined;
    const inner = meta?.driverAdapterError?.message ?? meta?.message ?? e.message;
    return `${e.code}${meta?.code ? '/' + meta.code : ''}: ${inner.split('\n')[0]}`;
  }
  return e instanceof Error ? e.message.split('\n')[0] : String(e);
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

type QueryEvent = { query: string; duration: number };

function makeBase(url: string, max = 4) {
  const pool = new Pool({ connectionString: url, max, connectionTimeoutMillis: 15_000 });
  const adapter = new PrismaPg(pool);
  const client = new PrismaClient({
    adapter,
    log: [{ emit: 'event', level: 'query' }],
  });
  const events: QueryEvent[] = [];
  client.$on('query', (e) => events.push({ query: e.query, duration: e.duration }));
  return { client, pool, events };
}

// ---------------------------------------------------------------------------
// Q8: derive the tenant-owned set from the generated client's runtime data model
// ---------------------------------------------------------------------------

interface RdmField {
  name: string;
  kind: 'scalar' | 'object' | 'enum' | 'unsupported';
  type: string;
  relationName?: string;
}
interface RdmModel {
  fields: RdmField[];
  dbName: string | null;
}
interface Rdm {
  models: Record<string, RdmModel>;
}

function runtimeDataModel(client: PrismaClient): Rdm {
  const rdm = (client as unknown as { _runtimeDataModel?: Rdm })._runtimeDataModel;
  if (!rdm) throw new Error('client._runtimeDataModel is not exposed on this Prisma version');
  return rdm;
}

/** Model name → table name for every model carrying an `orgId` scalar (minus a system allowlist). */
function deriveTenantOwned(rdm: Rdm, systemAllowlist: ReadonlySet<string>) {
  const out = new Map<string, string>();
  for (const [name, m] of Object.entries(rdm.models)) {
    if (systemAllowlist.has(name)) continue;
    if (m.fields.some((f) => f.name === 'orgId' && f.kind === 'scalar')) {
      out.set(name, m.dbName ?? name);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The prototype extension (what 3.2 would ship, minus the polish)
// ---------------------------------------------------------------------------

interface Ctx {
  orgId: string | null; // null = system scope (bypass)
  inTx?: boolean;
}
const als = new AsyncLocalStorage<Ctx>();
const runAsOrg = <T>(orgId: string, fn: () => Promise<T>) => als.run({ orgId }, fn);

const SET_ORG = (orgId: string) => Prisma.sql`SELECT set_config('app.current_org', ${orgId}, true)`;
const SET_BYPASS = Prisma.sql`SELECT set_config('app.bypass_rls', 'on', true)`;

/** Recursively inject `orgId` on every nested create whose target model is tenant-owned. */
function injectOrgId(
  rdm: Rdm,
  tenantOwned: ReadonlyMap<string, string>,
  model: string,
  data: unknown,
  orgId: string,
  stats: { injected: string[] }
): unknown {
  if (Array.isArray(data)) {
    return data.map((d) => injectOrgId(rdm, tenantOwned, model, d, orgId, stats));
  }
  if (!data || typeof data !== 'object') return data;
  const row = { ...(data as Record<string, unknown>) };
  if (tenantOwned.has(model) && row.orgId === undefined && row.org === undefined) {
    row.orgId = orgId;
    stats.injected.push(model);
  }
  for (const f of rdm.models[model]?.fields ?? []) {
    if (f.kind !== 'object' || row[f.name] === undefined) continue;
    const nested = row[f.name] as Record<string, unknown>;
    if (!nested || typeof nested !== 'object') continue;
    const copy = { ...nested };
    for (const verb of ['create', 'createMany', 'connectOrCreate']) {
      if (copy[verb] === undefined) continue;
      if (verb === 'createMany') {
        const cm = copy[verb] as { data?: unknown };
        copy[verb] = { ...cm, data: injectOrgId(rdm, tenantOwned, f.type, cm.data, orgId, stats) };
      } else if (verb === 'connectOrCreate') {
        const coc = copy[verb];
        const one = (x: Record<string, unknown>) => ({
          ...x,
          create: injectOrgId(rdm, tenantOwned, f.type, x.create, orgId, stats),
        });
        copy[verb] = Array.isArray(coc)
          ? coc.map((x) => one(x as Record<string, unknown>))
          : one(coc as Record<string, unknown>);
      } else {
        copy[verb] = injectOrgId(rdm, tenantOwned, f.type, copy[verb], orgId, stats);
      }
    }
    row[f.name] = copy;
  }
  return row;
}

const CREATE_OPS = new Set(['create', 'createMany', 'createManyAndReturn', 'upsert']);
const WRITE_OPS = new Set([
  ...CREATE_OPS,
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
]);

function tenancyExtension(
  base: PrismaClient,
  opts: { multi: boolean; inject: boolean; tenantOwned: ReadonlyMap<string, string> }
) {
  const rdm = runtimeDataModel(base);
  const seen: Array<{ model?: string; operation: string; wrapped: boolean }> = [];
  const injectStats = { injected: [] as string[] };

  const ext = base.$extends({
    name: 'tenancy-spike',
    query: {
      // Top-level $allOperations: fires for every model op AND the raw methods.
      // Q6c finding: Prisma types the TOP-LEVEL $allOperations hook's `args` and
      // `query` as `any` (the per-model hooks are typed). 3.2 owes a typed
      // boundary here; the spike fences the hook instead.
      /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/consistent-type-assertions*/
      async $allOperations({ model, operation, args, query }) {
        const ctx = als.getStore();
        const isTenantModel = model !== undefined && opts.tenantOwned.has(model);
        const isRaw = model === undefined;

        // Write-side injection (both modes).
        let nextArgs = args;
        // The walk runs on EVERY create, whatever the root model: AiAgent is not
        // tenant-owned today but its nested embedTokens are (Q3b).
        if (opts.inject && model !== undefined && CREATE_OPS.has(operation) && ctx?.orgId) {
          const a = args as { data?: unknown; create?: unknown };
          if (operation === 'upsert') {
            nextArgs = {
              ...a,
              create: injectOrgId(rdm, opts.tenantOwned, model, a.create, ctx.orgId, injectStats),
            } as typeof args;
          } else {
            nextArgs = {
              ...a,
              data: injectOrgId(rdm, opts.tenantOwned, model, a.data, ctx.orgId, injectStats),
            } as typeof args;
          }
        }

        // Scoping (multi only). Wrapped: every op on a tenant-owned model, every
        // raw op, and — when a context exists — every WRITE on any model, because
        // a nested write under a non-tenant root can reach tenant-owned children
        // (Q3b: AiAgent.create → embedTokens). Unwrapped: reads on non-tenant
        // models, and a no-context write on a non-tenant root (the switch route's
        // session.update) — there WITH CHECK is the backstop for any nested child.
        const isWrite = WRITE_OPS.has(operation);
        const mustHaveCtx = isTenantModel || isRaw;
        if (!opts.multi || (!mustHaveCtx && !(isWrite && ctx))) {
          seen.push({ model, operation, wrapped: false });
          return query(nextArgs);
        }
        if (!ctx) {
          throw new Error(`No tenant context for ${model ?? 'raw'}.${operation} at multi`);
        }
        if (ctx.inTx) {
          // One set_config was issued at the top of the interactive transaction.
          seen.push({ model, operation, wrapped: false });
          return query(nextArgs);
        }
        seen.push({ model, operation, wrapped: true });
        const setter = ctx.orgId === null ? SET_BYPASS : SET_ORG(ctx.orgId);
        const [, result] = await base.$transaction([base.$executeRaw(setter), query(nextArgs)]);
        return result;
      },
      /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/consistent-type-assertions*/
    },
  });

  // Interactive-transaction override as a `client` component (Prisma lets an
  // extension redefine `$transaction` — Q1b). It closes over `ext`, the layer
  // that carries the query hooks, so the `tx` handed to the callback still
  // injects. One set_config at the top, then the callback runs with `inTx`
  // set so per-op wrapping is skipped — the setter itself is issued INSIDE
  // that scope, or it would be wrapped onto a different connection (Q1a).
  type TxFn = PrismaClient['$transaction'];
  type InteractiveFn = (tx: Prisma.TransactionClient) => Promise<unknown>;
  type TxOptions = {
    maxWait?: number;
    timeout?: number;
    isolationLevel?: Prisma.TransactionIsolationLevel;
  };
  const originalTx = ext.$transaction.bind(ext) as unknown as (
    arg: InteractiveFn | Prisma.PrismaPromise<unknown>[],
    opts?: TxOptions
  ) => Promise<unknown>;
  const patchedTx = ((arg: InteractiveFn | Prisma.PrismaPromise<unknown>[], txOpts?: TxOptions) => {
    const ctx = als.getStore();
    if (!opts.multi) return originalTx(arg, txOpts);
    if (!ctx) throw new Error('No tenant context for $transaction at multi');
    const setter = ctx.orgId === null ? SET_BYPASS : SET_ORG(ctx.orgId);
    if (typeof arg !== 'function') {
      // Batch: prepend the setter; the caller's results are sliced back into place.
      return als.run({ ...ctx, inTx: true }, () =>
        originalTx([ext.$executeRaw(setter), ...arg], txOpts).then((r) => (r as unknown[]).slice(1))
      );
    }
    return originalTx(
      (tx: Prisma.TransactionClient) =>
        als.run({ ...ctx, inTx: true }, async () => {
          await tx.$executeRaw(setter);
          return arg(tx);
        }),
      txOpts
    );
  }) as unknown as TxFn;
  const patched = ext.$extends({ client: { $transaction: patchedTx } });

  return { ext, patched, seen, injectStats };
}

// ---------------------------------------------------------------------------
// Q6 (types): these must compile against the extended client.
// ---------------------------------------------------------------------------

async function useTx(tx: Prisma.TransactionClient): Promise<number> {
  return tx.aiAgentEmbedToken.count();
}
function typeChecks(extended: { $transaction: PrismaClient['$transaction'] }) {
  // A caller typed against Prisma.TransactionClient receiving the extended tx.
  return extended.$transaction(async (tx) => useTx(tx));
}

// ---------------------------------------------------------------------------
// SQL helpers (admin)
// ---------------------------------------------------------------------------

async function q<T = Record<string, unknown>>(
  pool: Pool,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const r = await pool.query(sql, params);
  return r.rows as T[];
}

const POLICY = (table: string) => `
  CREATE POLICY org_isolation ON "${table}"
    USING (
      current_setting('app.bypass_rls', true) = 'on'
      OR "orgId" = NULLIF(current_setting('app.current_org', true), '')
    )
    WITH CHECK (
      current_setting('app.bypass_rls', true) = 'on'
      OR "orgId" = NULLIF(current_setting('app.current_org', true), '')
    )`;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const admin = new Pool({ connectionString: ADMIN_URL, max: 3, connectionTimeoutMillis: 15_000 });
  const adminPrisma = makeBase(ADMIN_URL!, 2);
  const rdm = runtimeDataModel(adminPrisma.client);

  // ---- Q8 -----------------------------------------------------------------
  section('Q8 tenant-owned set from _runtimeDataModel');
  const SYSTEM = new Set(['Org', 'OrgMembership', 'User', 'Session', 'Account', 'Verification']);
  const tenantOwned = deriveTenantOwned(rdm, SYSTEM);
  report('info', `models in runtime data model: ${Object.keys(rdm.models).length}`);
  report(
    tenantOwned.size === 4,
    'derived tenant-owned set (orgId minus system allowlist) is the four credential models',
    Object.fromEntries(tenantOwned)
  );
  report(
    Object.values(rdm.models).every((m) => typeof m.dbName === 'string' || m.dbName === null),
    'dbName (table name) is available per model — policies/probes/enable can derive table names'
  );
  const tables = [...tenantOwned.values()];

  const cleanup: Array<() => Promise<void>> = [];
  const runCleanup = async () => {
    for (const fn of cleanup.reverse()) {
      try {
        await fn();
      } catch (e) {
        console.error('  cleanup step failed:', errCode(e));
      }
    }
    cleanup.length = 0;
  };

  let appBase: ReturnType<typeof makeBase> | undefined;
  let appPooled: ReturnType<typeof makeBase> | undefined;
  let ownerPool: Pool | undefined;

  try {
    // ---- setup ------------------------------------------------------------
    section('setup');
    const who = await q<{ u: string; su: boolean; byp: boolean; v: string }>(
      admin,
      `SELECT current_user u, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) su,
              (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) byp, version() v`
    );
    report(
      'info',
      `admin role ${who[0].u}: superuser=${who[0].su} bypassrls=${who[0].byp} · ${who[0].v.slice(0, 24)}`
    );

    await q(admin, `DROP ROLE IF EXISTS ${APP_ROLE}`).catch(() => undefined);
    await q(admin, `CREATE ROLE ${APP_ROLE} LOGIN NOBYPASSRLS PASSWORD '${APP_PW}'`);
    // Neon's neondb_owner is refused `DROP OWNED BY` ("permission denied to drop
    // objects"), so the grants are revoked explicitly before the role goes —
    // the shape t-707's role script needs too.
    const dropRole = async (role: string) => {
      await q(admin, `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`).catch(
        () => undefined
      );
      await q(admin, `REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${role}`).catch(
        () => undefined
      );
      await q(admin, `REVOKE ALL ON SCHEMA public FROM ${role}`).catch(() => undefined);
      await q(admin, `DROP ROLE IF EXISTS ${role}`);
    };
    cleanup.push(() => dropRole(APP_ROLE));
    await q(admin, `GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await q(
      admin,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`
    );
    await q(admin, `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`);

    await q(
      admin,
      `INSERT INTO org (id, slug, name, status, "createdAt", "updatedAt")
                    VALUES ($1, $1, 'Spike org B', 'ACTIVE', now(), now()) ON CONFLICT (id) DO NOTHING`,
      [ORG_B]
    );
    cleanup.push(async () => {
      await q(admin, `DELETE FROM org WHERE id = $1`, [ORG_B]);
    });

    // A spike agent, parent for embed tokens (AiAgent has no orgId yet — it is the
    // stand-in for "a parent whose child is tenant-owned").
    const agent = await adminPrisma.client.aiAgent.create({
      data: {
        name: 'spike-agent',
        slug: `spike-agent-${randomBytes(3).toString('hex')}`,
        description: 'rls chokepoint spike',
        systemInstructions: 'n/a',
        model: 'n/a',
        provider: 'n/a',
      },
      select: { id: true },
    });
    cleanup.push(async () => {
      await adminPrisma.client.aiAgent.deleteMany({ where: { name: 'spike-agent' } });
    });

    // Seed rows: 3 embed tokens for the install org (A), 2 for B.
    const seedRows = [
      ...[1, 2, 3].map((i) => ({ agentId: agent.id, label: `spike-A-${i}`, orgId: INSTALL_ORG })),
      ...[1, 2].map((i) => ({ agentId: agent.id, label: `spike-B-${i}`, orgId: ORG_B })),
    ];
    await adminPrisma.client.aiAgentEmbedToken.createMany({ data: seedRows });
    cleanup.push(async () => {
      await adminPrisma.client.aiAgentEmbedToken.deleteMany({
        where: { label: { startsWith: 'spike-' } },
      });
    });
    const spikeWhere = { label: { startsWith: 'spike-' } };

    // Dormant policies on the four tables.
    for (const t of tables) {
      await q(admin, `DROP POLICY IF EXISTS org_isolation ON "${t}"`);
      await q(admin, POLICY(t));
    }
    cleanup.push(async () => {
      for (const t of tables) {
        await q(admin, `ALTER TABLE "${t}" NO FORCE ROW LEVEL SECURITY`).catch(() => undefined);
        await q(admin, `ALTER TABLE "${t}" DISABLE ROW LEVEL SECURITY`).catch(() => undefined);
        await q(admin, `DROP POLICY IF EXISTS org_isolation ON "${t}"`);
      }
    });
    report('info', `dormant org_isolation policies created on ${tables.join(', ')}`);

    appBase = makeBase(APP_URL, 4);
    if (APP_POOLED_URL) appPooled = makeBase(APP_POOLED_URL, 4);

    // ---- Q5 dormant policies ------------------------------------------------
    section('Q5 dormant policies are inert until ENABLE');
    const plain = appBase.client;
    const dormantCount = await plain.aiAgentEmbedToken.count({ where: spikeWhere });
    report(dormantCount === 5, 'app role with policy but NO ENABLE sees every row (policy inert)', {
      rows: dormantCount,
    });
    const dormantInsert = await plain.aiAgentEmbedToken
      .create({
        data: { agentId: agent.id, label: 'spike-dormant-null-org' },
        select: { orgId: true },
      })
      .then((r) => ({ ok: true, orgId: r.orgId }))
      .catch((e) => ({ ok: false, err: errCode(e) }));
    report(
      'ok' in dormantInsert && dormantInsert.ok,
      'app role can insert a NULL-org row while dormant (single-tenant behaviour unchanged)',
      dormantInsert
    );

    // Q5b: migrate diff with policies present — does Prisma want to drop them?
    try {
      const cfgUrl = ADMIN_URL!;
      const out = execFileSync(
        'npx',
        [
          'prisma',
          'migrate',
          'diff',
          '--from-config-datasource',
          '--to-schema',
          'prisma/schema',
          '--script',
        ],
        {
          env: {
            ...process.env,
            DATABASE_URL: cfgUrl,
            PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK: 'true',
          },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      const mentionsPolicy = /POLICY|ROW LEVEL/i.test(out);
      const empty = /This is an empty migration/i.test(out) || out.trim().length === 0;
      report(
        !mentionsPolicy,
        'prisma migrate diff (db → schema) does NOT emit DROP POLICY for the dormant policies',
        {
          emptyMigration: empty,
          firstLines: out.trim().split('\n').slice(0, 4),
        }
      );
    } catch (e) {
      report('info', 'prisma migrate diff could not run here', errCode(e));
    }

    // Enable + force on all four.
    for (const t of tables) {
      await q(admin, `ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
      await q(admin, `ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
    }
    const enabledCount = await plain.aiAgentEmbedToken.count({ where: spikeWhere });
    report(
      enabledCount === 0,
      'after ENABLE, an unscoped query as the app role sees nothing (default deny)',
      { rows: enabledCount }
    );
    // Idempotence of enable.
    for (const t of tables) await q(admin, `ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
    report(true, 'ENABLE ROW LEVEL SECURITY twice is a no-op (idempotent)');

    // ---- Q7 FORCE, the migrate role, the bypass GUC --------------------------
    section('Q7 FORCE RLS × migrate role × bypass GUC');
    const adminUpd = await q<{ n: string }>(
      admin,
      `WITH u AS (UPDATE ai_agent_embed_token SET "updatedAt" = now() WHERE label LIKE 'spike-%' RETURNING 1)
       SELECT count(*)::text n FROM u`
    );
    report(
      Number(adminUpd[0].n) === 6,
      `admin role (superuser=${who[0].su}, bypassrls=${who[0].byp}) UPDATE with no GUC touches every row — migrations are safe under FORCE for THIS role`,
      { updated: Number(adminUpd[0].n) }
    );
    const bypassRows = await appBase.client.$transaction([
      appBase.client.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`,
      appBase.client.aiAgentEmbedToken.count({ where: spikeWhere }),
    ]);
    report(
      bypassRows[1] === 6,
      'app role with app.bypass_rls=on (SET LOCAL) sees every row — runAsSystem maps to this',
      { rows: bypassRows[1] }
    );

    // A NOBYPASSRLS non-superuser OWNER under FORCE: the trap for a migrate role without bypass.
    await q(admin, `DROP ROLE IF EXISTS ${OWNER_ROLE}`).catch(() => undefined);
    await q(admin, `CREATE ROLE ${OWNER_ROLE} LOGIN NOBYPASSRLS PASSWORD '${APP_PW}'`);
    await q(admin, `GRANT USAGE, CREATE ON SCHEMA public TO ${OWNER_ROLE}`);
    cleanup.push(async () => {
      await q(admin, `DROP TABLE IF EXISTS spike_force`);
      await dropRole(OWNER_ROLE);
    });
    ownerPool = new Pool({ connectionString: withCreds(ADMIN_URL!, OWNER_ROLE, APP_PW), max: 1 });
    await q(ownerPool, `CREATE TABLE spike_force (id serial PRIMARY KEY, "orgId" text)`);
    await q(ownerPool, `INSERT INTO spike_force ("orgId") VALUES ('a'), ('b')`);
    await q(ownerPool, POLICY('spike_force'));
    await q(ownerPool, `ALTER TABLE spike_force ENABLE ROW LEVEL SECURITY`);
    const ownerNoForce = await q<{ n: string }>(
      ownerPool,
      `SELECT count(*)::text n FROM spike_force`
    );
    await q(ownerPool, `ALTER TABLE spike_force FORCE ROW LEVEL SECURITY`);
    const ownerForce = await q<{ n: string }>(
      ownerPool,
      `SELECT count(*)::text n FROM spike_force`
    );
    const ownerForceUpd = await q<{ n: string }>(
      ownerPool,
      `WITH u AS (UPDATE spike_force SET "orgId" = "orgId" RETURNING 1) SELECT count(*)::text n FROM u`
    );
    report(
      Number(ownerNoForce[0].n) === 2 &&
        Number(ownerForce[0].n) === 0 &&
        Number(ownerForceUpd[0].n) === 0,
      'a NOBYPASSRLS table OWNER: sees all without FORCE, sees/updates NOTHING under FORCE — a migrate role without BYPASSRLS silently backfills zero rows',
      {
        noForce: Number(ownerNoForce[0].n),
        force: Number(ownerForce[0].n),
        forceUpdate: Number(ownerForceUpd[0].n),
      }
    );
    {
      const c = await ownerPool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.bypass_rls','on',true)`);
        const r = await c.query<{ n: number }>(`SELECT count(*)::int n FROM spike_force`);
        await c.query('COMMIT');
        report(
          r.rows[0].n === 2,
          'that owner CAN see everything again with app.bypass_rls=on inside its transaction — the bypass GUC is the migration remedy',
          { rows: r.rows[0].n }
        );
      } finally {
        c.release();
      }
    }

    // ---- Q1 extension × transactions ------------------------------------------
    section('Q1 extension × transactions (app role, multi)');
    const { ext, patched, seen } = tenancyExtension(appBase.client, {
      multi: true,
      inject: true,
      tenantOwned,
    });
    const setConfigCount = (from: number) =>
      appBase!.events.slice(from).filter((e) => /set_config\('app\./.test(e.query)).length;

    // 1a: hook fires inside an interactive tx made on the UNPATCHED extended client?
    {
      seen.length = 0;
      const r = await runAsOrg(INSTALL_ORG, async () =>
        ext
          .$transaction(async (tx) => tx.aiAgentEmbedToken.count({ where: spikeWhere }))
          .then((n) => ({ ok: true, n }))
          .catch((e) => ({ ok: false, err: errCode(e) }))
      );
      const fired = seen.some((s) => s.model === 'AiAgentEmbedToken' && s.operation === 'count');
      report(
        fired,
        '1a  $allOperations fires for ops on the tx client inside an interactive $transaction',
        { hookSaw: seen.slice(0, 3) }
      );
      report(
        'info',
        '1a  naive per-op batch wrap INSIDE an interactive tx (no inTx flag) returns',
        r
      );
      // Does that naive wrap actually run inside the transaction? Write, then roll back.
      await runAsOrg(ORG_B, async () =>
        ext
          .$transaction(async (tx) => {
            await tx.aiAgentEmbedToken.updateMany({
              where: { label: 'spike-B-1' },
              data: { label: 'spike-B-1-escaped' },
            });
            throw new Error('rollback on purpose');
          })
          .catch(() => undefined)
      );
      const escaped = await adminPrisma.client.aiAgentEmbedToken.count({
        where: { label: 'spike-B-1-escaped' },
      });
      report(
        escaped === 1,
        '1a  …and it ESCAPES the transaction: the write survived a rollback because the batch wrap ran on another connection (so the inTx flag is mandatory, not an optimisation)',
        { survivedRollback: escaped }
      );
      await adminPrisma.client.aiAgentEmbedToken.updateMany({
        where: { label: 'spike-B-1-escaped' },
        data: { label: 'spike-B-1' },
      });
    }

    // 1b: can an extension's `client` component override $transaction?
    {
      let overrideAccepted: string;
      try {
        const attempt = appBase.client.$extends({
          client: {
            $transaction: () => Promise.resolve('overridden'),
          },
        });
        const r: unknown = await attempt.$transaction();
        overrideAccepted = r === 'overridden' ? 'yes' : `no (result ${String(r)})`;
      } catch (e) {
        overrideAccepted = `no (${errCode(e)})`;
      }
      report(
        overrideAccepted === 'yes',
        `1b  an extension client component can replace $transaction (so no Proxy over the client is needed): ${overrideAccepted}`
      );
    }

    // 1c: the Proxy-patched client — one set_config per interactive tx, none per op inside.
    {
      const from = appBase.events.length;
      seen.length = 0;
      const [countA, countB, countNone] = await Promise.all([
        runAsOrg(INSTALL_ORG, async () =>
          patched.$transaction(async (tx) => {
            await tx.aiAgentEmbedToken.count({ where: spikeWhere });
            await tx.aiAgentEmbedToken.count({ where: spikeWhere });
            return tx.aiAgentEmbedToken.count({ where: spikeWhere });
          })
        ),
        runAsOrg(ORG_B, async () =>
          patched.$transaction(async (tx) => tx.aiAgentEmbedToken.count({ where: spikeWhere }))
        ),
        patched.aiAgentEmbedToken.count({ where: spikeWhere }).catch((e) => `threw: ${errCode(e)}`),
      ]);
      const sets = setConfigCount(from);
      report(
        countA === 3 && countB === 2,
        '1c  interactive tx via the patched client sees only its org (A=3, B=2)',
        { countA, countB }
      );
      report(
        sets === 2,
        '1c  exactly one set_config per interactive transaction (3 ops inside → 1 setter)',
        { setConfigStatements: sets }
      );
      report(
        typeof countNone === 'string',
        '1c  an op with NO context at multi throws before SQL',
        { countNone }
      );
      report(
        seen.every((s) => !s.wrapped),
        '1c  no per-op wrapping happened inside the transactions (inTx flag honoured)'
      );
    }

    // 1d: batch $transaction with a prepended setter.
    {
      const from = appBase.events.length;
      const rows = await runAsOrg(ORG_B, async () =>
        patched.$transaction([
          patched.aiAgentEmbedToken.count({ where: spikeWhere }),
          patched.aiAgentEmbedToken.findMany({ where: spikeWhere, select: { label: true } }),
        ])
      );
      const [n, list] = rows as [number, Array<{ label: string }>];
      report(
        n === 2 && list.every((l) => l.label.startsWith('spike-B')),
        '1d  batch $transaction([...]) with prepended set_config scopes every member',
        {
          n,
          labels: list.map((l) => l.label),
          setConfigStatements: setConfigCount(from),
        }
      );
    }

    // 1e: per-op wrap outside any transaction; pool max 4, interleaved contexts.
    {
      const from = appBase.events.length;
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          runAsOrg(
            i % 2 === 0 ? INSTALL_ORG : ORG_B,
            async () => await patched.aiAgentEmbedToken.count({ where: spikeWhere })
          )
        )
      );
      const okAll = results.every((n, i) => n === (i % 2 === 0 ? 3 : 2));
      report(
        okAll,
        '1e  20 interleaved per-op wraps across 4 pooled connections each see exactly their org',
        {
          sample: results.slice(0, 6),
          setConfigStatements: setConfigCount(from),
        }
      );
      // After all that, an unscoped statement on a reused connection sees nothing (GUC reverted).
      const leak = await appBase.client.aiAgentEmbedToken.count({ where: spikeWhere });
      report(
        leak === 0,
        '1e  after the wraps, a raw unscoped query on the same pool sees 0 rows (SET LOCAL reverted; no leak)',
        { rows: leak }
      );
    }

    // 1f: PrismaPromise is lazy — the hook (and so the ALS read) runs at await time.
    {
      const lazy = await runAsOrg(ORG_B, () =>
        patched.aiAgentEmbedToken.count({ where: spikeWhere })
      )
        .then((n) => ({ ok: true, n }))
        .catch((e) => ({ ok: false, err: errCode(e) }));
      report(
        !lazy.ok,
        '1f  returning a PrismaPromise out of runAsOrg WITHOUT awaiting loses the context (hook runs at .then, outside the scope) — 3.2 must document/guard this',
        lazy
      );
      const eager = await runAsOrg(ORG_B, async () =>
        patched.aiAgentEmbedToken.count({ where: spikeWhere })
      );
      report(eager === 2, '1f  an async callback (await/return inside an async fn) keeps it', {
        n: eager,
      });
    }

    // ---- Q2 raw SQL ------------------------------------------------------------
    section('Q2 raw SQL through the extension');
    {
      seen.length = 0;
      const from = appBase.events.length;
      const rowsA = await runAsOrg(
        INSTALL_ORG,
        async () =>
          patched.$queryRaw<
            Array<{ n: number }>
          >`SELECT count(*)::int n FROM ai_agent_embed_token WHERE label LIKE 'spike-%'`
      );
      const rowsB = await runAsOrg(
        ORG_B,
        async () =>
          patched.$queryRaw<
            Array<{ n: number }>
          >`SELECT count(*)::int n FROM ai_agent_embed_token WHERE label LIKE 'spike-%'`
      );
      const rawSeen = seen.find((s) => s.model === undefined);
      report(
        rawSeen !== undefined,
        '2a  top-level $allOperations sees $queryRaw (model undefined)',
        rawSeen
      );
      report(
        rowsA[0]?.n === 3 && rowsB[0]?.n === 2,
        '2b  $queryRaw wrapped as $transaction([set_config, query(args)]) is RLS-scoped per org',
        {
          a: rowsA[0]?.n,
          b: rowsB[0]?.n,
          setConfigStatements: setConfigCount(from),
        }
      );
      const exec = await runAsOrg(
        ORG_B,
        async () =>
          patched.$executeRaw`UPDATE ai_agent_embed_token SET "updatedAt" = now() WHERE label LIKE 'spike-%'`
      );
      report(exec === 2, "2c  $executeRaw under org B updates only B's rows", { affected: exec });
      const rawInTx = await runAsOrg(ORG_B, async () =>
        patched.$transaction(
          async (tx) =>
            tx.$queryRaw<
              Array<{ n: number }>
            >`SELECT count(*)::int n FROM ai_agent_embed_token WHERE label LIKE 'spike-%'`
        )
      );
      report(
        rawInTx[0]?.n === 2,
        '2d  raw SQL inside an interactive tx is scoped by the tx-level set_config',
        { n: rawInTx[0]?.n }
      );
    }

    // ---- Q3 nested creates -------------------------------------------------------
    section('Q3 nested creates and orgId');
    {
      // 3a: NO injection — child gets no orgId → WITH CHECK rejects at multi.
      const noInject = tenancyExtension(appBase.client, {
        multi: true,
        inject: false,
        tenantOwned,
      });
      const r = await runAsOrg(ORG_B, async () =>
        noInject.patched.aiAgent
          .create({
            data: {
              name: 'spike-agent',
              slug: `spike-nested-${randomBytes(3).toString('hex')}`,
              description: 'x',
              systemInstructions: 'x',
              model: 'x',
              provider: 'x',
              embedTokens: { create: [{ label: 'spike-nested-noinject' }] },
            },
            select: { id: true },
          })
          .then(() => ({ rejected: false }))
          .catch((e) => ({ rejected: true, err: errCode(e) }))
      );
      report(
        r.rejected,
        '3a  nested create with no orgId is REJECTED by WITH CHECK at multi (parent rolled back)',
        r
      );
      const parentLeft = await adminPrisma.client.aiAgent.count({
        where: { slug: { startsWith: 'spike-nested-' } },
      });
      report(parentLeft === 0, '3a  the parent row did not survive the rejected nested create', {
        parents: parentLeft,
      });

      // 3b: recursive injection using the runtime data model.
      const { patched: inj, injectStats } = tenancyExtension(appBase.client, {
        multi: true,
        inject: true,
        tenantOwned,
      });
      const created = await runAsOrg(ORG_B, async () =>
        inj.aiAgent.create({
          data: {
            name: 'spike-agent',
            slug: `spike-nested-${randomBytes(3).toString('hex')}`,
            description: 'x',
            systemInstructions: 'x',
            model: 'x',
            provider: 'x',
            embedTokens: {
              create: [{ label: 'spike-nested-inject-1' }, { label: 'spike-nested-inject-2' }],
            },
            inviteTokens: {
              createMany: { data: [{ token: `spk_${randomBytes(6).toString('hex')}` }] },
            },
          },
          select: {
            id: true,
            embedTokens: { select: { orgId: true } },
            inviteTokens: { select: { orgId: true } },
          },
        })
      );
      cleanup.push(async () => {
        await adminPrisma.client.aiAgentInviteToken.deleteMany({
          where: { token: { startsWith: 'spk_' } },
        });
      });
      const allB =
        created.embedTokens.every((t) => t.orgId === ORG_B) &&
        created.inviteTokens.every((t) => t.orgId === ORG_B);
      report(
        allB,
        '3b  recursive injection (create + createMany, two child models) lands orgId on every nested child',
        {
          injected: injectStats.injected,
          embed: created.embedTokens,
          invite: created.inviteTokens,
        }
      );

      // 3c: column DEFAULT from the GUC, no injection — does Prisma omit the column so the DEFAULT applies?
      await q(
        admin,
        `ALTER TABLE ai_agent_embed_token ALTER COLUMN "orgId" SET DEFAULT NULLIF(current_setting('app.current_org', true), '')`
      );
      cleanup.push(async () => {
        await q(admin, `ALTER TABLE ai_agent_embed_token ALTER COLUMN "orgId" DROP DEFAULT`);
      });
      const viaDefault = await runAsOrg(ORG_B, async () =>
        noInject.patched.aiAgent
          .create({
            data: {
              name: 'spike-agent',
              slug: `spike-nested-${randomBytes(3).toString('hex')}`,
              description: 'x',
              systemInstructions: 'x',
              model: 'x',
              provider: 'x',
              embedTokens: { create: [{ label: 'spike-nested-default' }] },
            },
            select: { embedTokens: { select: { orgId: true } } },
          })
          .then((a): { ok: boolean; orgId?: string | null; err?: string } => ({
            ok: true,
            orgId: a.embedTokens[0]?.orgId,
          }))
          .catch((e): { ok: boolean; orgId?: string | null; err?: string } => ({
            ok: false,
            err: errCode(e),
          }))
      );
      report(
        viaDefault.ok && viaDefault.orgId === ORG_B,
        '3c  a column DEFAULT reading the GUC fills a nested child with no injection at all (Prisma omits the unset column)',
        viaDefault
      );
      await q(admin, `ALTER TABLE ai_agent_embed_token ALTER COLUMN "orgId" DROP DEFAULT`);
      // At single the GUC is never set, so the DEFAULT yields NULL there — recorded in the design doc.
    }

    // ---- Q6 types & layering ----------------------------------------------------
    section('Q6 types and layered $extends');
    {
      const n = await runAsOrg(INSTALL_ORG, async () => typeChecks(patched));
      report(
        typeof n === 'number',
        '6a  a Prisma.TransactionClient-typed callee accepts the extended tx (this file type-checks under npm run type-check)',
        { n }
      );

      let inspected = 0;
      const layered = patched.$extends({
        name: 'owner-predicate-probe',
        query: {
          $allModels: {
            async findMany({ args, query }) {
              inspected += 1;
              // The shape §115 would inspect: is there an owner predicate in `where`?
              const w = (args as { where?: Record<string, unknown> }).where;
              void (w && ('userId' in w || 'createdBy' in w));
              return query(args);
            },
          },
        },
      });
      const from = appBase.events.length;
      seen.length = 0;
      const expectedB = await adminPrisma.client.aiAgentEmbedToken.count({
        where: { ...spikeWhere, orgId: ORG_B },
      });
      const rows = await runAsOrg(ORG_B, async () =>
        layered.aiAgentEmbedToken.findMany({ where: spikeWhere, select: { orgId: true } })
      );
      const tenancyFired = seen.some((s) => s.operation === 'findMany');
      const onlyB = rows.length === expectedB && rows.every((r) => r.orgId === ORG_B);
      report(
        inspected === 1 && tenancyFired && onlyB,
        '6b  a second $extends layer composes with the tenancy layer (both hooks fire, scoping intact)',
        {
          inspected,
          tenancyHookFired: tenancyFired,
          rows: rows.length,
          expectedB,
          setConfigStatements: setConfigCount(from),
        }
      );
      const from2 = appBase.events.length;
      const inTxRows = await runAsOrg(ORG_B, async () =>
        layered.$transaction(async (tx) =>
          tx.aiAgentEmbedToken.findMany({ where: spikeWhere, select: { orgId: true } })
        )
      );
      report(
        inTxRows.length === expectedB &&
          inTxRows.every((r) => r.orgId === ORG_B) &&
          setConfigCount(from2) === 1,
        '6b  the $transaction client-component override survives a further $extends layer (one setter, scoped)',
        {
          rows: inTxRows.length,
          setConfigStatements: setConfigCount(from2),
        }
      );
    }

    // ---- Q4 cost ---------------------------------------------------------------
    section(`Q4 per-op cost (N=${N_OPS} sequential ops, app role, multi)`);
    const measure = async (label: string, base: ReturnType<typeof makeBase>) => {
      const { patched: p } = tenancyExtension(base.client, {
        multi: true,
        inject: true,
        tenantOwned,
      });
      const time = async (fn: () => Promise<unknown>) => {
        const t: number[] = [];
        for (let i = 0; i < N_OPS; i++) {
          const s = performance.now();
          await fn();
          t.push(performance.now() - s);
        }
        return {
          median: +median(t).toFixed(2),
          mean: +(t.reduce((a, b) => a + b, 0) / t.length).toFixed(2),
        };
      };
      const baseline = await time(() => base.client.aiAgentEmbedToken.count({ where: spikeWhere }));
      const wrapped = await time(() =>
        runAsOrg(ORG_B, async () => p.aiAgentEmbedToken.count({ where: spikeWhere }))
      );
      const fiveWrapped = await time(() =>
        runAsOrg(ORG_B, async () => {
          for (let k = 0; k < 5; k++) await p.aiAgentEmbedToken.count({ where: spikeWhere });
        })
      );
      const fiveInTx = await time(() =>
        runAsOrg(ORG_B, async () =>
          p.$transaction(async (tx) => {
            for (let k = 0; k < 5; k++) await tx.aiAgentEmbedToken.count({ where: spikeWhere });
          })
        )
      );
      report(
        'info',
        `${label}: ms/op median(mean) — unwrapped ${baseline.median}(${baseline.mean}) · wrapped ${wrapped.median}(${wrapped.mean}) · 5 wrapped ops ${fiveWrapped.median}(${fiveWrapped.mean}) · 5 ops in one interactive tx ${fiveInTx.median}(${fiveInTx.mean})`
      );
      report(
        'info',
        `${label}: wrap overhead ×${(wrapped.median / Math.max(baseline.median, 0.01)).toFixed(2)} per op; batching 5 ops into one tx vs 5 wraps ×${(fiveInTx.median / Math.max(fiveWrapped.median, 0.01)).toFixed(2)}`
      );
    };
    await measure('direct', appBase);
    if (appPooled) {
      await measure('pooled', appPooled);

      // Leak re-test through the pooler.
      const { patched: pp0 } = tenancyExtension(appPooled.client, {
        multi: true,
        inject: true,
        tenantOwned,
      });
      const expectedB = await adminPrisma.client.aiAgentEmbedToken.count({
        where: { ...spikeWhere, orgId: ORG_B },
      });
      const c0 = new Pool({ connectionString: APP_POOLED_URL!, max: 1 });
      const c1 = new Pool({ connectionString: APP_POOLED_URL!, max: 1 });
      const c2 = new Pool({ connectionString: APP_POOLED_URL!, max: 1 });
      try {
        // (i) set_config(..., true) outside an explicit transaction is a one-statement transaction: gone by the next statement.
        await q(c0, `SELECT set_config('app.current_org', '${INSTALL_ORG}', true)`);
        const after = await q<{ v: string | null }>(
          c0,
          `SELECT current_setting('app.current_org', true) v`
        );
        report(
          (after[0].v ?? '') === '',
          `pooled: set_config(local) outside an explicit tx is gone by the next statement (value now '${after[0].v ?? ''}') — only a real transaction carries it`
        );

        // (ii) a session-level SET poisons the pooler's server connection for OTHER clients.
        await q(c1, `SET app.current_org = '${ORG_B}'`); // session-level, outside any tx — the thing 3.2 must make impossible
        const seenBy2 = await q<{ v: string | null }>(
          c2,
          `SELECT current_setting('app.current_org', true) v`
        );
        const poisonedRows = await appPooled.client.aiAgentEmbedToken.count({ where: spikeWhere }); // plain client, no context
        report(
          'info',
          `pooled: after a session-level SET on client 1, client 2 reads '${seenBy2[0].v ?? ''}' and a plain UNSCOPED query sees ${poisonedRows} rows (transaction pooling hands the poisoned server connection to anyone)`
        );
        const stillScoped = await runAsOrg(INSTALL_ORG, async () =>
          pp0.aiAgentEmbedToken.count({ where: spikeWhere })
        );
        const stillScopedB = await runAsOrg(ORG_B, async () =>
          pp0.aiAgentEmbedToken.count({ where: spikeWhere })
        );
        report(
          stillScoped === 3 && stillScopedB === expectedB,
          'pooled: the wrapped op still sees only its org on a poisoned pool (SET LOCAL inside the tx overrides the session value) — but the poison remains for any unwrapped path',
          { a: stillScoped, b: stillScopedB }
        );
        // Best-effort decontamination of the pooler's server connections.
        await Promise.all(
          [c0, c1, c2].flatMap((c) =>
            Array.from({ length: 4 }, () => q(c, `RESET app.current_org`))
          )
        );
        const cleaned = await appPooled.client.aiAgentEmbedToken.count({ where: spikeWhere });
        report(
          'info',
          `pooled: after RESET from three clients an unscoped query sees ${cleaned} rows (0 = decontaminated; the RESET is best-effort under a pooler)`
        );
      } finally {
        await c0.end();
        await c1.end();
        await c2.end();
      }

      // Connection budget: hold more interactive transactions than the pooler's server pool.
      const { patched: pp } = tenancyExtension(appPooled.client, {
        multi: true,
        inject: true,
        tenantOwned,
      });
      const hold = async (ms: number) =>
        runAsOrg(ORG_B, async () =>
          pp.$transaction(
            async (tx) => {
              await tx.aiAgentEmbedToken.count({ where: spikeWhere });
              await new Promise((r) => setTimeout(r, ms));
              return tx.aiAgentEmbedToken.count({ where: spikeWhere });
            },
            { timeout: 20_000, maxWait: 20_000 }
          )
        );
      const s = performance.now();
      const held = await Promise.allSettled(Array.from({ length: 6 }, () => hold(400)));
      const wall = Math.round(performance.now() - s);
      report(
        'info',
        `pooled: 6 concurrent interactive txs each holding 400ms, client pool max 4 → wall ${wall}ms, ${held.filter((h) => h.status === 'fulfilled').length}/6 ok (${
          held
            .filter((h) => h.status === 'rejected')
            .map((h) => errCode(h.reason))
            .join('; ') || 'no errors'
        })`
      );
    } else {
      report('info', 'SPIKE_POOLED_URL not set — pooled measurements skipped');
    }

    // ---- disable / enable idempotence ----------------------------------------------
    section('enable/disable idempotence (what db:tenancy:enable|disable must satisfy)');
    const rls = async () =>
      q<{ t: string; en: boolean; forced: boolean }>(
        admin,
        `SELECT relname t, relrowsecurity en, relforcerowsecurity forced FROM pg_class WHERE relname = ANY($1::text[]) ORDER BY 1`,
        [tables]
      );
    for (const t of tables) {
      await q(admin, `ALTER TABLE "${t}" NO FORCE ROW LEVEL SECURITY`);
      await q(admin, `ALTER TABLE "${t}" DISABLE ROW LEVEL SECURITY`);
    }
    const afterDisable = await rls();
    const policiesStillThere = await q<{ n: string }>(
      admin,
      `SELECT count(*)::text n FROM pg_policies WHERE policyname = 'org_isolation' AND tablename = ANY($1::text[])`,
      [tables]
    );
    report(
      afterDisable.every((r) => !r.en && !r.forced) &&
        Number(policiesStillThere[0].n) === tables.length,
      'DISABLE leaves the policies in place (dormant again), only the flags change',
      {
        flags: afterDisable,
        policies: Number(policiesStillThere[0].n),
      }
    );
    for (const t of tables) {
      await q(admin, `ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
      await q(admin, `ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
    }
    const afterEnable = await rls();
    report(
      afterEnable.every((r) => r.en && r.forced),
      're-ENABLE/FORCE after DISABLE restores both flags (pg_class is the idempotence check the script should read)',
      afterEnable
    );
  } finally {
    section('cleanup');
    await appBase?.client.$disconnect();
    await appPooled?.client.$disconnect();
    await ownerPool?.end();
    await runCleanup();
    await adminPrisma.client.$disconnect();
    await admin.end();
    console.log('  done');
  }

  console.log('\n=== summary ===');
  for (const f of findings) console.log('  ' + f);
  const fails = findings.filter((f) => f.startsWith('FAIL')).length;
  console.log(`\n${fails} FAIL, ${findings.filter((f) => f.startsWith('PASS')).length} PASS`);
  process.exitCode = fails ? 1 : 0;
}

main().catch((e) => {
  console.error('\nSPIKE CRASHED:', e);
  process.exit(1);
});
