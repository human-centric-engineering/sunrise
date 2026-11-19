/**
 * Tests for `lib/tenancy/org-created-hooks.ts` (§134 t-1061).
 *
 * The seam promises that every new org gets the app's setup, eventually, and
 * that a failing hook never blocks the org. Both halves rest on the owed list
 * in `Org.settings.orgCreated`, so the database double here is a real store:
 * `clearOrgCreatedOwed()`'s read-modify-write runs against it unmocked, and the
 * assertions read what it left behind, not what a mock was told.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Prisma } from '@prisma/client';

const initAppOrgCreatedHooks = vi.hoisted(() => vi.fn());
vi.mock('@/lib/app/org-created', () => ({ initAppOrgCreatedHooks }));

const loggerError = vi.hoisted(() => vi.fn());
const loggerWarn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logging', () => ({
  logger: { error: loggerError, warn: loggerWarn, info: vi.fn(), debug: vi.fn() },
}));

/** One org row's settings column, and its OWNER memberships, as the double holds them. */
const store = vi.hoisted(() => ({
  orgs: new Map<
    string,
    { slug: string; name: string; settings: unknown; createdAt: Date; status?: string }
  >(),
  owners: new Map<string, string[]>(),
}));

/**
 * The two raw statements, played against the store with the same rules the
 * SQL states: the lease is taken only when an owed record exists and no
 * unexpired lease is on it; the job selects ACTIVE orgs holding a record.
 * The SQL itself was checked against Postgres with EXPLAIN when written.
 */
const rawSql = vi.hoisted(
  () =>
    async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<Array<{ id: string } | { lease: string }>> => {
      const sql = strings.join('?');
      const recordOf = (settings: unknown): Record<string, unknown> | null => {
        if (typeof settings !== 'object' || settings === null) return null;
        const record = (settings as Record<string, unknown>).orgCreated;
        return typeof record === 'object' && record !== null
          ? (record as Record<string, unknown>)
          : null;
      };
      if (sql.includes('UPDATE org')) {
        const [leaseMs, orgId] = values as [number, string];
        const row = store.orgs.get(orgId);
        const record = row ? recordOf(row.settings) : null;
        if (!row || !record) return [];
        const lease = record.leaseUntil;
        if (typeof lease === 'string' && new Date(lease).getTime() > Date.now()) return [];
        const claimed = new Date(Date.now() + leaseMs).toISOString();
        record.leaseUntil = claimed;
        return [{ lease: claimed }];
      }
      if (sql.includes('SELECT id FROM org')) {
        const [keys] = values as [string[]];
        return [...store.orgs.entries()]
          .filter(([, row]) => {
            const owed = recordOf(row.settings)?.owed;
            return (
              (row.status ?? 'ACTIVE') === 'ACTIVE' &&
              Array.isArray(owed) &&
              owed.some((key) => keys.includes(key as string))
            );
          })
          .map(([id]) => ({ id }));
      }
      throw new Error(`unexpected raw SQL: ${sql}`);
    }
);

const db = vi.hoisted(() => {
  const client = {
    org: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = store.orgs.get(where.id);
        return row ? { ...row } : null;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: { settings: unknown } }) => {
          const row = store.orgs.get(where.id);
          if (!row) throw new Error('no such org');
          row.settings = data.settings;
          return row;
        }
      ),
    },
    orgMembership: {
      findFirst: vi.fn(async ({ where }: { where: { orgId: string } }) => {
        const owner = store.owners.get(where.orgId)?.[0];
        return owner ? { userId: owner } : null;
      }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(client)),
    $queryRaw: vi.fn(rawSql),
  };
  return client;
});
vi.mock('@/lib/db/client', () => ({ prisma: db }));

import {
  registerOrgCreatedHook,
  runOrgCreatedHooks,
  orgCreatedHookKeys,
  ORG_CREATED_HOOK_TIMEOUT_MS,
  ORG_CREATED_JOB_BUDGET_MS,
  ORG_CREATED_LEASE_MS,
  ORG_CREATED_RUN_BUDGET_MS,
  retryOwedOrgCreatedHooks,
  __resetOrgCreatedHooksForTests,
  type OrgCreatedContext,
} from '@/lib/tenancy/org-created-hooks';
import { orgCreatedSettings, readOrgCreatedOwed } from '@/lib/tenancy/org-settings';
import { getTenantContext } from '@/lib/tenancy/context';

const ORG = 'org-new';
/** Old enough that the retry job no longer leaves it to its create. */
const LONG_AGO = new Date('2026-01-01T00:00:00Z');

/** An org as `createOrg()` leaves it: created with the hooks it is owed. */
function seedOrg(owed: string[], extra: Record<string, unknown> = {}, owners: string[] = []) {
  const settings = { ...extra, ...(orgCreatedSettings(owed, 'admin') ?? {}) };
  store.orgs.set(ORG, { slug: 'new', name: 'New Org', settings, createdAt: LONG_AGO });
  store.owners.set(ORG, owners);
}

function owedNow(): string[] | null {
  return readOrgCreatedOwed(store.orgs.get(ORG)?.settings)?.owed ?? null;
}

function register(entries: Record<string, (ctx: OrgCreatedContext) => unknown>) {
  initAppOrgCreatedHooks.mockImplementation(() => {
    for (const [key, hook] of Object.entries(entries)) {
      registerOrgCreatedHook(key, async (ctx) => {
        await hook(ctx);
      });
    }
  });
}

beforeEach(() => {
  __resetOrgCreatedHooksForTests();
  initAppOrgCreatedHooks.mockReset().mockImplementation(() => {});
  store.orgs.clear();
  store.owners.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  __resetOrgCreatedHooksForTests();
});

describe('orgCreatedHookKeys', () => {
  it('is empty when the app registers nothing, so createOrg writes nothing extra', () => {
    expect(orgCreatedHookKeys()).toEqual([]);
    expect(orgCreatedSettings(orgCreatedHookKeys(), 'admin')).toBeUndefined();
  });

  it('names every registered hook', () => {
    register({ 'app:provider': () => {}, 'app:package': () => {} });
    expect(orgCreatedHookKeys()).toEqual(['app:provider', 'app:package']);
  });

  it('refuses an empty key, rolling back the whole init', () => {
    // An empty key would make the owed record unreadable for every new org.
    initAppOrgCreatedHooks.mockImplementation(() => {
      registerOrgCreatedHook('app:fine', () => {});
      registerOrgCreatedHook('  ', () => {});
    });

    expect(orgCreatedHookKeys()).toEqual([]);
  });

  it('rolls back what a throwing init had already registered', () => {
    initAppOrgCreatedHooks.mockImplementation(() => {
      registerOrgCreatedHook('app:first', () => {});
      throw new Error('init broke half-way');
    });

    expect(orgCreatedHookKeys()).toEqual([]);
  });
});

describe('runOrgCreatedHooks', () => {
  it('does not read the org when no hook is registered', async () => {
    seedOrg(['app:gone']);

    await expect(runOrgCreatedHooks(ORG)).resolves.toEqual({
      succeeded: 0,
      failed: 0,
      unregistered: 0,
    });
    expect(db.org.findUnique).not.toHaveBeenCalled();
  });

  it('runs each owed hook once, in the new org, with the org and its founder', async () => {
    const seen: Array<{ ctx: OrgCreatedContext; orgInScope: string | null | undefined }> = [];
    register({
      'app:provider': (ctx) => {
        seen.push({ ctx, orgInScope: getTenantContext()?.orgId });
      },
    });
    seedOrg(['app:provider']);

    const result = await runOrgCreatedHooks(ORG, { ownerUserId: 'user-founder' });

    expect(result).toEqual({ succeeded: 1, failed: 0, unregistered: 0 });
    expect(seen).toEqual([
      {
        ctx: {
          orgId: ORG,
          slug: 'new',
          name: 'New Org',
          source: 'admin',
          ownerUserId: 'user-founder',
          retry: false,
          signal: expect.any(AbortSignal),
        },
        orgInScope: ORG,
      },
    ]);
    expect(owedNow()).toBeNull();
  });

  it('removes only its own key, leaving every other settings key as it was', async () => {
    register({ 'app:provider': () => {} });
    seedOrg(['app:provider'], { retention: { conversationDays: 30 }, forkKey: 'kept' });

    await runOrgCreatedHooks(ORG, { ownerUserId: null });

    expect(store.orgs.get(ORG)?.settings).toEqual({
      retention: { conversationDays: 30 },
      forkKey: 'kept',
    });
  });

  it('sets the column back to NULL when the owed list was all it held', async () => {
    register({ 'app:provider': () => {} });
    seedOrg(['app:provider']);

    await runOrgCreatedHooks(ORG, { ownerUserId: null });

    expect(store.orgs.get(ORG)?.settings).toBe(Prisma.DbNull);
  });

  it('keeps a failing hook owed, logs it, and still clears the ones that succeeded', async () => {
    register({
      'app:provider': () => {},
      'app:crm': () => {
        throw new Error('CRM down');
      },
    });
    seedOrg(['app:provider', 'app:crm']);

    const result = await runOrgCreatedHooks(ORG, { ownerUserId: null });

    expect(result).toEqual({ succeeded: 1, failed: 1, unregistered: 0 });
    expect(owedNow()).toEqual(['app:crm']);
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringMatching(/org-created hook failed/),
      expect.objectContaining({ hook: 'app:crm', orgId: ORG, retry: false, error: 'CRM down' })
    );
  });

  it('on a retry, runs only what is still owed, told it is a retry and who the founder is', async () => {
    const provider = vi.fn();
    const crm = vi.fn();
    register({ 'app:provider': provider, 'app:crm': crm });
    seedOrg(['app:crm'], {}, ['user-founder']);

    const result = await runOrgCreatedHooks(ORG);

    expect(result).toEqual({ succeeded: 1, failed: 0, unregistered: 0 });
    expect(provider).not.toHaveBeenCalled();
    expect(crm).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: 'user-founder', retry: true, source: 'admin' })
    );
    expect(owedNow()).toBeNull();
  });

  it('never runs a hook for an org that is not owed it (created before the hook existed)', async () => {
    const provider = vi.fn();
    register({ 'app:provider': provider });
    store.orgs.set(ORG, {
      slug: 'old',
      name: 'Old Org',
      settings: { forkKey: 'kept' },
      createdAt: LONG_AGO,
    });

    const result = await runOrgCreatedHooks(ORG);

    expect(result).toEqual({ succeeded: 0, failed: 0, unregistered: 0 });
    expect(provider).not.toHaveBeenCalled();
    expect(db.org.update).not.toHaveBeenCalled();
  });

  it('leaves owed a key this process has no hook for, so another version can run it', async () => {
    // A rolling deploy: the org owes a hook only the newer instances register.
    register({ 'app:provider': () => {} });
    seedOrg(['app:provider', 'app:only-on-new-version']);

    const result = await runOrgCreatedHooks(ORG, { ownerUserId: null });

    expect(result).toEqual({ succeeded: 1, failed: 0, unregistered: 1 });
    expect(owedNow()).toEqual(['app:only-on-new-version']);
  });

  it('does not start a run while another holds the lease, and runs once it expires', async () => {
    const provider = vi.fn();
    register({ 'app:provider': provider });
    seedOrg(['app:provider']);
    const record = (store.orgs.get(ORG)?.settings as { orgCreated: Record<string, unknown> })
      .orgCreated;
    // Another run (the create, or another instance's job) holds it.
    record.leaseUntil = new Date(Date.now() + ORG_CREATED_LEASE_MS).toISOString();

    expect(await runOrgCreatedHooks(ORG)).toEqual({ succeeded: 0, failed: 0, unregistered: 0 });
    expect(provider).not.toHaveBeenCalled();

    // That run died without releasing it: once expired, the next run takes it.
    record.leaseUntil = new Date(Date.now() - 1).toISOString();
    expect((await runOrgCreatedHooks(ORG)).succeeded).toBe(1);
  });

  it("does not free a later run's lease when it finishes after its own expired", async () => {
    // Run A stalls past its lease (here, inside its hook); run B takes the
    // expired lease meanwhile. A's clear must leave B's lease in place.
    let laterLease: string | undefined;
    register({
      'app:first': () => {
        const record = (store.orgs.get(ORG)?.settings as { orgCreated: Record<string, unknown> })
          .orgCreated;
        // Later than this run's own lease, as a run that claimed after it would be.
        laterLease = new Date(Date.now() + ORG_CREATED_LEASE_MS + 60_000).toISOString();
        record.leaseUntil = laterLease;
      },
      'app:second': () => {
        throw new Error('still failing');
      },
    });
    seedOrg(['app:first', 'app:second']);

    await runOrgCreatedHooks(ORG, { ownerUserId: null });

    expect(store.orgs.get(ORG)?.settings).toEqual({
      orgCreated: { owed: ['app:second'], source: 'admin', leaseUntil: laterLease },
    });
  });

  it('keeps fields of the record it does not know about when it clears', async () => {
    register({
      'app:crm': () => {
        throw new Error('CRM down');
      },
    });
    seedOrg(['app:crm']);
    const record = (store.orgs.get(ORG)?.settings as { orgCreated: Record<string, unknown> })
      .orgCreated;
    record.addedByNewerVersion = 1;

    await runOrgCreatedHooks(ORG, { ownerUserId: null });

    expect(store.orgs.get(ORG)?.settings).toEqual({
      orgCreated: { owed: ['app:crm'], source: 'admin', addedByNewerVersion: 1 },
    });
  });

  it('warns and runs nothing when the owed record is one this version cannot read', async () => {
    const provider = vi.fn();
    register({ 'app:provider': provider });
    store.orgs.set(ORG, {
      slug: 'new',
      name: 'New Org',
      settings: { orgCreated: { owed: ['app:provider'], source: 'import-from-newer' } },
      createdAt: LONG_AGO,
    });

    await expect(runOrgCreatedHooks(ORG)).resolves.toEqual({
      succeeded: 0,
      failed: 0,
      unregistered: 0,
    });
    expect(provider).not.toHaveBeenCalled();
    expect(loggerWarn).toHaveBeenCalledWith(expect.stringMatching(/unreadable by this version/), {
      orgId: ORG,
    });
  });

  it('releases the lease when it records what happened, even when every hook failed', async () => {
    register({
      'app:crm': () => {
        throw new Error('CRM down');
      },
    });
    seedOrg(['app:crm']);

    await runOrgCreatedHooks(ORG, { ownerUserId: null });

    expect(store.orgs.get(ORG)?.settings).toEqual({
      orgCreated: { owed: ['app:crm'], source: 'admin' },
    });
    // So the next tick can take it at once, not after the lease runs out.
    expect((await runOrgCreatedHooks(ORG)).failed).toBe(1);
  });

  it('cuts the last hook to what is left of the run budget, leaving the rest owed', async () => {
    vi.useFakeTimers();
    try {
      // Four hooks use all but 4 ms of the budget; the fifth gets only those
      // 4 ms (not its own 10 s), times out, and the sixth is never started.
      const step = ORG_CREATED_RUN_BUDGET_MS / 4 - 1;
      const hook = () => new Promise<void>((resolve) => setTimeout(resolve, step));
      const keys = ['app:h0', 'app:h1', 'app:h2', 'app:h3', 'app:h4', 'app:h5'];
      register(Object.fromEntries(keys.map((key) => [key, hook])));
      seedOrg(keys);

      const run = runOrgCreatedHooks(ORG, { ownerUserId: null });
      await vi.advanceTimersByTimeAsync(ORG_CREATED_RUN_BUDGET_MS);
      const result = await run;

      expect(result).toEqual({ succeeded: 4, failed: 2, unregistered: 0 });
      expect(owedNow()).toEqual(['app:h4', 'app:h5']);
      expect(loggerError).toHaveBeenCalledWith(
        expect.stringMatching(/org-created hook failed/),
        expect.objectContaining({ hook: 'app:h4', error: expect.stringMatching(/after 4 ms/) })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs hooks one at a time, in registration order, not owed-list order', async () => {
    const events: string[] = [];
    const slow = (name: string) => async () => {
      events.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push(`${name}:end`);
    };
    register({ 'app:first': slow('first'), 'app:second': slow('second') });
    seedOrg(['app:second', 'app:first']);

    await runOrgCreatedHooks(ORG, { ownerUserId: null });

    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('gives up on a hook past its time limit, aborts its signal, and leaves it and the rest owed', async () => {
    vi.useFakeTimers();
    try {
      let seenSignal: AbortSignal | undefined;
      const next = vi.fn();
      initAppOrgCreatedHooks.mockImplementation(() => {
        registerOrgCreatedHook('app:hangs', ({ signal }) => {
          seenSignal = signal;
          return new Promise<void>(() => {});
        });
        registerOrgCreatedHook('app:next', next);
      });
      seedOrg(['app:hangs', 'app:next']);

      const run = runOrgCreatedHooks(ORG, { ownerUserId: null });
      await vi.advanceTimersByTimeAsync(ORG_CREATED_HOOK_TIMEOUT_MS);
      const result = await run;

      // The hung hook may still be running, so the next is not started beside it.
      expect(result).toEqual({ succeeded: 0, failed: 2, unregistered: 0 });
      expect(seenSignal?.aborted).toBe(true);
      expect(next).not.toHaveBeenCalled();
      expect(owedNow()).toEqual(['app:hangs', 'app:next']);
      // The hung hook may still be running, so its lease is kept until it
      // expires: no other run may start the same hooks beside it.
      expect(
        (store.orgs.get(ORG)?.settings as { orgCreated: { leaseUntil?: string } }).orgCreated
          .leaseUntil
      ).toEqual(expect.any(String));
      expect((await runOrgCreatedHooks(ORG)).failed).toBe(0);
      expect(loggerError).toHaveBeenCalledWith(
        expect.stringMatching(/org-created hook failed/),
        expect.objectContaining({ hook: 'app:hangs', error: expect.stringMatching(/timed out/) })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the hooks owed when their success cannot be recorded, so they run again', async () => {
    register({ 'app:provider': () => {} });
    seedOrg(['app:provider']);
    db.org.update.mockRejectedValueOnce(new Error('could not serialize access'));

    const result = await runOrgCreatedHooks(ORG, { ownerUserId: null });

    expect(result.succeeded).toBe(1);
    expect(owedNow()).toEqual(['app:provider']);
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringMatching(/could not record/),
      expect.objectContaining({ hooks: ['app:provider'] })
    );
  });

  it('logs a readable reason when a hook throws something that is not an Error', async () => {
    initAppOrgCreatedHooks.mockImplementation(() => {
      registerOrgCreatedHook('app:crm', () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- the case under test
        throw 'CRM said no';
      });
    });
    seedOrg(['app:crm']);

    await runOrgCreatedHooks(ORG, { ownerUserId: null });

    expect(loggerError).toHaveBeenCalledWith(
      expect.stringMatching(/org-created hook failed/),
      expect.objectContaining({ error: 'CRM said no' })
    );
    expect(owedNow()).toEqual(['app:crm']);
  });

  it('runs nothing for an org that no longer exists', async () => {
    const provider = vi.fn();
    register({ 'app:provider': provider });

    await expect(runOrgCreatedHooks('org-gone')).resolves.toEqual({
      succeeded: 0,
      failed: 0,
      unregistered: 0,
    });
    expect(provider).not.toHaveBeenCalled();
  });

  it('passes no founder on a retry for an org with no OWNER', async () => {
    const provider = vi.fn();
    register({ 'app:provider': provider });
    seedOrg(['app:provider'], {}, []);

    await runOrgCreatedHooks(ORG);

    expect(provider).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: null }));
  });

  it('logs a readable reason when recording the successes fails with a non-Error', async () => {
    register({ 'app:provider': () => {} });
    seedOrg(['app:provider']);
    db.org.update.mockRejectedValueOnce('serialization failure');

    await runOrgCreatedHooks(ORG, { ownerUserId: null });

    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringMatching(/could not record/),
      expect.objectContaining({ error: 'serialization failure' })
    );
  });

  it('never throws when the org cannot be read, even for a non-Error', async () => {
    register({ 'app:provider': () => {} });
    seedOrg(['app:provider']);
    db.org.findUnique.mockRejectedValueOnce('socket hang up');

    await runOrgCreatedHooks(ORG);

    expect(loggerError).toHaveBeenCalledWith(
      expect.stringMatching(/could not be run/),
      expect.objectContaining({ error: 'socket hang up' })
    );
  });

  it('never throws when the org cannot be read', async () => {
    register({ 'app:provider': () => {} });
    seedOrg(['app:provider']);
    db.org.findUnique.mockRejectedValueOnce(new Error('connection reset'));

    await expect(runOrgCreatedHooks(ORG)).resolves.toEqual({
      succeeded: 0,
      failed: 0,
      unregistered: 0,
    });
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringMatching(/could not be run/),
      expect.objectContaining({ orgId: ORG, error: 'connection reset' })
    );
  });
});

describe('retryOwedOrgCreatedHooks', () => {
  it('makes no query when no hook is registered', async () => {
    seedOrg(['app:gone']);

    await expect(retryOwedOrgCreatedHooks()).resolves.toEqual({
      orgs: 0,
      succeeded: 0,
      failed: 0,
    });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('runs the owed hooks of each ACTIVE org that owes some, each in its own scope', async () => {
    const seen: Array<{ orgId: string; inScope: string | null | undefined }> = [];
    register({
      'app:provider': (ctx) => {
        seen.push({ orgId: ctx.orgId, inScope: getTenantContext()?.orgId });
      },
    });
    const owed = orgCreatedSettings(['app:provider'], 'admin');
    store.orgs.set('org-a', {
      slug: 'a',
      name: 'A',
      settings: structuredClone(owed),
      createdAt: LONG_AGO,
    });
    store.orgs.set('org-b', {
      slug: 'b',
      name: 'B',
      settings: structuredClone(owed),
      createdAt: LONG_AGO,
    });
    store.orgs.set('org-suspended', {
      slug: 's',
      name: 'S',
      settings: structuredClone(owed),
      createdAt: LONG_AGO,
      status: 'SUSPENDED',
    });
    store.orgs.set('org-done', { slug: 'd', name: 'D', settings: null, createdAt: LONG_AGO });
    // Owes only a key nothing registers any more: not selected at all.
    store.orgs.set('org-stale', {
      slug: 'x',
      name: 'X',
      settings: orgCreatedSettings(['app:renamed-away'], 'admin'),
      createdAt: LONG_AGO,
    });

    const result = await retryOwedOrgCreatedHooks();

    expect(result).toEqual({ orgs: 2, succeeded: 2, failed: 0 });
    expect(db.$queryRaw).toHaveBeenCalledTimes(1 + 2); // the select, then one claim per org
    expect(seen.map((s) => s.orgId).sort()).toEqual(['org-a', 'org-b']);
    for (const s of seen) expect(s.inScope).toBe(s.orgId);
    expect(readOrgCreatedOwed(store.orgs.get('org-suspended')?.settings)?.owed).toEqual([
      'app:provider',
    ]);
  });

  it('starts no further org once the tick budget is spent', async () => {
    vi.useFakeTimers();
    try {
      // Each org's hook hangs until its own limit, so each org takes exactly
      // ORG_CREATED_HOOK_TIMEOUT_MS and the tick has room for budget/limit.
      const ran: string[] = [];
      register({
        'app:hangs': (ctx) => {
          ran.push(ctx.orgId);
          return new Promise<void>(() => {});
        },
      });
      const owed = orgCreatedSettings(['app:hangs'], 'admin');
      const ids = Array.from({ length: 8 }, (_, n) => `org-${n}`);
      for (const id of ids) {
        store.orgs.set(id, {
          slug: id,
          name: id,
          settings: structuredClone(owed),
          createdAt: LONG_AGO,
        });
      }

      const run = retryOwedOrgCreatedHooks();
      await vi.advanceTimersByTimeAsync(ORG_CREATED_JOB_BUDGET_MS * 2);
      const result = await run;

      const fits = ORG_CREATED_JOB_BUDGET_MS / ORG_CREATED_HOOK_TIMEOUT_MS;
      expect(fits).toBeLessThan(ids.length);
      expect(ran).toHaveLength(fits);
      expect(result).toEqual({ orgs: fits, succeeded: 0, failed: fits });
    } finally {
      vi.useRealTimers();
    }
  });
});
