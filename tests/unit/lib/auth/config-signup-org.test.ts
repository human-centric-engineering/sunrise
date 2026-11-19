/**
 * Tests: where a self-serve signup lands, through the signup hooks
 * (§134 t-1062, sunrise#1232).
 *
 * Drives the real `userCreateBeforeHook`, `sessionCreateBeforeHook` and
 * `userCreateAfterHook` in the order better-auth runs them, with the request
 * state between them played by a one-signup carrier, so what the before hook
 * decides is what the first session starts in and what the after hook writes.
 * The decision itself (`lib/tenancy/signup-org.ts`) is real; only the org's
 * creation and its deferred setup are mocked at `lib/tenancy/lifecycle.ts`,
 * whose own tests cover what they write.
 *
 * - At `multi`, an uninvited signup (email and OAuth) and one let in from the
 *   install org's waitlist found an org of their own, as OWNER, start their
 *   first session there, and get no install-org membership.
 * - Invited signups, an org's own waitlist and the first human are never
 *   asked; at `single` nothing changes, field for field.
 * - An app's resolver replaces the default, and a fault in it falls back.
 * - The after hook runs the new org's deferred setup once the founder is in
 *   it, and only then.
 *
 * @see lib/auth/config.ts
 * @see lib/tenancy/signup-org.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserCreateData, SessionCreateData } from '@/lib/auth/config';
import type { PendingSignup } from '@/lib/auth/pending-signup';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { DEFAULT_ORG_ROLE, ORG_OWNER_ROLE } from '@/lib/tenancy/roles';

const NEW_ORG = 'cmorg00000000000000signup';
const CUSTOMER_ORG = 'cmorg0000000000000customer';

// One signup's request state: what the before hook records, the session hook
// and the after hook read.
const carrier = vi.hoisted(() => ({ pending: null as PendingSignup | null }));
vi.mock('@/lib/auth/pending-signup', () => ({
  setPendingSignup: vi.fn(async (pending: PendingSignup) => {
    carrier.pending = pending;
  }),
  getPendingSignup: vi.fn(async () => carrier.pending),
  setInvitationAccepted: vi.fn(),
  wasInvitationAccepted: vi.fn(async () => false),
  getRedeemedInvitation: vi.fn(async () => null),
}));

const mockEnv = vi.hoisted(() => ({
  TENANCY_MODE: 'multi',
  REQUIRE_EMAIL_VERIFICATION: true,
  NODE_ENV: 'test',
  BETTER_AUTH_URL: 'http://localhost:3000',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
}));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

vi.mock('better-auth', () => ({ betterAuth: vi.fn(() => ({ api: {}, handler: vi.fn() })) }));
vi.mock('better-auth/adapters/prisma', () => ({ prismaAdapter: vi.fn(() => ({})) }));
vi.mock('better-auth/api', () => ({
  getOAuthState: vi.fn(async () => ({})),
  createAuthMiddleware: vi.fn((fn: unknown) => fn),
  APIError: class APIError extends Error {
    constructor(status: string, body: { message?: string } = {}) {
      super(body.message ?? status);
    }
  },
}));
vi.mock('@/lib/email/send', () => ({ sendEmail: vi.fn(async () => undefined) }));
vi.mock('@/lib/email/client', () => ({ validateEmailConfig: vi.fn() }));
vi.mock('@/lib/email/registry', () => ({ resolveEmailTemplate: vi.fn(() => null) }));
vi.mock('@/lib/waitlist/link', () => ({ linkWaitlistEntryToAccount: vi.fn() }));
vi.mock('@/lib/utils/invitation-token', () => ({
  validateInvitationToken: vi.fn(),
  consumeInvitation: vi.fn(),
  findInvitationByToken: vi.fn(),
}));

const db = vi.hoisted(() => ({
  user: {
    update: vi.fn(),
    count: vi.fn(),
    // The first-owner bootstrap asks an invitation's issuer's standing, and
    // the session hook asks whether an erasure is pending.
    findUnique: vi.fn(async () => ({ role: 'ADMIN', orgMemberships: [] })),
  },
  authBootstrap: { findUnique: vi.fn(), upsert: vi.fn() },
  org: { findUnique: vi.fn() },
  orgMembership: { upsert: vi.fn(), count: vi.fn(), findMany: vi.fn() },
  $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  // The awaiting-founder clear: 1 when the membership's org carried the mark.
  $executeRaw: vi.fn(),
}));
vi.mock('@/lib/db/client', () => ({ prisma: db }));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockCreateSignupOrg = vi.hoisted(() => vi.fn());
const mockCompleteSignupOrg = vi.hoisted(() => vi.fn());
vi.mock('@/lib/tenancy/lifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tenancy/lifecycle')>()),
  createSignupOrg: mockCreateSignupOrg,
  completeSignupOrg: mockCompleteSignupOrg,
}));

import {
  userCreateBeforeHook,
  userCreateAfterHook,
  sessionCreateBeforeHook,
} from '@/lib/auth/config';
import { runInvitedSignup } from '@/lib/auth/signup-mode';
import {
  registerSignupOrgResolver,
  __resetSignupOrgResolverForTests,
} from '@/lib/tenancy/signup-org';
import { logger } from '@/lib/logging';

const EMAIL_PATH = { path: '/sign-up/email' };
const OAUTH_PATH = { path: '/callback/google' };

function newUser(over: Partial<UserCreateData> = {}): UserCreateData {
  return {
    id: 'cmuser0000000000000signup',
    email: 'ada@example.com',
    name: 'Ada Lovelace',
    emailVerified: false,
    role: 'USER',
    createdAt: new Date('2026-11-19'),
    updatedAt: new Date('2026-11-19'),
    ...over,
  };
}

function session(userId: string): SessionCreateData {
  return {
    userId,
    token: 't',
    expiresAt: new Date('2026-12-19'),
    createdAt: new Date('2026-11-19'),
    updatedAt: new Date('2026-11-19'),
  };
}

/** The before hook, then the session hook (inside the sign-up transaction), then the after hook. */
async function signUp(
  user: UserCreateData,
  ctx: { path: string },
  wrap: (run: () => Promise<{ data: UserCreateData }>) => Promise<{ data: UserCreateData }> = (
    run
  ) => run()
): Promise<{ row: UserCreateData; activeOrgId: string | null }> {
  const { data: row } = await wrap(() => userCreateBeforeHook(user, ctx));
  const { data } = await sessionCreateBeforeHook(session(row.id), ctx);
  await userCreateAfterHook(row, ctx);
  return { row, activeOrgId: data.activeOrgId };
}

/** The memberships the after hook wrote, as `(orgId, role)`. */
function membershipsWritten(): Array<{ orgId: string; role: string }> {
  return db.orgMembership.upsert.mock.calls.map(
    ([args]) => (args as { create: { orgId: string; role: string } }).create
  );
}

const waitlistInvitation = (orgId?: string) => ({
  name: 'Ada',
  role: 'USER',
  invitedBy: 'cmuser000000000000admin01',
  invitedAt: '2026-11-19T00:00:00.000Z',
  ...(orgId ? { orgId } : {}),
  waitlistEntryId: 'cmwait00000000000000entry',
});

beforeEach(() => {
  vi.clearAllMocks();
  carrier.pending = null;
  mockEnv.TENANCY_MODE = 'multi';
  __resetSignupOrgResolverForTests();
  // Humans exist already: no first-human bootstrap.
  db.authBootstrap.findUnique.mockResolvedValue({ id: 'singleton' });
  db.user.update.mockResolvedValue({});
  db.orgMembership.upsert.mockResolvedValue({});
  db.orgMembership.count.mockResolvedValue(1);
  db.org.findUnique.mockResolvedValue(null);
  db.$executeRaw.mockResolvedValue(0);
  mockCreateSignupOrg.mockResolvedValue({ id: NEW_ORG, slug: 'ada-1', name: 'x' });
  mockCompleteSignupOrg.mockResolvedValue(undefined);
});

describe('at multi, a self-serve signup founds an org of their own (#1232)', () => {
  it.each([
    ['an email signup', EMAIL_PATH],
    ['an OAuth signup', OAUTH_PATH],
  ])(
    '%s with no invitation: OWNER of a new org, first session there, no install-org membership',
    async (_label, ctx) => {
      // The founder's membership write removes the new org's mark.
      db.$executeRaw.mockResolvedValue(1);
      const user = newUser();

      const { row, activeOrgId } = await signUp(user, ctx);

      expect(mockCreateSignupOrg).toHaveBeenCalledTimes(1);
      // Recorded on the row, as every decision is (t-838).
      expect(row).toEqual({ ...user, signupOrgId: NEW_ORG, signupOrgRole: ORG_OWNER_ROLE });
      expect(activeOrgId).toBe(NEW_ORG);
      expect(membershipsWritten()).toEqual([
        { orgId: NEW_ORG, userId: user.id, role: ORG_OWNER_ROLE },
      ]);
      expect(membershipsWritten().some((m) => m.orgId === INSTALL_ORG_ID)).toBe(false);
      // Its app setup and platform agents waited for the founder.
      expect(mockCompleteSignupOrg).toHaveBeenCalledWith(NEW_ORG, user.id);
    }
  );

  it('someone let in from the install org’s waitlist lands the same way', async () => {
    db.$executeRaw.mockResolvedValue(1);
    const user = newUser();

    const { row, activeOrgId } = await signUp(user, EMAIL_PATH, (run) =>
      runInvitedSignup(run, waitlistInvitation())
    );

    expect(row.signupOrgId).toBe(NEW_ORG);
    expect(row.signupOrgRole).toBe(ORG_OWNER_ROLE);
    expect(activeOrgId).toBe(NEW_ORG);
    expect(membershipsWritten()).toEqual([
      { orgId: NEW_ORG, userId: user.id, role: ORG_OWNER_ROLE },
    ]);
  });

  it('runs no deferred setup when the membership written was not a signup org’s', async () => {
    registerSignupOrgResolver(() => ({ kind: 'join', orgId: CUSTOMER_ORG }));
    db.org.findUnique.mockResolvedValue({ id: CUSTOMER_ORG });

    await signUp(newUser(), EMAIL_PATH);

    expect(mockCompleteSignupOrg).not.toHaveBeenCalled();
  });

  it('runs no deferred setup when the membership write fails; the record is left for the sign-in heal', async () => {
    db.$executeRaw.mockResolvedValue(1);
    db.orgMembership.upsert.mockRejectedValue(new Error('connection reset'));

    const { row } = await signUp(newUser(), EMAIL_PATH);

    expect(row.signupOrgId).toBe(NEW_ORG);
    expect(mockCompleteSignupOrg).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to create org membership for new user',
      expect.any(Error),
      expect.any(Object)
    );
  });
});

describe('at multi, who is never asked', () => {
  it('an org’s own waitlist invitation lands in that org, as before', async () => {
    const user = newUser();

    const { row } = await signUp(user, EMAIL_PATH, (run) =>
      runInvitedSignup(run, waitlistInvitation(CUSTOMER_ORG))
    );

    expect(mockCreateSignupOrg).not.toHaveBeenCalled();
    expect(row.signupOrgId).toBe(CUSTOMER_ORG);
  });

  it('an invitation into the install org (not from its waitlist) lands there, as before', async () => {
    const user = newUser();
    const { waitlistEntryId: _dropped, ...adminInvitation } = waitlistInvitation();

    const { row } = await signUp(user, EMAIL_PATH, (run) => runInvitedSignup(run, adminInvitation));

    expect(mockCreateSignupOrg).not.toHaveBeenCalled();
    expect(row).toEqual({ ...user, signupOrgId: INSTALL_ORG_ID, signupOrgRole: DEFAULT_ORG_ROLE });
  });

  it('an invitation into another org lands there, as before', async () => {
    const user = newUser();
    const { waitlistEntryId: _dropped, ...invitation } = waitlistInvitation(CUSTOMER_ORG);

    const { row } = await signUp(user, EMAIL_PATH, (run) => runInvitedSignup(run, invitation));

    expect(mockCreateSignupOrg).not.toHaveBeenCalled();
    expect(row.signupOrgId).toBe(CUSTOMER_ORG);
  });

  it('the first human on a fresh database: OWNER of the install org, not asked', async () => {
    db.authBootstrap.findUnique.mockResolvedValue(null);
    db.user.count.mockResolvedValue(0);
    const resolver = vi.fn(() => ({ kind: 'own' as const }));
    registerSignupOrgResolver(resolver);

    const { row } = await signUp(newUser(), EMAIL_PATH);

    expect(resolver).not.toHaveBeenCalled();
    expect(mockCreateSignupOrg).not.toHaveBeenCalled();
    expect(row.signupOrgId).toBe(INSTALL_ORG_ID);
    expect(row.signupOrgRole).toBe(ORG_OWNER_ROLE);
  });
});

describe('an app’s resolver, through the hooks', () => {
  it('joining an existing org: the membership, the row and the first session all name it', async () => {
    registerSignupOrgResolver(({ email }) =>
      email.endsWith('@example.com') ? { kind: 'join', orgId: CUSTOMER_ORG } : { kind: 'own' }
    );
    db.org.findUnique.mockResolvedValue({ id: CUSTOMER_ORG });
    const user = newUser();

    const { row, activeOrgId } = await signUp(user, EMAIL_PATH);

    expect(row).toEqual({ ...user, signupOrgId: CUSTOMER_ORG, signupOrgRole: DEFAULT_ORG_ROLE });
    expect(activeOrgId).toBe(CUSTOMER_ORG);
    expect(membershipsWritten()).toEqual([
      { orgId: CUSTOMER_ORG, userId: user.id, role: DEFAULT_ORG_ROLE },
    ]);
    expect(mockCreateSignupOrg).not.toHaveBeenCalled();
  });

  it('keeping the install org: the decision as before this shipped', async () => {
    registerSignupOrgResolver(() => ({ kind: 'install' }));
    const user = newUser();

    const { row } = await signUp(user, EMAIL_PATH);

    expect(row).toEqual({ ...user, signupOrgId: INSTALL_ORG_ID, signupOrgRole: DEFAULT_ORG_ROLE });
  });

  it('a resolver that throws never refuses the signup: install org, logged at error', async () => {
    registerSignupOrgResolver(() => {
      throw new Error('CRM down');
    });
    const user = newUser();

    const { row } = await signUp(user, OAUTH_PATH);

    expect(row).toEqual({ ...user, signupOrgId: INSTALL_ORG_ID, signupOrgRole: DEFAULT_ORG_ROLE });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Signup-org resolver failed'),
      expect.any(Error),
      expect.objectContaining({ email: user.email, signupMethod: 'oauth' })
    );
  });

  it('an org that cannot be created never refuses the signup either', async () => {
    mockCreateSignupOrg.mockRejectedValue(new Error('connection reset'));
    const user = newUser();

    const { row } = await signUp(user, EMAIL_PATH);

    expect(row).toEqual({ ...user, signupOrgId: INSTALL_ORG_ID, signupOrgRole: DEFAULT_ORG_ROLE });
  });
});

describe('at single, nothing changes', () => {
  it('an uninvited signup is recorded field for field as before, and nothing is asked or created', async () => {
    mockEnv.TENANCY_MODE = 'single';
    const resolver = vi.fn(() => ({ kind: 'own' as const }));
    registerSignupOrgResolver(resolver);
    const user = newUser();

    const { row, activeOrgId } = await signUp(user, EMAIL_PATH);

    expect(row).toEqual({ ...user, signupOrgId: INSTALL_ORG_ID, signupOrgRole: DEFAULT_ORG_ROLE });
    expect(carrier.pending).toEqual({
      membership: { orgId: INSTALL_ORG_ID, role: DEFAULT_ORG_ROLE },
    });
    expect(activeOrgId).toBe(INSTALL_ORG_ID);
    expect(resolver).not.toHaveBeenCalled();
    expect(mockCreateSignupOrg).not.toHaveBeenCalled();
    expect(mockCompleteSignupOrg).not.toHaveBeenCalled();
  });

  it('a waitlist invitation from the install org lands in the install org', async () => {
    mockEnv.TENANCY_MODE = 'single';

    const { row } = await signUp(newUser(), EMAIL_PATH, (run) =>
      runInvitedSignup(run, waitlistInvitation())
    );

    expect(row.signupOrgId).toBe(INSTALL_ORG_ID);
    expect(mockCreateSignupOrg).not.toHaveBeenCalled();
  });
});
