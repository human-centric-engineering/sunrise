/**
 * Tests: org onboarding (§134 t-1063)
 *
 * - The mark: only an org created with `awaitingOnboarding: true` reads as
 *   unfinished; a missing key (the install org, every org that predates the
 *   key) reads as finished, and so does any value that is not literally `true`.
 * - Marking it done removes that key and nothing else, and is idempotent.
 * - The proxy's question, {@link welcomeRedirectFor}: only a member of the
 *   org the request acts for, only on the landing route, only while unfinished.
 *
 * The settings write runs the real `writeSettingsSlice` over a one-row
 * transaction double, so the assertions are on what is stored.
 *
 * @see lib/tenancy/onboarding.ts · lib/tenancy/org-settings.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import type { NextRequest } from 'next/server';

const mockLogger = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({ logger: mockLogger }));

const mockGetSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: mockGetSession } } }));

const mockOrgFind = vi.hoisted(() => vi.fn());
const mockMembershipFind = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db/client', () => ({
  prisma: {
    org: { findUnique: mockOrgFind },
    orgMembership: { findUnique: mockMembershipFind },
  },
}));

const mockIsMulti = vi.hoisted(() => vi.fn(() => true));
vi.mock('@/lib/tenancy/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tenancy/context')>()),
  isMultiTenant: mockIsMulti,
}));

vi.mock('@/lib/app/welcome', () => ({ appWelcomeRoute: '/welcome' }));

import { isOrgOnboarded, markOrgOnboarded, welcomeRedirectFor } from '@/lib/tenancy/onboarding';
import { ORG_AWAITING_ONBOARDING_KEY, readOrgOnboarded } from '@/lib/tenancy/org-settings';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const ORG = 'org_acme';
const USER = 'user_ada';

/** One org row whose `settings` the transaction double reads and writes. */
function orgStore(initial: unknown) {
  const row = { settings: initial };
  const tx = {
    org: {
      findUnique: vi.fn(async () => (row.settings === undefined ? null : { ...row })),
      update: vi.fn(async ({ data }: { data: { settings: unknown } }) => {
        row.settings = data.settings === Prisma.DbNull ? null : data.settings;
      }),
    },
  };
  const $transaction = vi.fn(async (fn: (t: typeof tx) => Promise<unknown>, _opts?: unknown) =>
    fn(tx)
  );
  const db = {
    $transaction,
    org: { findUnique: tx.org.findUnique },
  };
  return { row, tx, db: db as never, $transaction };
}

function conflict(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('clash', { code: 'P2034', clientVersion: 't' });
}

function requestFor(pathname: string): NextRequest {
  return {
    nextUrl: new URL(`http://localhost:3000${pathname}`),
    headers: new Headers({ cookie: 'better-auth.session_token=x' }),
  } as unknown as NextRequest;
}

function signedIn(activeOrgId: string | null = ORG): void {
  mockGetSession.mockResolvedValue({ user: { id: USER }, session: { activeOrgId } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsMulti.mockReturnValue(true);
});

describe('readOrgOnboarded', () => {
  it('reads only a literal true under the key as unfinished', () => {
    expect(ORG_AWAITING_ONBOARDING_KEY).toBe('awaitingOnboarding');
    expect(readOrgOnboarded({ awaitingOnboarding: true })).toBe(false);
    expect(readOrgOnboarded({ awaitingOnboarding: true, branding: { logo: 'x' } })).toBe(false);
  });

  it.each([
    ['no settings at all (the install org, an org that predates the key)', null],
    ['settings without the key', { retention: { costLogRetentionDays: 90 } }],
    ['the key set false', { awaitingOnboarding: false }],
    ['the key set to the string "true"', { awaitingOnboarding: 'true' }],
    ['a column that is not an object', ['awaitingOnboarding']],
  ])('reads %s as finished', (_label, settings) => {
    expect(readOrgOnboarded(settings)).toBe(true);
  });
});

describe('isOrgOnboarded', () => {
  it('answers the install org as finished without reading it', async () => {
    const { db } = orgStore({ awaitingOnboarding: true });
    expect(await isOrgOnboarded(INSTALL_ORG_ID, db)).toBe(true);
    expect(mockOrgFind).not.toHaveBeenCalled();
  });

  it('answers null for an org that does not exist', async () => {
    const { db } = orgStore(undefined);
    expect(await isOrgOnboarded('gone', db)).toBeNull();
  });

  it('reads a new org as unfinished until it is marked, then as finished', async () => {
    // The settings lifecycle.ts writes in the INSERT of a new org.
    const { db, row } = orgStore({
      orgCreated: { owed: ['app:x'], source: 'admin' },
      awaitingOnboarding: true,
    });

    expect(await isOrgOnboarded(ORG, db)).toBe(false);
    expect(await markOrgOnboarded(ORG, db)).toBe('marked');
    expect(await isOrgOnboarded(ORG, db)).toBe(true);
    // Only the mark went; the org-created slice beside it was kept.
    expect(row.settings).toEqual({ orgCreated: { owed: ['app:x'], source: 'admin' } });
  });
});

describe('markOrgOnboarded', () => {
  it('writes in a serializable transaction', async () => {
    const { db, $transaction } = orgStore({ awaitingOnboarding: true });
    await markOrgOnboarded(ORG, db);
    expect($transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  });

  it('sets the column back to NULL when the mark was its only key', async () => {
    const { db, tx, row } = orgStore({ awaitingOnboarding: true });
    expect(await markOrgOnboarded(ORG, db)).toBe('marked');
    expect(tx.org.update).toHaveBeenCalledWith({
      where: { id: ORG },
      data: { settings: Prisma.DbNull },
    });
    expect(row.settings).toBeNull();
    expect(mockLogger.info).toHaveBeenCalledWith('Org onboarding marked finished', { orgId: ORG });
  });

  it('leaves an org that is already finished untouched', async () => {
    const { db, tx } = orgStore({ branding: { logo: 'x' } });
    expect(await markOrgOnboarded(ORG, db)).toBe('already-finished');
    expect(tx.org.update).not.toHaveBeenCalled();
  });

  it('answers no-such-org for an org that does not exist', async () => {
    const { db } = orgStore(undefined);
    expect(await markOrgOnboarded('gone', db)).toBe('no-such-org');
  });

  it('never writes the install org', async () => {
    const { db, $transaction } = orgStore({ awaitingOnboarding: true });
    expect(await markOrgOnboarded(INSTALL_ORG_ID, db)).toBe('already-finished');
    expect($transaction).not.toHaveBeenCalled();
  });

  it('tries again after a clash with another settings write', async () => {
    const store = orgStore({ awaitingOnboarding: true });
    const real = store.$transaction.getMockImplementation()!;
    store.$transaction.mockRejectedValueOnce(conflict()).mockImplementation(real);

    expect(await markOrgOnboarded(ORG, store.db)).toBe('marked');
    expect(store.$transaction).toHaveBeenCalledTimes(2);
    expect(store.row.settings).toBeNull();
  });

  it('throws the clash after three attempts', async () => {
    const store = orgStore({ awaitingOnboarding: true });
    store.$transaction.mockRejectedValue(conflict());

    await expect(markOrgOnboarded(ORG, store.db)).rejects.toMatchObject({ code: 'P2034' });
    expect(store.$transaction).toHaveBeenCalledTimes(3);
  });

  it('throws any other failure at once', async () => {
    const store = orgStore({ awaitingOnboarding: true });
    store.$transaction.mockRejectedValue(new Error('connection reset'));

    await expect(markOrgOnboarded(ORG, store.db)).rejects.toThrow('connection reset');
    expect(store.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('welcomeRedirectFor (welcome route set)', () => {
  function memberOf(settings: unknown): void {
    mockMembershipFind.mockResolvedValue({ org: { settings } });
  }

  it('sends a member of an unfinished org on the landing route to the welcome route', async () => {
    signedIn();
    memberOf({ awaitingOnboarding: true });

    expect(await welcomeRedirectFor(requestFor('/dashboard'), null)).toBe('/welcome');
    expect(mockMembershipFind).toHaveBeenCalledWith({
      where: { orgId_userId: { orgId: ORG, userId: USER } },
      select: { org: { select: { settings: true } } },
    });
  });

  it('treats the landing route with a trailing slash as the landing route', async () => {
    signedIn();
    memberOf({ awaitingOnboarding: true });

    expect(await welcomeRedirectFor(requestFor('/dashboard/'), null)).toBe('/welcome');
  });

  it('lets a member of a finished org through', async () => {
    signedIn();
    memberOf({ retention: {} });

    expect(await welcomeRedirectFor(requestFor('/dashboard'), null)).toBeNull();
  });

  it('lets someone who is not a member through, platform staff included', async () => {
    signedIn();
    mockMembershipFind.mockResolvedValue(null);

    expect(await welcomeRedirectFor(requestFor('/dashboard'), null)).toBeNull();
  });

  it('asks about the org the tenant resolver names before the session’s', async () => {
    signedIn('org_session');
    memberOf({ awaitingOnboarding: true });

    expect(await welcomeRedirectFor(requestFor('/dashboard'), 'org_header')).toBe('/welcome');
    expect(mockMembershipFind).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orgId_userId: { orgId: 'org_header', userId: USER } },
      })
    );
  });

  it('reads nothing off the landing route', async () => {
    signedIn();
    memberOf({ awaitingOnboarding: true });

    expect(await welcomeRedirectFor(requestFor('/settings'), null)).toBeNull();
    expect(await welcomeRedirectFor(requestFor('/dashboard/reports'), null)).toBeNull();
    expect(await welcomeRedirectFor(requestFor('/welcome'), null)).toBeNull();
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it('lets a request with no session through', async () => {
    mockGetSession.mockResolvedValue(null);

    expect(await welcomeRedirectFor(requestFor('/dashboard'), null)).toBeNull();
    expect(mockMembershipFind).not.toHaveBeenCalled();
  });

  it('reads no membership for the install org at single', async () => {
    mockIsMulti.mockReturnValue(false);
    signedIn(null);

    expect(await welcomeRedirectFor(requestFor('/dashboard'), null)).toBeNull();
    expect(mockMembershipFind).not.toHaveBeenCalled();
  });

  it('reads no membership at multi when the session acts in no org', async () => {
    signedIn(null);

    expect(await welcomeRedirectFor(requestFor('/dashboard'), null)).toBeNull();
    expect(mockMembershipFind).not.toHaveBeenCalled();
  });

  it('lets the request through, logged at warn, when the read fails', async () => {
    signedIn();
    mockMembershipFind.mockRejectedValue(new Error('db down'));

    expect(await welcomeRedirectFor(requestFor('/dashboard'), null)).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Could not read org onboarding for the landing route; letting the request through',
      { error: 'db down' }
    );
  });
});

describe('welcomeRedirectFor (no welcome route set)', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doMock('@/lib/app/welcome', () => ({ appWelcomeRoute: '/welcome' }));
  });

  it('reads nothing and redirects nobody', async () => {
    vi.resetModules();
    vi.doMock('@/lib/app/welcome', () => ({ appWelcomeRoute: null }));
    const fresh = await import('@/lib/tenancy/onboarding');
    signedIn();
    mockMembershipFind.mockResolvedValue({ org: { settings: { awaitingOnboarding: true } } });

    expect(await fresh.welcomeRedirectFor(requestFor('/dashboard'), null)).toBeNull();
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockMembershipFind).not.toHaveBeenCalled();
  });
});
