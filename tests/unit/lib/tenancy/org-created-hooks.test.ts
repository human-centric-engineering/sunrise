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
  orgs: new Map<string, { slug: string; name: string; settings: unknown }>(),
  owners: new Map<string, string[]>(),
}));

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
  };
  return client;
});
vi.mock('@/lib/db/client', () => ({ prisma: db }));

import {
  registerOrgCreatedHook,
  runOrgCreatedHooks,
  orgCreatedHookKeys,
  __resetOrgCreatedHooksForTests,
  type OrgCreatedContext,
} from '@/lib/tenancy/org-created-hooks';
import { orgCreatedSettings, readOrgCreatedOwed } from '@/lib/tenancy/org-settings';
import { getTenantContext } from '@/lib/tenancy/context';

const ORG = 'org-new';

/** An org as `createOrg()` leaves it: created with the hooks it is owed. */
function seedOrg(owed: string[], extra: Record<string, unknown> = {}, owners: string[] = []) {
  const settings = { ...extra, ...(orgCreatedSettings(owed, 'admin') ?? {}) };
  store.orgs.set(ORG, { slug: 'new', name: 'New Org', settings });
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
      dropped: 0,
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

    expect(result).toEqual({ succeeded: 1, failed: 0, dropped: 0 });
    expect(seen).toEqual([
      {
        ctx: {
          orgId: ORG,
          slug: 'new',
          name: 'New Org',
          source: 'admin',
          ownerUserId: 'user-founder',
          retry: false,
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

    expect(result).toEqual({ succeeded: 1, failed: 1, dropped: 0 });
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

    expect(result).toEqual({ succeeded: 1, failed: 0, dropped: 0 });
    expect(provider).not.toHaveBeenCalled();
    expect(crm).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: 'user-founder', retry: true, source: 'admin' })
    );
    expect(owedNow()).toBeNull();
  });

  it('never runs a hook for an org that is not owed it (created before the hook existed)', async () => {
    const provider = vi.fn();
    register({ 'app:provider': provider });
    store.orgs.set(ORG, { slug: 'old', name: 'Old Org', settings: { forkKey: 'kept' } });

    const result = await runOrgCreatedHooks(ORG);

    expect(result).toEqual({ succeeded: 0, failed: 0, dropped: 0 });
    expect(provider).not.toHaveBeenCalled();
    expect(db.org.update).not.toHaveBeenCalled();
  });

  it('drops an owed key whose hook is no longer registered, with a warning', async () => {
    register({ 'app:provider': () => {} });
    seedOrg(['app:provider', 'app:renamed-away']);

    const result = await runOrgCreatedHooks(ORG, { ownerUserId: null });

    expect(result).toEqual({ succeeded: 1, failed: 0, dropped: 1 });
    expect(owedNow()).toBeNull();
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringMatching(/no longer registered/),
      expect.objectContaining({ hooks: ['app:renamed-away'] })
    );
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

  it('never throws when the org cannot be read', async () => {
    register({ 'app:provider': () => {} });
    db.org.findUnique.mockRejectedValueOnce(new Error('connection reset'));

    await expect(runOrgCreatedHooks(ORG)).resolves.toEqual({
      succeeded: 0,
      failed: 0,
      dropped: 0,
    });
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringMatching(/could not be run/),
      expect.objectContaining({ orgId: ORG, error: 'connection reset' })
    );
  });
});
