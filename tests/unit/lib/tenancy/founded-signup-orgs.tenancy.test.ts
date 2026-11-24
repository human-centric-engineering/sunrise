/**
 * Tests: a founder's signup org is released and set up at sign-in at `multi`
 * (§134 t-1084)
 *
 * `completeFoundedSignupOrgs()` runs on better-auth's session hook, whose
 * stack entered no org. Its release is raw SQL, and so is the org-created
 * hooks' lease that the setup takes next; at `multi` the data layer refuses
 * raw SQL with no context, so both threw, were caught and logged on every
 * sign-in, and the org waited for the maintenance job's backstop.
 *
 * The real generated `PrismaClient` wrapped by the real `withTenancy`, reading
 * the real `getTenantContext`, on a driver adapter that records every
 * statement and answers the few this path needs. Nothing about the context
 * guard is mocked, so a call that escapes every scope fails here the way it
 * does in production.
 *
 * @see lib/tenancy/lifecycle.ts
 * @see lib/db/tenancy-extension.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ColumnTypeEnum as ColumnType } from '@prisma/driver-adapter-utils';
import type {
  SqlDriverAdapter,
  SqlDriverAdapterFactory,
  SqlQuery,
  SqlResultSet,
  Transaction,
} from '@prisma/driver-adapter-utils';
import type { TenantContext } from '@/lib/tenancy/context';

const ORG = 'cmorg00000000000000000orga';
const OWNER = 'cmuser0000000000000000ownr';
const HOOK_KEY = 'test-setup';

// ─── Module mocks ───────────────────────────────────────────────────────

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'multi' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({ logger: mockLogger }));

vi.mock('@/lib/auth/sessions', () => ({ revokeUserSessions: vi.fn() }));

// The platform agents enter the org themselves (`reconcilePlatformAgents`);
// what is under test is the org-created hooks' half of the setup.
vi.mock('@/lib/orchestration/agents/reconcile-platform-agents', () => ({
  reconcilePlatformAgents: vi.fn(),
}));

/** The context each registered hook ran in. */
const hookContexts = vi.hoisted(() => [] as Array<TenantContext | null>);
const tenancy = vi.hoisted(() => ({
  get: (): TenantContext | null => null,
}));

vi.mock('@/lib/app/org-created', async () => {
  const { registerOrgCreatedHook } = await import('@/lib/tenancy/org-created-hooks');
  return {
    initAppOrgCreatedHooks: () =>
      registerOrgCreatedHook(HOOK_KEY, () => {
        hookContexts.push(tenancy.get());
      }),
  };
});

interface Statement {
  /** `root` for the pool connection, `tx<n>` for the n-th transaction. */
  conn: string;
  sql: string;
  args: unknown[];
}

const recorded = vi.hoisted(() => ({ statements: [] as Statement[] }));

/** Answer the statements this path reads; everything else gets an empty set. */
function answer(q: SqlQuery): SqlResultSet {
  // The release: the founder's one marked org.
  if (q.sql.includes('WITH founded AS')) {
    return {
      columnNames: ['orgId', 'ownerUserId'],
      columnTypes: [ColumnType.Text, ColumnType.Text],
      rows: [[ORG, OWNER]],
    };
  }
  // The hooks' lease: free, so this run takes it.
  if (q.sql.includes('{orgCreated,leaseUntil}')) {
    return {
      columnNames: ['lease'],
      columnTypes: [ColumnType.Text],
      rows: [['2026-11-24T12:00:00.000Z']],
    };
  }
  // The org, owing the one registered hook.
  const orgRead = /^SELECT (.+) FROM "public"\."org" WHERE/.exec(q.sql);
  if (orgRead) {
    const cols = orgRead[1].split(',').map((c) =>
      c
        .trim()
        .replace(/::text$/, '')
        .replace(/^.*\."/, '')
        .replace(/"$/, '')
    );
    const value: Record<string, unknown> = {
      id: ORG,
      slug: 'acme',
      name: 'Acme',
      settings: JSON.stringify({ orgCreated: { v: 1, source: 'signup', owed: [HOOK_KEY] } }),
    };
    return {
      columnNames: cols,
      columnTypes: cols.map((c) => (c === 'settings' ? ColumnType.Json : ColumnType.Text)),
      rows: [cols.map((c) => value[c] ?? null)],
    };
  }
  return { columnNames: [], columnTypes: [], rows: [] };
}

vi.mock('@/lib/db/client', async () => {
  const { PrismaClient } = await import('@prisma/client');
  const { withTenancy } = await import('@/lib/db/tenancy-extension');

  let txCount = 0;
  function connection(conn: string): SqlDriverAdapter & Transaction {
    return {
      provider: 'postgres',
      adapterName: 'recording',
      options: { usePhantomQuery: true },
      async queryRaw(q: SqlQuery): Promise<SqlResultSet> {
        recorded.statements.push({ conn, sql: q.sql, args: q.args });
        return answer(q);
      },
      async executeRaw(q: SqlQuery): Promise<number> {
        recorded.statements.push({ conn, sql: q.sql, args: q.args });
        return 1;
      },
      async executeScript() {},
      async dispose() {},
      async startTransaction() {
        return connection(`tx${++txCount}`);
      },
      async commit() {},
      async rollback() {},
    };
  }
  const factory: SqlDriverAdapterFactory = {
    provider: 'postgres',
    adapterName: 'recording',
    async connect() {
      return connection('root');
    },
  };

  const base = new PrismaClient({ adapter: factory });
  return {
    prisma: withTenancy(base, {
      isMultiTenant: () => mockEnv.TENANCY_MODE === 'multi',
      getTenantContext: () => tenancy.get(),
      installOrgId: 'install',
    }),
  };
});

// ─── Imports ────────────────────────────────────────────────────────────

import { completeFoundedSignupOrgs } from '@/lib/tenancy/lifecycle';
import { getTenantContext } from '@/lib/tenancy/context';
import { __resetOrgCreatedHooksForTests } from '@/lib/tenancy/org-created-hooks';

tenancy.get = getTenantContext;

/** The `set_config` that opened the transaction a statement ran in. */
function scopeOf(match: (sql: string) => boolean): string {
  const stmt = recorded.statements.find((s) => match(s.sql));
  if (!stmt) throw new Error('statement not run');
  const opener = recorded.statements.find(
    (s) => s.conn === stmt.conn && s.sql.includes('set_config(')
  );
  if (!opener) return 'none';
  return opener.sql.includes('app.bypass_rls') ? 'system' : `org ${String(opener.args[0])}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  recorded.statements = [];
  hookContexts.length = 0;
  mockEnv.TENANCY_MODE = 'multi';
  __resetOrgCreatedHooksForTests();
});

describe('completeFoundedSignupOrgs at multi, on a stack that entered no org', () => {
  it('releases the founder’s org in the system scope, without a tenant-context error', async () => {
    expect(getTenantContext()).toBeNull();

    await completeFoundedSignupOrgs(OWNER, { signingIn: true });

    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(scopeOf((sql) => sql.includes('WITH founded AS'))).toBe('system');
  });

  it('sets the released org up inside that org: the hooks’ lease, and each hook', async () => {
    await completeFoundedSignupOrgs(OWNER, { signingIn: true });

    expect(scopeOf((sql) => sql.includes('{orgCreated,leaseUntil}'))).toBe(`org ${ORG}`);
    expect(hookContexts).toHaveLength(1);
    expect(hookContexts[0]?.orgId).toBe(ORG);
    const warned = mockLogger.warn.mock.calls.map((c) => JSON.stringify(c));
    expect(warned.filter((w) => w.includes('No tenant context'))).toEqual([]);
    expect(mockLogger.info).toHaveBeenCalledWith('Signup org founded', {
      orgId: ORG,
      ownerUserId: OWNER,
    });
  });
});
