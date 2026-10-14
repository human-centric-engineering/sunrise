/**
 * Tests: lib/db/owner-extension.ts — the owner chokepoint (§115 t-801)
 *
 * The real generated `PrismaClient`, the real tenancy layer and the real owner
 * layer, on a driver adapter that records every statement and answers memory
 * reads with the rows a test sets. The subject is entered through the real
 * `runAsSubject`, as the guards enter it. So "refused" and "passes" are claims
 * about the shipped stack, not about a stand-in, and "neutral" is a claim
 * about the SQL that reaches the database.
 *
 * Every refusal below was checked to fail with its check removed (the PR body
 * says how).
 */
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
import { withTenancy, type TenancyClient } from '@/lib/db/tenancy-extension';
import {
  OwnerReadRefusedError,
  readOwnerSchema,
  readerFor,
  rowReadable,
  unconfinedRelation,
  whereConfines,
  withOwnerChecks,
  type OwnerReader,
} from '@/lib/db/owner-extension';
import { enforcedModels } from '@/lib/db/owner-classification';
import {
  getSubjectReadScope,
  noteConfinedRead,
  noteUncheckedRead,
  runAcrossOwners,
  runAsSubject,
} from '@/lib/auth/subject-context';
import type { UnattributedReads } from '@/lib/auth/orphan-reads';
import type { SubjectFilter } from '@/lib/auth/authorization';

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// A recording adapter that can answer memory reads
// ---------------------------------------------------------------------------

interface Statement {
  sql: string;
  args: unknown[];
}

const statements: Statement[] = [];
/** The rows the next `ai_user_memory` SELECT answers with, by column name. */
let memoryRows: Record<string, unknown>[] = [];

const DATE_COLUMNS = new Set(['createdAt', 'updatedAt']);

function selectedColumns(sql: string): string[] {
  const list = /^SELECT (.+?) FROM /.exec(sql)?.[1] ?? '';
  return list.split(',').map((c) =>
    c
      .trim()
      .replace(/::text$/, '')
      .replace(/ AS .*$/, '')
      .replace(/^.*\."/, '')
      .replace(/"$/, '')
  );
}

function answer(q: SqlQuery): SqlResultSet {
  if (/^SELECT COUNT\(\*\)/.test(q.sql)) {
    return { columnNames: ['_count$_all'], columnTypes: [ColumnTypeEnum.Int32], rows: [[0]] };
  }
  if (/^SELECT .* FROM "public"\."ai_user_memory"/.test(q.sql)) {
    const cols = selectedColumns(q.sql);
    return {
      columnNames: cols,
      columnTypes: cols.map((c) =>
        DATE_COLUMNS.has(c) ? ColumnTypeEnum.DateTime : ColumnTypeEnum.Text
      ),
      rows: memoryRows.map((row) =>
        cols.map((c) => (DATE_COLUMNS.has(c) ? '2026-10-14T00:00:00.000Z' : (row[c] ?? null)))
      ),
    };
  }
  return { columnNames: [], columnTypes: [], rows: [] };
}

function connection(): SqlDriverAdapter & Transaction {
  return {
    provider: 'postgres',
    adapterName: 'recording',
    options: { usePhantomQuery: true },
    async queryRaw(q: SqlQuery): Promise<SqlResultSet> {
      statements.push({ sql: q.sql, args: q.args });
      return answer(q);
    },
    async executeRaw(q: SqlQuery): Promise<number> {
      statements.push({ sql: q.sql, args: q.args });
      return 1;
    },
    async executeScript() {},
    async dispose() {},
    async startTransaction() {
      return connection();
    },
    async commit() {},
    async rollback() {},
  };
}

const factory: SqlDriverAdapterFactory = {
  provider: 'postgres',
  adapterName: 'recording',
  async connect() {
    return connection();
  },
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const ME = 'cmuser0000000000000000me01';
const OTHER = 'cmuser0000000000000000ot01';
const AGENT = 'cmagent000000000000000ag01';
const AT = new Date('2026-10-14T00:00:00.000Z');

const NO_UNATTRIBUTED: UnattributedReads = {
  conversation: false,
  dataset: false,
  execution: false,
  experiment: false,
  webhookDelivery: false,
};

const base = new PrismaClient({ adapter: factory });
const tenancyOnly: TenancyClient = withTenancy(base, {
  isMultiTenant: () => false,
  getTenantContext: () => null,
  installOrgId: 'install',
});
const confinedReads = vi.fn();
const uncheckedReads = vi.fn();
const db = withOwnerChecks(tenancyOnly, {
  schema: readOwnerSchema(base, enforcedModels()),
  getSubjectReadScope,
  onConfinedRead: () => {
    confinedReads();
    noteConfinedRead();
  },
  onUncheckedRead: () => {
    uncheckedReads();
    noteUncheckedRead();
  },
});

/** Run `fn` as a caller the policy answered `filter` for. */
function as<T>(
  filter: SubjectFilter,
  fn: () => Promise<T>,
  extra: { onConfinedRead?: () => void } = {}
): Promise<T> {
  return runAsSubject(
    {
      principal: { userId: filter.userId ?? 'cmuser000000000000000adm01', credential: 'session' },
      filter,
      resolveFilter: () => Promise.resolve(filter),
      unattributedReads: NO_UNATTRIBUTED,
      ...extra,
    },
    fn
  );
}
const asMember = <T>(fn: () => Promise<T>) => as({ userId: ME }, fn);
const asPlatformAdmin = <T>(fn: () => Promise<T>) => as({}, fn);

const memory = (userId: string) => ({
  id: `mem-${userId}`,
  userId,
  agentId: AGENT,
  key: 'k',
  value: 'v',
  orgId: 'install',
});

beforeEach(() => {
  statements.length = 0;
  memoryRows = [];
  confinedReads.mockClear();
  uncheckedReads.mockClear();
});

// ---------------------------------------------------------------------------
// The layer on the client
// ---------------------------------------------------------------------------

describe('withOwnerChecks — a narrowed caller', () => {
  it('refuses a list or count whose filter does not name the caller, before any SQL', async () => {
    await expect(
      asMember(() => db.aiUserMemory.findMany({ where: { agentId: AGENT } }))
    ).rejects.toBeInstanceOf(OwnerReadRefusedError);
    await expect(asMember(() => db.aiUserMemory.findMany())).rejects.toThrow(
      /Refused AiUserMemory\.findMany/
    );
    await expect(asMember(() => db.aiUserMemory.count())).rejects.toThrow(
      /Refused AiUserMemory\.count/
    );
    await expect(
      asMember(() => db.aiUserMemory.aggregate({ _count: { _all: true } }))
    ).rejects.toThrow(/Refused AiUserMemory\.aggregate/);
    await expect(
      asMember(() => db.aiUserMemory.groupBy({ by: ['agentId'], _count: { _all: true } }))
    ).rejects.toThrow(/Refused AiUserMemory\.groupBy/);
    expect(statements).toEqual([]);
  });

  it('lets a list and a count narrowed to the caller through', async () => {
    memoryRows = [memory(ME)];
    const rows = await asMember(() =>
      db.aiUserMemory.findMany({ where: { userId: ME, agentId: AGENT } })
    );
    expect(rows.map((r) => r.userId)).toEqual([ME]);
    await asMember(() => db.aiUserMemory.count({ where: { userId: { equals: ME } } }));
    expect(statements).toHaveLength(2);
    expect(confinedReads).toHaveBeenCalledTimes(2);
  });

  it('refuses a filter naming another member, and one that names the caller and someone else', async () => {
    await expect(
      asMember(() => db.aiUserMemory.findMany({ where: { userId: OTHER } }))
    ).rejects.toBeInstanceOf(OwnerReadRefusedError);
    await expect(
      asMember(() => db.aiUserMemory.findMany({ where: { userId: { in: [ME, OTHER] } } }))
    ).rejects.toBeInstanceOf(OwnerReadRefusedError);
  });

  it('analyses nested AND / OR / NOT as a tree', async () => {
    memoryRows = [memory(ME)];
    // A confining conjunct anywhere under AND confines the whole.
    await asMember(() =>
      db.aiUserMemory.findMany({ where: { AND: [{ agentId: AGENT }, { userId: ME }] } })
    );
    await asMember(() =>
      db.aiUserMemory.findMany({
        where: { AND: [{ agentId: AGENT }, { AND: { OR: [{ userId: ME }, { userId: ME }] } }] },
      })
    );
    // One OR arm that does not confine opens the whole.
    await expect(
      asMember(() =>
        db.aiUserMemory.findMany({ where: { OR: [{ userId: ME }, { agentId: AGENT }] } })
      )
    ).rejects.toBeInstanceOf(OwnerReadRefusedError);
    // NOT is never narrowing, even around the caller's own id.
    await expect(
      asMember(() => db.aiUserMemory.findMany({ where: { NOT: { userId: OTHER } } }))
    ).rejects.toBeInstanceOf(OwnerReadRefusedError);
  });

  it("refuses a findUnique that returns another member's memory, and passes the caller's own", async () => {
    memoryRows = [memory(OTHER)];
    await expect(
      asMember(() => db.aiUserMemory.findUnique({ where: { id: `mem-${OTHER}` } }))
    ).rejects.toMatchObject({ reason: 'foreign-row' });

    memoryRows = [memory(ME)];
    const own = await asMember(() => db.aiUserMemory.findUnique({ where: { id: `mem-${ME}` } }));
    expect(own?.userId).toBe(ME);
    expect(confinedReads).toHaveBeenCalledTimes(1);
  });

  it('checks a findUnique whose select leaves out the owner, and hands back only what was asked for', async () => {
    memoryRows = [memory(OTHER)];
    await expect(
      asMember(() =>
        db.aiUserMemory.findUnique({ where: { id: `mem-${OTHER}` }, select: { value: true } })
      )
    ).rejects.toMatchObject({ reason: 'foreign-row' });

    memoryRows = [memory(ME)];
    const own = await asMember(() =>
      db.aiUserMemory.findUnique({ where: { id: `mem-${ME}` }, select: { value: true } })
    );
    expect(own).toEqual({ value: 'v' });
  });

  it("narrows an unconfined findFirst to the caller's own rows rather than checking whichever row came first", async () => {
    // Checking the returned row would refuse or pass depending on which match
    // the database returned first; narrowed, the caller's own row is found.
    memoryRows = [memory(ME)];
    const row = await asMember(() =>
      db.aiUserMemory.findFirst({ where: { key: 'k' }, orderBy: { updatedAt: 'desc' } })
    );
    expect(row?.userId).toBe(ME);
    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toMatch(/"userId" = \$\d/);
    expect(statements[0].args).toContain(ME);
    expect(statements[0].args).toContain('k');

    // With no where at all, the caller's predicate is the whole filter.
    statements.length = 0;
    await asMember(() => db.aiUserMemory.findFirstOrThrow());
    expect(statements[0].args).toContain(ME);
    expect(confinedReads).toHaveBeenCalledTimes(2);
  });

  it("refuses a write that would return another member's row, before any SQL", async () => {
    const other = { id: `mem-${OTHER}` };
    await expect(
      asMember(() => db.aiUserMemory.update({ where: other, data: {} }))
    ).rejects.toMatchObject({ reason: 'unconfined-write' });
    await expect(asMember(() => db.aiUserMemory.delete({ where: other }))).rejects.toMatchObject({
      reason: 'unconfined-write',
    });
    await expect(
      asMember(() =>
        db.aiUserMemory.upsert({
          where: { userId_agentId_key: { userId: OTHER, agentId: AGENT, key: 'k' } },
          create: { userId: OTHER, agentId: AGENT, key: 'k', value: 'v' },
          update: {},
        })
      )
    ).rejects.toMatchObject({ reason: 'unconfined-write' });
    await expect(
      asMember(() => db.aiUserMemory.updateManyAndReturn({ where: { agentId: AGENT }, data: {} }))
    ).rejects.toMatchObject({ reason: 'unconfined-write' });
    expect(statements).toEqual([]);
  });

  it("lets a write confined to the caller's own rows, and a write returning only a count, through", async () => {
    memoryRows = [memory(ME)];
    await asMember(() =>
      db.aiUserMemory.upsert({
        where: { userId_agentId_key: { userId: ME, agentId: AGENT, key: 'k' } },
        create: { id: 'mem-new', userId: ME, agentId: AGENT, key: 'k', value: 'v' },
        update: { value: 'v' },
      })
    );
    await asMember(() => db.aiUserMemory.deleteMany({ where: { agentId: AGENT } }));
    expect(statements.length).toBeGreaterThan(0);
    // A write is not a read the guard can count.
    expect(confinedReads).not.toHaveBeenCalled();
  });

  it('confines on the owner relation as on the owner column', async () => {
    memoryRows = [memory(ME)];
    await asMember(() => db.aiUserMemory.findMany({ where: { user: { id: ME } } }));
    await asMember(() => db.aiUserMemory.count({ where: { user: { is: { id: ME } } } }));
    expect(confinedReads).toHaveBeenCalledTimes(2);
    await expect(
      asMember(() => db.aiUserMemory.findMany({ where: { user: { id: OTHER } } }))
    ).rejects.toBeInstanceOf(OwnerReadRefusedError);
    await expect(
      asMember(() => db.aiUserMemory.findMany({ where: { user: { email: 'me@example.com' } } }))
    ).rejects.toBeInstanceOf(OwnerReadRefusedError);
  });

  it('passes a single-row read that found nothing', async () => {
    await expect(
      asMember(() => db.aiUserMemory.findUnique({ where: { id: 'missing' } }))
    ).resolves.toBeNull();
  });

  it('confines on a compound unique key without needing the row', async () => {
    memoryRows = [memory(ME)];
    await asMember(() =>
      db.aiUserMemory.findUnique({
        where: { userId_agentId_key: { userId: ME, agentId: AGENT, key: 'k' } },
      })
    );
    // Confined by the filter, so counted as a confined read before any row came back.
    expect(confinedReads).toHaveBeenCalledTimes(1);
  });

  it('refuses an include of memories from another root unless it is confined', async () => {
    await expect(
      asMember(() =>
        db.user.findUnique({ where: { id: OTHER }, include: { aiUserMemories: true } })
      )
    ).rejects.toMatchObject({ reason: 'unconfined-relation' });
    await expect(
      asMember(() =>
        db.aiAgent.findMany({ select: { id: true, _count: { select: { userMemories: true } } } })
      )
    ).rejects.toMatchObject({ reason: 'unconfined-relation' });
    await expect(
      asMember(() => db.aiAgent.findMany({ include: { _count: true } }))
    ).rejects.toThrow(/AiAgent\._count\.userMemories/);
    // Deeper: a non-enforced relation whose own include reaches memories.
    await expect(
      asMember(() =>
        db.aiAgent.findMany({ include: { userMemories: { include: { user: true } } } })
      )
    ).rejects.toMatchObject({ reason: 'unconfined-relation' });

    await asMember(() =>
      db.user.findUnique({
        where: { id: ME },
        include: { aiUserMemories: { where: { userId: ME } } },
      })
    );
    await asMember(() =>
      db.aiAgent.findMany({
        select: { id: true, _count: { select: { userMemories: { where: { userId: ME } } } } },
      })
    );
  });

  it('checks reads issued on the tx client inside an interactive transaction', async () => {
    await expect(
      asMember(() => db.$transaction((tx) => tx.aiUserMemory.findMany({ where: {} })))
    ).rejects.toBeInstanceOf(OwnerReadRefusedError);
  });

  it('leaves a model that is not enforced alone, and tells the guard nothing checked it', async () => {
    // AiConversation is personal but not enforced until t-802.
    await asMember(() => db.aiConversation.findMany());
    expect(statements).toHaveLength(1);
    expect(uncheckedReads).toHaveBeenCalledTimes(1);

    // Reached through an include, too.
    await asMember(() =>
      db.user.findUnique({ where: { id: ME }, include: { aiConversations: true } })
    );
    expect(uncheckedReads).toHaveBeenCalledTimes(2);

    // An enforced read, and a read of a model that is not personal, are not unchecked.
    memoryRows = [memory(ME)];
    await asMember(() => db.aiUserMemory.findMany({ where: { userId: ME } }));
    await asMember(() => db.aiAgent.findMany());
    expect(uncheckedReads).toHaveBeenCalledTimes(2);
  });

  it("tells the guard's callback a confined read happened", async () => {
    const seen = vi.fn();
    memoryRows = [memory(ME)];
    await as({ userId: ME }, () => db.aiUserMemory.findMany({ where: { userId: ME } }), {
      onConfinedRead: seen,
    });
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe('withOwnerChecks — callers that are not narrowed', () => {
  it('passes every read for a platform admin, a job and a declared crossing', async () => {
    memoryRows = [memory(OTHER)];
    await asPlatformAdmin(() => db.aiUserMemory.findMany());
    await asPlatformAdmin(() => db.aiUserMemory.findUnique({ where: { id: `mem-${OTHER}` } }));
    await db.aiUserMemory.findMany();
    await asMember(() => runAcrossOwners('test: an org-wide count', () => db.aiUserMemory.count()));
    expect(confinedReads).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Neutrality: no narrowed caller ⇒ the same SQL as without the layer
// ---------------------------------------------------------------------------

describe('neutrality', () => {
  const workload = async (client: TenancyClient) => {
    memoryRows = [memory(OTHER)];
    await client.aiUserMemory.findMany({
      where: { agentId: AGENT },
      orderBy: { updatedAt: 'desc' },
    });
    await client.aiUserMemory.findUnique({
      where: { id: `mem-${OTHER}` },
      select: { value: true },
    });
    await client.aiUserMemory.count();
    await client.user.findUnique({ where: { id: OTHER }, include: { aiUserMemories: true } });
    await client.aiAgent.findMany({ include: { _count: true } });
    await client.aiUserMemory.upsert({
      where: { userId_agentId_key: { userId: OTHER, agentId: AGENT, key: 'k' } },
      // Ids and timestamps pinned: the runtime would generate fresh ones per run.
      create: {
        id: 'mem-new',
        userId: OTHER,
        agentId: AGENT,
        key: 'k',
        value: 'v',
        createdAt: AT,
        updatedAt: AT,
      },
      update: { value: 'v', updatedAt: AT },
    });
    await client.$transaction((tx) => tx.aiUserMemory.findMany());
  };

  const sqlOf = async (run: () => Promise<void>): Promise<Statement[]> => {
    statements.length = 0;
    await run();
    return statements.map((s) => ({ ...s }));
  };

  it('a platform admin sends identical statements with and without the layer', async () => {
    const without = await sqlOf(() => asPlatformAdmin(() => workload(tenancyOnly)));
    const withLayer = await sqlOf(() => asPlatformAdmin(() => workload(db)));
    expect(without.length).toBeGreaterThan(5);
    expect(withLayer).toEqual(without);
  });

  it('single with no narrowed caller sends identical statements with and without the layer', async () => {
    const without = await sqlOf(() => workload(tenancyOnly));
    const withLayer = await sqlOf(() => workload(db));
    expect(without.length).toBeGreaterThan(5);
    expect(withLayer).toEqual(without);
  });
});

// ---------------------------------------------------------------------------
// The analysis, on its own
// ---------------------------------------------------------------------------

describe('whereConfines / rowReadable', () => {
  // AiWorkflowExecution has an ownerless kind and a column owner, so the
  // analysis can be exercised on it here before t-803 enforces it.
  const schema = readOwnerSchema(base, ['AiUserMemory', 'AiWorkflowExecution']);
  const reader = (reads: Partial<UnattributedReads> = {}): OwnerReader => ({
    userId: ME,
    unattributedReads: { ...NO_UNATTRIBUTED, ...reads },
  });

  it('admits an ownerless arm only for a caller the policy lets read ownerless rows', () => {
    const where = { OR: [{ userId: ME }, { userId: null }] };
    expect(whereConfines(schema, 'AiWorkflowExecution', where, reader())).toBe(false);
    expect(whereConfines(schema, 'AiWorkflowExecution', where, reader({ execution: true }))).toBe(
      true
    );
    expect(rowReadable(schema, 'AiWorkflowExecution', null, reader())).toBe(false);
    expect(rowReadable(schema, 'AiWorkflowExecution', null, reader({ execution: true }))).toBe(
      true
    );
    // A model with no ownerless kind never admits one, whatever the caller may read.
    expect(
      whereConfines(schema, 'AiUserMemory', { userId: null }, reader({ execution: true }))
    ).toBe(false);
  });

  it("analyses a child's relation filter as its parent's predicate", () => {
    // AiMessage is owned through its conversation. A schema that only knows
    // AiConversation's arms still has to agree with the parent's analysis.
    const s = readOwnerSchema(base, []);
    expect(whereConfines(s, 'AiMessage', { conversation: { userId: ME } }, reader())).toBe(true);
    expect(whereConfines(s, 'AiMessage', { conversation: { is: { userId: ME } } }, reader())).toBe(
      true
    );
    expect(
      whereConfines(
        s,
        'AiMessage',
        { conversation: { OR: [{ userId: ME }, { userId: null }] } },
        reader({ conversation: true })
      )
    ).toBe(true);
    expect(whereConfines(s, 'AiMessage', { conversation: { userId: null } }, reader())).toBe(false);
    expect(whereConfines(s, 'AiMessage', { conversationId: 'c1' }, reader())).toBe(false);
    expect(
      whereConfines(s, 'AiMessage', { conversation: { isNot: { userId: OTHER } } }, reader())
    ).toBe(false);
  });

  it('confines on the owner relation, by id, and nowhere else', () => {
    expect(whereConfines(schema, 'AiUserMemory', { user: { id: ME } }, reader())).toBe(true);
    expect(whereConfines(schema, 'AiUserMemory', { user: { is: { id: ME } } }, reader())).toBe(
      true
    );
    expect(whereConfines(schema, 'AiUserMemory', { user: { id: { equals: ME } } }, reader())).toBe(
      true
    );
    expect(whereConfines(schema, 'AiUserMemory', { user: { id: OTHER } }, reader())).toBe(false);
    expect(
      whereConfines(schema, 'AiUserMemory', { user: { isNot: { id: OTHER } } }, reader())
    ).toBe(false);
    // `agent` is a relation, but not the owner's.
    expect(whereConfines(schema, 'AiUserMemory', { agent: { id: ME } }, reader())).toBe(false);
  });

  it('treats an empty OR and an empty in as matching nothing, and an empty where as everything', () => {
    expect(whereConfines(schema, 'AiUserMemory', { OR: [] }, reader())).toBe(true);
    expect(whereConfines(schema, 'AiUserMemory', { userId: { in: [] } }, reader())).toBe(true);
    expect(whereConfines(schema, 'AiUserMemory', {}, reader())).toBe(false);
    expect(whereConfines(schema, 'AiUserMemory', undefined, reader())).toBe(false);
  });

  it('names the path of the first unconfined relation', () => {
    expect(
      unconfinedRelation(
        schema,
        'Org',
        { include: { aiAgents: { include: { userMemories: true } } } },
        reader()
      )
    ).toBe('Org.aiAgents.userMemories');
  });

  it('reads no reader off a scope that does not narrow', () => {
    expect(readerFor({ kind: 'none' })).toBeNull();
    expect(
      readerFor({
        kind: 'subject',
        principal: { userId: ME, credential: 'session' },
        filter: {},
        unattributedReads: NO_UNATTRIBUTED,
      })
    ).toBeNull();
    expect(
      readerFor({
        kind: 'admitted',
        reason: 'x',
        principal: { userId: ME, credential: 'session' },
      })
    ).toBeNull();
  });
});

describe('readOwnerSchema', () => {
  it('refuses to enforce a model the layer cannot fully check yet', () => {
    expect(() => readOwnerSchema(base, ['AiMessage'])).toThrow(/through a relation.*t-802/);
    expect(() => readOwnerSchema(base, ['AiConversation'])).toThrow(/alsoVisible.*t-802/);
    expect(() => readOwnerSchema(base, ['AiAgent'])).toThrow(/not classified personal/);
  });

  it('enforces exactly AiUserMemory in this release', () => {
    expect(enforcedModels()).toEqual(['AiUserMemory']);
  });
});
