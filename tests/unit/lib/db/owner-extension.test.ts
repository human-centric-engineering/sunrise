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
  readablePredicate,
  readOwnerSchema,
  readerFor,
  rowReadable,
  unconfinedRelation,
  whereConfines,
  withOwnerChecks,
  type OwnerReader,
} from '@/lib/db/owner-extension';
import {
  OWNER_CLASSIFICATION,
  enforcedModels,
  registerAppOwnerClassification,
  __resetAppOwnerClassificationForTests,
} from '@/lib/db/owner-classification';
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
/**
 * Per table other than memories, the answers its SELECTs give, in order; the
 * last one repeats. A single-row read the layer confirms is two SELECTs, so a
 * test says what each returns.
 */
let tableAnswers: Record<string, Record<string, unknown>[][]> = {};

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

function rowsFor(sql: string): Record<string, unknown>[] | null {
  if (/^SELECT .* FROM "public"\."ai_user_memory"/.test(sql)) return memoryRows;
  const table = /^SELECT .*? FROM "public"\."(\w+)"/.exec(sql)?.[1];
  const queue = table === undefined ? undefined : tableAnswers[table];
  if (!queue || queue.length === 0) return null;
  return queue.length > 1 ? (queue.shift() ?? []) : queue[0];
}

function answer(q: SqlQuery): SqlResultSet {
  if (/^SELECT COUNT\(\*\)/.test(q.sql)) {
    return { columnNames: ['_count$_all'], columnTypes: [ColumnTypeEnum.Int32], rows: [[0]] };
  }
  const found = rowsFor(q.sql);
  if (found !== null) {
    const rows = found;
    const cols = selectedColumns(q.sql);
    return {
      columnNames: cols,
      columnTypes: cols.map((c) =>
        DATE_COLUMNS.has(c) ? ColumnTypeEnum.DateTime : ColumnTypeEnum.Text
      ),
      rows: rows.map((row) =>
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
  webhookSubscription: false,
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
  extra: { onConfinedRead?: () => void; readsShared?: boolean } = {}
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
/** Narrowed to their own rows, on the admin surface: a share admits rows. */
const asNarrowedAdmin = <T>(fn: () => Promise<T>) => as({ userId: ME }, fn, { readsShared: true });

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
  tableAnswers = {};
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
    // `_count: true` counts every relation, conversations and memories among them.
    await expect(
      asMember(() => db.aiAgent.findMany({ include: { _count: true } }))
    ).rejects.toThrow(/AiAgent\._count\.(conversations|userMemories)/);
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
    // AiApiKey is personal but not enforced.
    await asMember(() => db.aiApiKey.findMany());
    expect(statements).toHaveLength(1);
    expect(uncheckedReads).toHaveBeenCalledTimes(1);

    // Reached through an include, too.
    await asMember(() => db.user.findUnique({ where: { id: ME }, include: { aiApiKeys: true } }));
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

describe('withOwnerChecks — conversations and messages (t-802)', () => {
  const CONV = 'cmconv0000000000000000cv01';
  const conversation = (userId: string | null) => ({
    id: CONV,
    userId,
    agentId: AGENT,
    orgId: 'install',
  });
  const message = { id: 'cmmsg00000000000000000ms01', conversationId: CONV, role: 'user' };
  const live = () => ({
    revokedAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
  });
  const asAdmitted = <T>(fn: () => Promise<T>) =>
    runAsSubject(
      {
        principal: { userId: ME, credential: 'session' },
        filter: { userId: ME },
        resolveFilter: () => Promise.resolve({ userId: ME }),
        unattributedReads: { ...NO_UNATTRIBUTED, conversation: true },
        readsShared: true,
      },
      fn
    );

  it('refuses an unnarrowed list of conversations or messages, before any SQL', async () => {
    await expect(
      asMember(() => db.aiConversation.findMany({ where: { agentId: AGENT } }))
    ).rejects.toMatchObject({ reason: 'unconfined-filter' });
    await expect(
      asMember(() => db.aiMessage.count({ where: { conversationId: CONV } }))
    ).rejects.toMatchObject({ reason: 'unconfined-filter' });
    expect(statements).toHaveLength(0);
  });

  it('passes the three arms conversationVisibilityWhere emits, and a message list through its conversation', async () => {
    await asAdmitted(() =>
      db.aiConversation.findMany({
        where: {
          AND: [
            { OR: [{ userId: ME }, { userId: null }, { userId: { not: null }, share: live() }] },
            { agentId: AGENT },
          ],
        },
      })
    );
    await asMember(() =>
      db.aiMessage.findMany({ where: { conversationId: CONV, conversation: { userId: ME } } })
    );
    // The ownerless arm is the policy's: a caller it refuses cannot use it.
    await expect(
      asMember(() =>
        db.aiConversation.findMany({ where: { OR: [{ userId: ME }, { userId: null }] } })
      )
    ).rejects.toMatchObject({ reason: 'unconfined-filter' });
  });

  it('admits a share arm only while it selects live shares', async () => {
    await asNarrowedAdmin(() => db.aiConversation.count({ where: { share: live() } }));
    await asNarrowedAdmin(() =>
      db.aiConversation.count({ where: { share: { is: { revokedAt: null, expiresAt: null } } } })
    );
    for (const share of [
      { revokedAt: null },
      { expiresAt: null },
      { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date(0) } }] },
      { revokedAt: null, OR: [{ expiresAt: null }, { createdAt: { gt: new Date() } }] },
      { isNot: { revokedAt: { not: null } } },
    ]) {
      await expect(
        asNarrowedAdmin(() => db.aiConversation.count({ where: { share } })),
        JSON.stringify(share)
      ).rejects.toMatchObject({ reason: 'unconfined-filter' });
    }
  });

  it('admits no share arm off the admin surface', async () => {
    // A share is consent to the admin surface, where the read is audit-logged
    // — not to other members, so a `withAuth` caller cannot list through one.
    await expect(
      asMember(() => db.aiConversation.count({ where: { share: live() } }))
    ).rejects.toMatchObject({ reason: 'unconfined-filter' });
    expect(statements).toHaveLength(0);
  });

  it('lets a checked read follow the ownership relation in either direction without its own where', async () => {
    tableAnswers = { ai_conversation: [[conversation(ME)]], ai_message: [[message]] };
    await asMember(() =>
      db.aiConversation.findMany({
        where: { userId: ME },
        include: { messages: true, _count: { select: { messages: true } } },
      })
    );
    await asMember(() =>
      db.aiMessage.findMany({
        where: { conversation: { userId: ME } },
        include: { conversation: { include: { messages: true } } },
      })
    );
  });

  it('holds the same relation to a where when nothing checked the node it leaves', async () => {
    // A create returns a row nothing checked, so reading up to its conversation needs a where it cannot carry.
    await expect(
      asMember(() =>
        db.aiMessage.create({
          data: { conversationId: CONV, role: 'user', content: 'x' },
          include: { conversation: true },
        })
      )
    ).rejects.toMatchObject({ reason: 'unconfined-relation' });
    // From an agent, the conversations need their own where; under them, messages inherit.
    await expect(
      asMember(() => db.aiAgent.findMany({ include: { conversations: true } }))
    ).rejects.toThrow(/AiAgent\.conversations/);
    await asMember(() =>
      db.aiAgent.findMany({
        include: { conversations: { where: { userId: ME }, include: { messages: true } } },
      })
    );
    // A message's cost logs are not its ownership relation.
    await expect(
      asMember(() => db.aiCostLog.findMany({ include: { conversation: true } }))
    ).rejects.toMatchObject({ reason: 'unconfined-relation' });
  });

  it('reads a message by id narrowed through its conversation, in one query when it is readable', async () => {
    tableAnswers = { ai_message: [[message]] };
    const row = await asMember(() =>
      db.aiMessage.findUnique({ where: { id: message.id }, select: { role: true } })
    );
    expect(row).toEqual({ role: 'user' });
    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toMatch(/ai_conversation/);
    expect(statements[0].args).toContain(ME);
  });

  it("refuses another member's message by id, and answers none for one that does not exist", async () => {
    // Narrowed: nothing. Existence, asked below this layer: the row is there.
    tableAnswers = { ai_message: [[], [{ id: message.id }]] };
    await expect(
      asMember(() => db.aiMessage.findUnique({ where: { id: message.id } }))
    ).rejects.toMatchObject({ reason: 'foreign-row' });
    // The existence ask is the bare unique key, not narrowed.
    expect(statements).toHaveLength(2);
    expect(statements[1].sql).not.toMatch(/ai_conversation/);

    tableAnswers = { ai_message: [[], []] };
    await expect(
      asMember(() => db.aiMessage.findUnique({ where: { id: message.id } }))
    ).resolves.toBeNull();
  });

  it('refuses a findUniqueOrThrow of a foreign row, and keeps not-found for a missing one', async () => {
    tableAnswers = { ai_message: [[], [{ id: message.id }]] };
    await expect(
      asMember(() => db.aiMessage.findUniqueOrThrow({ where: { id: message.id } }))
    ).rejects.toBeInstanceOf(OwnerReadRefusedError);
    tableAnswers = { ai_message: [[], []] };
    await expect(
      asMember(() => db.aiMessage.findUniqueOrThrow({ where: { id: message.id } }))
    ).rejects.toMatchObject({ code: 'P2025' });
  });

  it("reads another member's shared thread by id on the admin surface, and refuses an unshared one", async () => {
    tableAnswers = { ai_conversation: [[conversation(OTHER)]] };
    await asNarrowedAdmin(() => db.aiConversation.findUnique({ where: { id: CONV } }));
    expect(statements[0].sql).toMatch(/ai_conversation_share/);

    tableAnswers = { ai_conversation: [[], [{ id: CONV }]] };
    await expect(
      asNarrowedAdmin(() => db.aiConversation.findUnique({ where: { id: CONV } }))
    ).rejects.toMatchObject({ reason: 'foreign-row' });
  });

  it("refuses another member's shared thread by id off the admin surface", async () => {
    // Narrowed without the share arm, the shared row misses and the existence
    // ask finds it: refused, not admitted through the share.
    tableAnswers = { ai_conversation: [[], [{ id: CONV }]] };
    await expect(
      asMember(() => db.aiConversation.findUnique({ where: { id: CONV } }))
    ).rejects.toMatchObject({ reason: 'foreign-row' });
    expect(statements[0].sql).not.toMatch(/ai_conversation_share/);
  });

  it('narrows inside a transaction on the transaction', async () => {
    tableAnswers = { ai_message: [[message]] };
    await asMember(() =>
      db.$transaction((tx) => tx.aiMessage.findUnique({ where: { id: message.id } }))
    );
    tableAnswers = { ai_message: [[], [{ id: message.id }]] };
    await expect(
      asMember(() =>
        db.$transaction((tx) => tx.aiMessage.findUnique({ where: { id: message.id } }))
      )
    ).rejects.toMatchObject({ reason: 'foreign-row' });
  });

  it('narrows an unconfined findFirst to the rows the caller may read, share arm included', async () => {
    tableAnswers = { ai_conversation: [[]] };
    await asNarrowedAdmin(() => db.aiConversation.findFirst({ where: { agentId: AGENT } }));
    expect(statements[0].sql).toMatch(/ai_conversation_share/);
    expect(statements[0].args).toContain(ME);

    statements.length = 0;
    await asMember(() => db.aiConversation.findFirst({ where: { agentId: AGENT } }));
    expect(statements[0].sql).not.toMatch(/ai_conversation_share/);
  });
});

describe('withOwnerChecks — a to-one relation, checked on its row (t-803)', () => {
  const DATASET = 'cmdset0000000000000000ds01';
  const run = { id: 'cmrun00000000000000000rn01', userId: ME, datasetId: DATASET, name: 'r' };
  const dataset = (userId: string | null) => ({ id: DATASET, userId, name: 'd' });
  const runWithDataset = () =>
    db.aiEvaluationRun.findMany({
      where: { userId: ME },
      include: { dataset: { select: { id: true, name: true } } },
    });

  it("refuses a run's dataset that belongs to another member", async () => {
    tableAnswers = { ai_evaluation_run: [[run]], ai_dataset: [[dataset(OTHER)]] };
    await expect(asMember(runWithDataset)).rejects.toMatchObject({
      name: 'OwnerReadRefusedError',
      reason: 'foreign-row',
    });
  });

  it("passes the caller's own dataset, selecting the owner column only to check it", async () => {
    tableAnswers = { ai_evaluation_run: [[run]], ai_dataset: [[dataset(ME)]] };
    const rows = await asMember(runWithDataset);
    expect(rows[0]?.dataset).toEqual({ id: DATASET, name: 'd' });
    expect(statements.find((s) => s.sql.includes('FROM "public"."ai_dataset"'))?.sql).toContain(
      '"ai_dataset"."userId"'
    );
  });

  it('admits an ownerless dataset only for a caller the policy lets read ownerless datasets', async () => {
    tableAnswers = { ai_evaluation_run: [[run]], ai_dataset: [[dataset(null)]] };
    await expect(asMember(runWithDataset)).rejects.toMatchObject({ reason: 'foreign-row' });

    tableAnswers = { ai_evaluation_run: [[run]], ai_dataset: [[dataset(null)]] };
    await expect(
      runAsSubject(
        {
          principal: { userId: ME, credential: 'session' },
          filter: { userId: ME },
          resolveFilter: () => Promise.resolve({ userId: ME }),
          unattributedReads: { ...NO_UNATTRIBUTED, dataset: true },
        },
        runWithDataset
      )
    ).resolves.toHaveLength(1);
  });

  it('checks the row from a root nothing else checks, at any depth', async () => {
    // An experiment is personal and not enforced; its variant's run is.
    tableAnswers = {
      ai_experiment: [[{ id: 'cmexp00000000000000000ex01', createdBy: ME }]],
      ai_experiment_variant: [
        [
          {
            id: 'cmvar00000000000000000va01',
            experimentId: 'cmexp00000000000000000ex01',
            evaluationRunId: run.id,
          },
        ],
      ],
      ai_evaluation_run: [[{ ...run, userId: OTHER }]],
    };
    await expect(
      asMember(() =>
        db.aiExperiment.findMany({
          where: { createdBy: ME },
          include: { variants: { include: { evaluationRun: { select: { id: true } } } } },
        })
      )
    ).rejects.toMatchObject({ reason: 'foreign-row' });
  });

  it('still refuses a to-one whose owner is reached through a parent', async () => {
    await expect(
      asMember(() =>
        db.aiEvaluationCaseResult.findMany({
          where: { run: { userId: ME } },
          include: { datasetCase: true },
        })
      )
    ).rejects.toMatchObject({ reason: 'unconfined-relation' });
    expect(statements).toHaveLength(0);
  });

  it('sends the include unchanged for a caller who is not narrowed', async () => {
    tableAnswers = { ai_evaluation_run: [[run]], ai_dataset: [[dataset(OTHER)]] };
    await asPlatformAdmin(runWithDataset);
    expect(statements.find((s) => s.sql.includes('FROM "public"."ai_dataset"'))?.sql).not.toContain(
      '"ai_dataset"."userId"'
    );
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
    await client.aiConversation.findMany({
      where: { agentId: AGENT },
      include: { messages: true },
    });
    await client.aiConversation.findUnique({ where: { id: 'cmconv0000000000000000cv01' } });
    await client.aiMessage.findFirst({ where: { role: 'user' } });
    await client.aiMessage.count();
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
    readsShared: false,
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

  it('builds a readable predicate that its own analysis accepts, for every enforced model', () => {
    const s = readOwnerSchema(base, enforcedModels());
    for (const reads of [{}, { conversation: true }]) {
      for (const readsShared of [false, true]) {
        for (const model of enforcedModels()) {
          const r = { ...reader(reads), readsShared };
          const where = readablePredicate(s, model, r);
          expect(whereConfines(s, model, where, r), model).toBe(true);
        }
      }
    }
    expect(readablePredicate(s, 'AiUserMemory', reader())).toEqual({ userId: ME });
    // Off the admin surface a conversation has no share arm to admit.
    expect(readablePredicate(s, 'AiConversation', reader())).toEqual({ userId: ME });
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
        readsShared: true,
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
  it("enforces a fork tier's model the same way, through the seam (t-807)", () => {
    // The generated client has no fork models, so enforcing one fails the
    // schema check by name — which is the proof the classification reached
    // the layer: unregistered, the model is never looked at.
    registerAppOwnerClassification({
      tier: 'app',
      models: {
        AppJournalEntry: { kind: 'personal', owner: { column: 'userId' }, enforced: true },
      },
    });
    try {
      expect(enforcedModels()).toContain('AppJournalEntry');
      expect(() => readOwnerSchema(base, enforcedModels())).toThrow(
        /AppJournalEntry\.userId is not a scalar column of AppJournalEntry/
      );
    } finally {
      __resetAppOwnerClassificationForTests();
    }
    expect(() => readOwnerSchema(base, enforcedModels())).not.toThrow();
  });

  it('refuses to enforce a model the layer cannot fully check', () => {
    // A child held to a rule its parent is not.
    expect(() => readOwnerSchema(base, ['AiMessage'])).toThrow(
      /owned through AiConversation, which is not enforced/
    );
    expect(() => readOwnerSchema(base, ['AiAgent'])).toThrow(/not classified personal/);
    expect(() =>
      readOwnerSchema(base, ['AiAgent'], () => ({
        kind: 'personal',
        owner: { column: 'createdBy' },
        alsoVisible: ['active-share'],
      }))
    ).toThrow(/declares active-share but has no share relation/);
    expect(() =>
      readOwnerSchema(base, ['AiAgent'], () => ({
        kind: 'personal',
        owner: { through: { field: 'parentAgent', parent: 'AiConversation' } },
      }))
    ).toThrow(/AiAgent\.parentAgent is not a relation to AiConversation/);
    expect(() => readOwnerSchema(base, ['AiConversation', 'AiMessage'])).not.toThrow();
  });

  it('enforces conversations, messages, memories, executions, evaluations and datasets in this release', () => {
    // Core's own list: a fork's enforced models are added to `enforcedModels()`
    // through its seam, and are not this release's to pin.
    expect(
      [...enforcedModels()].filter((m) => Object.hasOwn(OWNER_CLASSIFICATION, m)).sort()
    ).toEqual([
      'AiConversation',
      'AiDataset',
      'AiDatasetCase',
      'AiEvaluationCaseResult',
      'AiEvaluationLog',
      'AiEvaluationRun',
      'AiEvaluationSession',
      'AiMessage',
      'AiUserMemory',
      'AiWorkflowExecution',
    ]);
  });
});
