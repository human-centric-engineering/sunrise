/**
 * Tests: lib/db/tenancy-extension.ts — the tenancy chokepoint (§107 t-706)
 *
 * The real generated `PrismaClient` and the real extension, on a driver
 * adapter that records every statement it is handed and answers with empty
 * (or minimal) result sets. Nothing about Prisma is mocked: the SQL, the
 * bound parameters, the transaction boundaries and the undocumented
 * `__internalParams` all come from the runtime. That is what makes "no
 * `set_config` at single" and "exactly these statements at multi" claims
 * about the shipped client rather than about a stand-in.
 *
 * The context is a local `AsyncLocalStorage` the way `lib/tenancy/context.ts`
 * keeps one; the last block runs through the real `runAsOrg` to pin the seam
 * fix (a non-async callback keeps its context because the seam awaits it).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { ColumnTypeEnum } from '@prisma/driver-adapter-utils';
import type {
  SqlDriverAdapter,
  SqlDriverAdapterFactory,
  SqlQuery,
  SqlResultSet,
  Transaction,
} from '@prisma/driver-adapter-utils';
import { withTenancy, injectOrgId } from '@/lib/db/tenancy-extension';
import { classifyModels, readRuntimeDataModel } from '@/lib/tenancy/classification';
import type { TenantContext } from '@/lib/tenancy/context';

// ---------------------------------------------------------------------------
// A recording adapter
// ---------------------------------------------------------------------------

interface Statement {
  /** `root` for the pool connection, `tx<n>` for the n-th transaction. */
  conn: string;
  sql: string;
  args: unknown[];
}

interface Recorder {
  statements: Statement[];
  /** BEGIN / COMMIT / ROLLBACK, in order, tagged by transaction. */
  boundaries: string[];
  reset(): void;
}

function answer(q: SqlQuery): SqlResultSet {
  const returning = /RETURNING (.+)$/.exec(q.sql);
  if (returning) {
    const cols = returning[1].split(',').map((c) =>
      c
        .trim()
        .replace(/^.*\."/, '')
        .replace(/"$/, '')
    );
    return {
      columnNames: cols,
      columnTypes: cols.map(() => ColumnTypeEnum.Text),
      rows: [cols.map(() => null)],
    };
  }
  if (/^SELECT COUNT\(\*\)/.test(q.sql)) {
    return { columnNames: ['_count$_all'], columnTypes: [ColumnTypeEnum.Int32], rows: [[0]] };
  }
  // A nested write under an Org root first reads the parent row; let it exist
  // (every column null but the id, which the WHERE bound first).
  const orgRead = /^SELECT (.+) FROM "public"\."org" WHERE/.exec(q.sql);
  if (orgRead) {
    const cols = orgRead[1].split(',').map((c) =>
      c
        .trim()
        .replace(/::text$/, '')
        .replace(/^.*\."/, '')
        .replace(/"$/, '')
    );
    return {
      columnNames: cols,
      columnTypes: cols.map(() => ColumnTypeEnum.Text),
      rows: [cols.map((c) => (c === 'id' ? q.args[0] : null))],
    };
  }
  return { columnNames: [], columnTypes: [], rows: [] };
}

function recordingAdapter(): { factory: SqlDriverAdapterFactory; recorder: Recorder } {
  const recorder: Recorder = {
    statements: [],
    boundaries: [],
    reset() {
      this.statements = [];
      this.boundaries = [];
      txCount = 0;
    },
  };
  let txCount = 0;

  function connection(conn: string): SqlDriverAdapter & Transaction {
    return {
      provider: 'postgres',
      adapterName: 'recording',
      // Phantom: the adapter owns BEGIN / COMMIT, so no statement for them
      // reaches the log and the counts below are the extension's alone.
      options: { usePhantomQuery: true },
      async queryRaw(q: SqlQuery): Promise<SqlResultSet> {
        recorder.statements.push({ conn, sql: q.sql, args: q.args });
        return answer(q);
      },
      async executeRaw(q: SqlQuery): Promise<number> {
        recorder.statements.push({ conn, sql: q.sql, args: q.args });
        return 1;
      },
      async executeScript() {},
      async dispose() {},
      async startTransaction() {
        const tag = `tx${++txCount}`;
        recorder.boundaries.push(`${tag} BEGIN`);
        return connection(tag);
      },
      async commit() {
        recorder.boundaries.push(`${conn} COMMIT`);
      },
      async rollback() {
        recorder.boundaries.push(`${conn} ROLLBACK`);
      },
    };
  }

  const factory: SqlDriverAdapterFactory = {
    provider: 'postgres',
    adapterName: 'recording',
    async connect() {
      return connection('root');
    },
  };
  return { factory, recorder };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const INSTALL = 'install';
const ORG_A = 'cmorg00000000000000000orga';
const ORG_B = 'cmorg00000000000000000orgb';

const store = new AsyncLocalStorage<TenantContext>();
const asOrg = <T>(orgId: string, fn: () => Promise<T>) =>
  store.run({ orgId, source: 'job' }, async () => await fn());
const asSystem = <T>(fn: () => Promise<T>) =>
  store.run({ orgId: null, source: 'system' }, async () => await fn());

let mode: 'single' | 'multi' = 'single';
const { factory, recorder } = recordingAdapter();
const base = new PrismaClient({ adapter: factory });
const db = withTenancy(base, {
  isMultiTenant: () => mode === 'multi',
  getTenantContext: () => store.getStore() ?? null,
  installOrgId: INSTALL,
});
const rdm = readRuntimeDataModel(base);
const tenantOwned = new Set(classifyModels(rdm).tenantOwned.map((m) => m.model));

const setConfigs = () => recorder.statements.filter((s) => s.sql.includes("set_config('app."));
const inserts = (table: string) =>
  recorder.statements.filter((s) => s.sql.startsWith(`INSERT INTO "public"."${table}"`));
/** The value bound to a column of an INSERT, by position in its column list. */
function boundValue(stmt: Statement, column: string, row = 0): unknown {
  const cols = /\(([^)]+)\) VALUES/
    .exec(stmt.sql)?.[1]
    .split(',')
    .map((c) => c.trim().slice(1, -1));
  if (!cols) throw new Error(`not an INSERT: ${stmt.sql}`);
  const at = cols.indexOf(column);
  return at === -1 ? undefined : stmt.args[row * cols.length + at];
}

/** The `SET …` part of an UPDATE — its RETURNING list names every column. */
function setClause(stmt: Statement): string {
  return stmt.sql.slice(stmt.sql.indexOf(' SET '), stmt.sql.indexOf(' WHERE '));
}

beforeEach(() => {
  mode = 'single';
  recorder.reset();
});

const embedToken = { agentId: 'agent-1' };
const agent = {
  name: 'Support',
  slug: 'support',
  description: '',
  systemInstructions: 'help',
  model: '',
  provider: '',
};

// ---------------------------------------------------------------------------
// Single
// ---------------------------------------------------------------------------

describe('at single', () => {
  it('stamps the install org on a create with no context, and issues no set_config', async () => {
    await db.aiAgentEmbedToken.create({ data: embedToken });
    const [insert] = inserts('ai_agent_embed_token');
    expect(boundValue(insert, 'orgId')).toBe(INSTALL);
    expect(setConfigs()).toEqual([]);
    expect(recorder.boundaries).toEqual([]);
  });

  it('stamps the context org when one was entered', async () => {
    await asOrg(ORG_A, () => db.aiAgentEmbedToken.create({ data: embedToken }));
    expect(boundValue(inserts('ai_agent_embed_token')[0], 'orgId')).toBe(ORG_A);
    expect(setConfigs()).toEqual([]);
  });

  it('never overwrites an explicit orgId', async () => {
    await asOrg(ORG_A, () =>
      db.aiAgentEmbedToken.create({ data: { ...embedToken, orgId: ORG_B } })
    );
    expect(boundValue(inserts('ai_agent_embed_token')[0], 'orgId')).toBe(ORG_B);
  });

  it('stamps nothing under runAsSystem', async () => {
    await asSystem(() => db.aiAgentEmbedToken.create({ data: embedToken }));
    expect(boundValue(inserts('ai_agent_embed_token')[0], 'orgId')).toBeUndefined();
  });

  it('stamps every row of a createMany', async () => {
    await db.aiAgentEmbedToken.createMany({ data: [embedToken, { agentId: 'agent-2' }] });
    const [insert] = inserts('ai_agent_embed_token');
    expect(boundValue(insert, 'orgId', 0)).toBe(INSTALL);
    expect(boundValue(insert, 'orgId', 1)).toBe(INSTALL);
  });

  it('stamps the create branch of an upsert and not the update branch', async () => {
    await db.aiAgentEmbedToken.upsert({
      where: { id: 'e1' },
      create: embedToken,
      update: { label: 'renamed' },
    });
    expect(boundValue(inserts('ai_agent_embed_token')[0], 'orgId')).toBe(INSTALL);
    const updates = recorder.statements.filter((s) => s.sql.startsWith('UPDATE'));
    for (const u of updates) expect(setClause(u)).not.toContain('"orgId"');
  });

  it('descends a nested create under a tenant-owned root', async () => {
    await db.aiAgent.create({
      data: { ...agent, embedTokens: { create: [{ label: 'site' }] } },
    });
    expect(boundValue(inserts('ai_agent')[0], 'orgId')).toBe(INSTALL);
    expect(boundValue(inserts('ai_agent_embed_token')[0], 'orgId')).toBe(INSTALL);
  });

  it('descends a nested create under an update root, stamping the create only', async () => {
    await db.aiAgent.update({
      where: { id: 'a1' },
      data: { name: 'Renamed', embedTokens: { create: { label: 'site' } } },
    });
    const update = recorder.statements.find((s) => s.sql.startsWith('UPDATE "public"."ai_agent"'));
    expect(update && setClause(update)).not.toContain('"orgId"');
    expect(boundValue(inserts('ai_agent_embed_token')[0], 'orgId')).toBe(INSTALL);
  });

  it('does not stamp a create reached through the org relation itself', async () => {
    // Prisma's AiAgentCreateWithoutOrgInput refuses an explicit orgId here;
    // the nesting supplies it.
    await db.org.update({ where: { id: ORG_A }, data: { aiAgents: { create: agent } } });
    const [insert] = inserts('ai_agent');
    expect(insert).toBeDefined();
    expect(boundValue(insert, 'orgId')).toBe(ORG_A);
  });

  it('leaves an updateMany payload alone (an update never moves rows)', async () => {
    await asOrg(ORG_A, () =>
      db.aiAgentEmbedToken.updateMany({ where: { agentId: 'agent-1' }, data: { isActive: false } })
    );
    const [update] = recorder.statements.filter((s) => s.sql.startsWith('UPDATE'));
    expect(setClause(update)).not.toContain('"orgId"');
    expect(update.args).not.toContain(ORG_A);
  });

  it('touches nothing on a system model, and opens no transaction anywhere', async () => {
    await db.session.update({ where: { id: 's1' }, data: { activeOrgId: ORG_A } });
    await db.featureFlag.findMany();
    await db.$queryRaw`SELECT 1`;
    await db.$transaction([db.aiAgent.findMany(), db.featureFlag.findMany()]);
    await db.$transaction(async (tx) => {
      await tx.aiAgentEmbedToken.count();
    });
    expect(setConfigs()).toEqual([]);
    // Only the two transactions the caller asked for.
    expect(recorder.boundaries.filter((b) => b.endsWith('BEGIN'))).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Multi
// ---------------------------------------------------------------------------

describe('at multi', () => {
  beforeEach(() => {
    mode = 'multi';
  });

  it('wraps an op on a tenant-owned model as [set_config, op] in one transaction', async () => {
    await asOrg(ORG_A, () => db.aiAgentEmbedToken.findMany());
    expect(recorder.boundaries).toEqual(['tx1 BEGIN', 'tx1 COMMIT']);
    expect(recorder.statements.map((s) => s.conn)).toEqual(['tx1', 'tx1']);
    expect(recorder.statements[0].sql).toBe("SELECT set_config('app.current_org', $1, true)");
    expect(recorder.statements[0].args).toEqual([ORG_A]);
    expect(recorder.statements[1].sql).toMatch(/^SELECT .* FROM "public"."ai_agent_embed_token"/);
  });

  it('stamps the context org and wraps the create', async () => {
    await asOrg(ORG_A, () => db.aiAgentEmbedToken.create({ data: embedToken }));
    expect(setConfigs()).toHaveLength(1);
    expect(setConfigs()[0].args).toEqual([ORG_A]);
    expect(boundValue(inserts('ai_agent_embed_token')[0], 'orgId')).toBe(ORG_A);
  });

  it('wraps a raw op, and a $queryRawUnsafe', async () => {
    await asOrg(ORG_A, async () => {
      await db.$queryRaw`SELECT 1`;
      await db.$executeRawUnsafe('SELECT 2');
    });
    expect(setConfigs()).toHaveLength(2);
    expect(recorder.boundaries).toEqual(['tx1 BEGIN', 'tx1 COMMIT', 'tx2 BEGIN', 'tx2 COMMIT']);
  });

  it('runAsSystem sets the bypass GUC instead of an org, and stamps nothing', async () => {
    await asSystem(() => db.aiAgentEmbedToken.create({ data: embedToken }));
    expect(setConfigs()).toHaveLength(1);
    expect(setConfigs()[0].sql).toBe("SELECT set_config('app.bypass_rls', 'on', true)");
    expect(boundValue(inserts('ai_agent_embed_token')[0], 'orgId')).toBeUndefined();
  });

  it('throws before any SQL for a tenant-owned op with no context', async () => {
    await expect(db.aiAgentEmbedToken.findMany()).rejects.toThrow(
      /No tenant context for AiAgentEmbedToken\.findMany at TENANCY_MODE=multi/
    );
    await expect(db.$queryRaw`SELECT 1`).rejects.toThrow(
      /No tenant context for raw SQL\.\$queryRaw/
    );
    expect(recorder.statements).toEqual([]);
  });

  it('leaves a read on a non-tenant model unwrapped, context or not', async () => {
    await db.featureFlag.findMany();
    await asOrg(ORG_A, () => db.featureFlag.findMany());
    expect(setConfigs()).toEqual([]);
    expect(recorder.boundaries).toEqual([]);
  });

  describe('a read on a non-tenant root that reaches a tenant-owned relation', () => {
    // The shapes in the tree: capabilities list agents, tags count documents.
    it('is wrapped when it includes one', async () => {
      await asOrg(ORG_A, () =>
        db.aiCapability.findMany({ include: { agents: { include: { agent: true } } } })
      );
      expect(setConfigs()).toHaveLength(1);
      expect(recorder.statements.every((s) => s.conn === 'tx1')).toBe(true);
    });

    it('is wrapped when it counts one', async () => {
      await asOrg(ORG_A, () =>
        db.knowledgeTag.findMany({ include: { _count: { select: { documents: true } } } })
      );
      expect(setConfigs()).toHaveLength(1);
    });

    it('is wrapped when it filters or orders by one', async () => {
      await asOrg(ORG_A, async () => {
        await db.user.findMany({ where: { OR: [{ aiApiKeys: { some: { name: 'x' } } }] } });
        await db.user.findMany({ orderBy: { aiApiKeys: { _count: 'desc' } } });
      });
      expect(setConfigs()).toHaveLength(2);
    });

    it('throws before any SQL with no context', async () => {
      await expect(db.aiCapability.findMany({ include: { agents: true } })).rejects.toThrow(
        /No tenant context for AiCapability\.findMany/
      );
      expect(recorder.statements).toEqual([]);
    });

    it('stays unwrapped when the read names only scalars and non-tenant relations', async () => {
      await asOrg(ORG_A, async () => {
        await db.user.findUnique({
          where: { id: 'u1' },
          include: { orgMemberships: true },
          select: undefined,
        });
        await db.session.findMany({
          where: { AND: [{ userId: 'u1' }] },
          orderBy: { createdAt: 'desc' },
        });
      });
      expect(setConfigs()).toEqual([]);
    });
  });

  it('passes a no-context write on a non-tenant root through (the switch route)', async () => {
    await db.session.update({ where: { id: 's1' }, data: { activeOrgId: ORG_A } });
    expect(setConfigs()).toEqual([]);
    expect(recorder.statements.some((s) => s.sql.startsWith('UPDATE "public"."session"'))).toBe(
      true
    );
  });

  it('wraps a write on a non-tenant root when a context exists (nested creates run inside it)', async () => {
    await asOrg(ORG_A, () =>
      db.org.update({ where: { id: ORG_A }, data: { aiAgents: { create: agent } } })
    );
    expect(setConfigs()).toHaveLength(1);
    expect(inserts('ai_agent')[0].conn).toBe('tx1');
  });

  describe('transactions', () => {
    it('issues exactly one set_config at the top of an interactive transaction', async () => {
      await asOrg(ORG_A, () =>
        db.$transaction(async (tx) => {
          await tx.aiAgentEmbedToken.count();
          await tx.aiAgent.findMany();
          await tx.$queryRaw`SELECT 3`;
        })
      );
      expect(recorder.boundaries).toEqual(['tx1 BEGIN', 'tx1 COMMIT']);
      expect(setConfigs()).toHaveLength(1);
      expect(recorder.statements[0].sql).toBe("SELECT set_config('app.current_org', $1, true)");
      expect(recorder.statements.every((s) => s.conn === 'tx1')).toBe(true);
      expect(recorder.statements).toHaveLength(4);
    });

    it('prepends the setter to a batch and slices it back out of the results', async () => {
      const results = await asOrg(ORG_A, () =>
        db.$transaction([db.aiAgentEmbedToken.count(), db.aiAgent.findMany()])
      );
      expect(results).toEqual([0, []]);
      expect(recorder.boundaries).toEqual(['tx1 BEGIN', 'tx1 COMMIT']);
      expect(setConfigs()).toHaveLength(1);
      expect(recorder.statements.every((s) => s.conn === 'tx1')).toBe(true);
    });

    it('pins the undocumented __internalParams.transaction for both forms', async () => {
      // If Prisma stops handing the hook this parameter, every op inside a
      // transaction would be re-wrapped onto another connection and escape
      // it — the failure item 1 measured. The pass-through above proves the
      // parameter is present (no second BEGIN); this proves the shape.
      const seen: Array<{ operation: string; kind: unknown }> = [];
      const probe = base.$extends({
        query: {
          $allOperations: (params) => {
            const internal = (params as { __internalParams?: { transaction?: { kind?: string } } })
              .__internalParams;
            seen.push({ operation: params.operation, kind: internal?.transaction?.kind });
            return params.query(params.args);
          },
        },
      });
      await probe.$transaction(async (tx) => {
        await tx.featureFlag.findMany();
      });
      await probe.$transaction([probe.featureFlag.findMany()]);
      await probe.featureFlag.findMany();
      expect(seen).toEqual([
        { operation: 'findMany', kind: 'itx' },
        { operation: 'findMany', kind: 'batch' },
        { operation: 'findMany', kind: undefined },
      ]);
    });

    it('wraps an op issued on the root client from inside a callback on its own connection', async () => {
      await asOrg(ORG_A, () =>
        db.$transaction(async (tx) => {
          await tx.aiAgentEmbedToken.count();
          await db.aiAgentEmbedToken.count();
        })
      );
      // The root-client op is not bound to the interactive transaction: it
      // gets its own [set_config, op] rather than running unscoped.
      expect(setConfigs()).toHaveLength(2);
      expect(recorder.boundaries).toEqual(['tx1 BEGIN', 'tx2 BEGIN', 'tx2 COMMIT', 'tx1 COMMIT']);
    });

    it('runs a system transaction under the bypass GUC', async () => {
      await asSystem(() =>
        db.$transaction(async (tx) => {
          await tx.aiAgent.findMany();
        })
      );
      expect(setConfigs()).toHaveLength(1);
      expect(setConfigs()[0].sql).toBe("SELECT set_config('app.bypass_rls', 'on', true)");
    });

    it('refuses an op for another org inside a transaction opened for one', async () => {
      await expect(
        asOrg(ORG_A, () =>
          db.$transaction(async (tx) => {
            await asOrg(ORG_B, () => tx.aiAgent.findMany());
          })
        )
      ).rejects.toThrow(/runs for org .*orgb inside a transaction opened for .*orga/);
      expect(recorder.boundaries).toEqual(['tx1 BEGIN', 'tx1 ROLLBACK']);
    });

    it('with no context, delegates plainly and lets the per-op rule refuse inside', async () => {
      await expect(
        db.$transaction(async (tx) => {
          await tx.session.update({ where: { id: 's1' }, data: { activeOrgId: ORG_A } });
          await tx.aiAgent.findMany();
        })
      ).rejects.toThrow(/No tenant context for AiAgent\.findMany/);
      expect(setConfigs()).toEqual([]);
      expect(recorder.statements.some((s) => s.sql.startsWith('UPDATE "public"."session"'))).toBe(
        true
      );
      expect(recorder.boundaries).toEqual(['tx1 BEGIN', 'tx1 ROLLBACK']);
    });

    it('hands a later $extends layer a tx client its hooks fire on', async () => {
      // §115's starting point: the override delegates with the outermost
      // client as `this`, so an outer layer's hook runs inside transactions.
      const outerSeen: string[] = [];
      const layered = db.$extends({
        query: {
          $allOperations: (params) => {
            outerSeen.push(`${params.model ?? 'raw'}.${params.operation}`);
            return params.query(params.args);
          },
        },
      });
      await asOrg(ORG_A, () =>
        layered.$transaction(async (tx) => {
          await tx.aiAgent.findMany();
        })
      );
      expect(outerSeen).toContain('AiAgent.findMany');
      expect(setConfigs()).toHaveLength(1);
      expect(recorder.boundaries).toEqual(['tx1 BEGIN', 'tx1 COMMIT']);
    });
  });
});

// ---------------------------------------------------------------------------
// The walk, on its own
// ---------------------------------------------------------------------------

describe('injectOrgId', () => {
  it('stamps only tenant-owned models', () => {
    expect(injectOrgId(rdm, tenantOwned, 'FeatureFlag', { name: 'x' }, ORG_A, true)).toEqual({
      name: 'x',
    });
    expect(injectOrgId(rdm, tenantOwned, 'AiAgent', { name: 'x' }, ORG_A, true)).toEqual({
      name: 'x',
      orgId: ORG_A,
    });
  });

  it('leaves an explicit org relation alone', () => {
    const data = { name: 'x', org: { connect: { id: ORG_B } } };
    expect(injectOrgId(rdm, tenantOwned, 'AiAgent', data, ORG_A, true)).toEqual(data);
  });

  it('walks connectOrCreate, nested upsert and the to-one update shorthand', () => {
    const out = injectOrgId(
      rdm,
      tenantOwned,
      'AiAgentEmbedToken',
      {
        agent: {
          connectOrCreate: { where: { id: 'a1' }, create: agent },
        },
      },
      ORG_A,
      true
    ) as { orgId: string; agent: { connectOrCreate: { create: { orgId: string } } } };
    expect(out.orgId).toBe(ORG_A);
    expect(out.agent.connectOrCreate.create.orgId).toBe(ORG_A);

    const upsert = injectOrgId(
      rdm,
      tenantOwned,
      'AiAgent',
      {
        embedTokens: {
          upsert: [{ where: { id: 'e1' }, create: { label: 'l' }, update: { label: 'm' } }],
        },
      },
      ORG_A,
      false
    ) as {
      orgId?: string;
      embedTokens: { upsert: Array<{ create: { orgId?: string }; update: { orgId?: string } }> };
    };
    expect(upsert.orgId).toBeUndefined();
    expect(upsert.embedTokens.upsert[0].create.orgId).toBe(ORG_A);
    expect(upsert.embedTokens.upsert[0].update.orgId).toBeUndefined();

    const shorthand = injectOrgId(
      rdm,
      tenantOwned,
      'AiAgentEmbedToken',
      { agent: { update: { name: 'renamed', embedTokens: { create: { label: 'new' } } } } },
      ORG_A,
      false
    ) as { agent: { update: { orgId?: string; embedTokens: { create: { orgId?: string } } } } };
    expect(shorthand.agent.update.orgId).toBeUndefined();
    expect(shorthand.agent.update.embedTokens.create.orgId).toBe(ORG_A);
  });

  it('passes scalars and arrays of scalars through', () => {
    expect(injectOrgId(rdm, tenantOwned, 'AiAgent', 'x', ORG_A, true)).toBe('x');
    expect(injectOrgId(rdm, tenantOwned, 'AiAgent', [1, 2], ORG_A, true)).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// Through the real seam
// ---------------------------------------------------------------------------

describe('through lib/tenancy/context.ts', () => {
  it('a non-async callback keeps its context because the seam awaits inside it', async () => {
    vi.doMock('@/lib/env', () => ({ env: { TENANCY_MODE: 'multi' } }));
    vi.doMock('@/lib/db/client', () => ({ prisma: {} }));
    vi.doMock('@/lib/logging', () => ({ logger: { info: vi.fn() } }));
    const context = await import('@/lib/tenancy/context');
    const client = withTenancy(base, {
      isMultiTenant: context.isMultiTenant,
      getTenantContext: context.getTenantContext,
      installOrgId: INSTALL,
    });
    mode = 'multi';
    // Deliberately not `async () =>`: the PrismaPromise is returned unawaited.
    await context.runAsOrg(ORG_B, () => client.aiAgentEmbedToken.findMany());
    expect(setConfigs()).toHaveLength(1);
    expect(setConfigs()[0].args).toEqual([ORG_B]);
    await context.runAsSystem('test', () => client.aiAgentEmbedToken.findMany());
    expect(setConfigs()[1].sql).toContain('app.bypass_rls');
  });
});
