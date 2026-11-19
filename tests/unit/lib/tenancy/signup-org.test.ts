/**
 * Tests: lib/tenancy/signup-org.ts — where a self-serve signup lands at
 * `multi` (§134 t-1062), and the sweep of orgs a failed signup left behind.
 *
 * - `asksSignupOrg`: who is asked. Only at `multi`, never platform staff,
 *   never an invited signup except one from the install org's own waitlist.
 * - `signupOrgMemberships`: the default (an org of their own, as OWNER), each
 *   answer a resolver can give, and every fault falling back to `null` (the
 *   install-org decision) with an `error` log. `createSignupOrg` is mocked at
 *   the module: `lifecycle.test.ts` covers what it writes.
 * - `sweepAbandonedSignupOrgs`: no query at `single`; at `multi`, one DELETE
 *   whose conditions are asserted clause by clause. The statement was run
 *   against Postgres when written.
 *
 * The resolver is registered through the real registry, and the fork's init
 * gate runs the shipped (empty) scaffold, which `tests/setup.ts` pins.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { DEFAULT_ORG_ROLE, ORG_ADMIN_ROLE, ORG_OWNER_ROLE } from '@/lib/tenancy/roles';
import { PLATFORM_ADMIN_ROLE, DEFAULT_USER_ROLE } from '@/lib/auth/roles';

const mockEnv = vi.hoisted((): { TENANCY_MODE: 'single' | 'multi' } => ({
  TENANCY_MODE: 'multi',
}));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

const db = vi.hoisted(() => ({
  org: { findUnique: vi.fn() },
  $queryRaw: vi.fn(),
}));
vi.mock('@/lib/db/client', () => ({ prisma: db }));

const mockCreateSignupOrg = vi.hoisted(() => vi.fn());
vi.mock('@/lib/tenancy/lifecycle', () => ({ createSignupOrg: mockCreateSignupOrg }));
// The seats guard's own rules are meters.test.ts; here, that a join asks it.
const mockRefuseSeats = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/lib/tenancy/meters', () => ({ refuseOverSeatsLimit: mockRefuseSeats }));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  asksSignupOrg,
  hasSignupOrgResolver,
  registerSignupOrgResolver,
  signupOrgMemberships,
  sweepAbandonedSignupOrgs,
  SIGNUP_ORG_ABANDONED_AFTER_MS,
  SIGNUP_ORG_RESOLVER_TIMEOUT_MS,
  SIGNUP_ORG_SWEEP_BATCH,
  __resetSignupOrgResolverForTests,
  type SignupOrgRequest,
} from '@/lib/tenancy/signup-org';
import { logger } from '@/lib/logging';

const NEW_ORG = 'cmorg00000000000000signup';
const CUSTOMER_ORG = 'cmorg0000000000000customer';

const person = {
  role: DEFAULT_USER_ROLE,
  accountType: 'HUMAN',
  email: 'ada@example.com',
  name: 'Ada Lovelace',
  emailVerified: false,
};
const EMAIL = { signupMethod: 'email', waitlistEntryId: null } as const;

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.TENANCY_MODE = 'multi';
  __resetSignupOrgResolverForTests();
  mockCreateSignupOrg.mockImplementation(async (input: { slug: string; name: string }) => ({
    id: NEW_ORG,
    ...input,
  }));
  db.org.findUnique.mockResolvedValue(null);
  db.$queryRaw.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('asksSignupOrg', () => {
  it('asks a public signup at multi', () => {
    expect(asksSignupOrg(person, null, false)).toBe(true);
  });

  it('asks nobody at single', () => {
    mockEnv.TENANCY_MODE = 'single';
    expect(asksSignupOrg(person, null, false)).toBe(false);
    expect(asksSignupOrg(person, { waitlistEntryId: 'w1' }, true)).toBe(false);
  });

  it('never asks platform staff: the first human, promoted to ADMIN, or an invitation granting ADMIN', () => {
    expect(asksSignupOrg({ ...person, role: PLATFORM_ADMIN_ROLE }, null, false)).toBe(false);
    expect(asksSignupOrg(person, { role: PLATFORM_ADMIN_ROLE }, true)).toBe(false);
    expect(asksSignupOrg({ ...person, accountType: 'SERVICE' }, null, false)).toBe(false);
  });

  it('asks someone let in from the install org’s own waitlist', () => {
    expect(asksSignupOrg(person, { role: 'USER', waitlistEntryId: 'w1' }, true)).toBe(true);
  });

  it('does not ask an invited signup: into the install org, into another org, or an org’s own waitlist', () => {
    // Admin → Users → Invite, into the install org: names no org, no entry.
    expect(asksSignupOrg(person, { role: 'USER' }, true)).toBe(false);
    expect(asksSignupOrg(person, { orgId: CUSTOMER_ORG }, true)).toBe(false);
    expect(asksSignupOrg(person, { orgId: CUSTOMER_ORG, waitlistEntryId: 'w1' }, true)).toBe(false);
  });

  it('does not ask an OAuth signup that redeemed a token with no readable record', () => {
    expect(asksSignupOrg(person, null, true)).toBe(false);
  });
});

describe('signupOrgMemberships — the default', () => {
  it('with no resolver, makes an org of their own and makes them its OWNER', async () => {
    const result = await signupOrgMemberships(person, EMAIL);

    expect(result).toEqual({ membership: { orgId: NEW_ORG, role: ORG_OWNER_ROLE } });
    expect(mockCreateSignupOrg).toHaveBeenCalledTimes(1);
    const [input] = mockCreateSignupOrg.mock.calls[0] as [{ slug: string; name: string }];
    expect(input.name).toBe('Ada Lovelace’s organisation');
    // The name in slug form with a random suffix; never the address.
    expect(input.slug).toMatch(/^ada-lovelace-s-organisation-[0-9a-f]{8}$/);
    expect(input.slug).not.toContain('example');
  });

  it('two people with the same name get different slugs', async () => {
    await signupOrgMemberships(person, EMAIL);
    await signupOrgMemberships(person, EMAIL);
    const [[a], [b]] = mockCreateSignupOrg.mock.calls as Array<[{ slug: string }]>;
    expect(a.slug).not.toBe(b.slug);
  });

  it('drops accents from the slug rather than splitting the word', async () => {
    await signupOrgMemberships({ ...person, name: 'Renée Dubois' }, EMAIL);
    const [input] = mockCreateSignupOrg.mock.calls[0] as [{ slug: string }];
    expect(input.slug).toMatch(/^renee-dubois-s-organisation-[0-9a-f]{8}$/);
  });

  it('cuts a long name by character, never inside an emoji', async () => {
    const name = `${'a'.repeat(84)}😀😀`;
    await signupOrgMemberships({ ...person, name }, EMAIL);
    const [input] = mockCreateSignupOrg.mock.calls[0] as [{ name: string }];
    expect(input.name).toBe(`${'a'.repeat(84)}😀’s organisation`);
    expect(input.name.isWellFormed()).toBe(true);
  });

  it('names the org from the address’s local part when no name was given', async () => {
    await signupOrgMemberships({ ...person, name: '  ' }, EMAIL);
    const [input] = mockCreateSignupOrg.mock.calls[0] as [{ name: string }];
    expect(input.name).toBe('ada’s organisation');
  });

  it('falls back to the install org, logged at error, when the org cannot be created', async () => {
    mockCreateSignupOrg.mockRejectedValue(new Error('connection reset'));

    expect(await signupOrgMemberships(person, EMAIL)).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('using the install org'),
      expect.any(Error),
      expect.objectContaining({ email: person.email })
    );
  });
});

describe('signupOrgMemberships — an app’s resolver', () => {
  it('is told who is signing up', async () => {
    const seen: SignupOrgRequest[] = [];
    registerSignupOrgResolver((request) => {
      seen.push(request);
      return { kind: 'own' };
    });

    await signupOrgMemberships(
      { ...person, emailVerified: true },
      { signupMethod: 'oauth', waitlistEntryId: 'w1' }
    );

    expect(seen).toEqual([
      {
        email: 'ada@example.com',
        name: 'Ada Lovelace',
        emailVerified: true,
        signupMethod: 'oauth',
        waitlistEntryId: 'w1',
      },
    ]);
  });

  it('`own` with a name makes the org under that name', async () => {
    registerSignupOrgResolver(() => ({ kind: 'own', name: 'Analytical Engines' }));

    const result = await signupOrgMemberships(person, EMAIL);

    expect(result).toEqual({ membership: { orgId: NEW_ORG, role: ORG_OWNER_ROLE } });
    expect(mockCreateSignupOrg).toHaveBeenCalledWith({
      name: 'Analytical Engines',
      slug: expect.stringMatching(/^analytical-engines-[0-9a-f]{8}$/),
    });
  });

  it('`join` puts them in an existing org as MEMBER, creating nothing', async () => {
    registerSignupOrgResolver(async () => ({ kind: 'join', orgId: CUSTOMER_ORG }));
    db.org.findUnique.mockResolvedValue({ id: CUSTOMER_ORG, status: 'ACTIVE', settings: {} });

    const result = await signupOrgMemberships(person, EMAIL);

    expect(result).toEqual({ membership: { orgId: CUSTOMER_ORG, role: DEFAULT_ORG_ROLE } });
    expect(mockCreateSignupOrg).not.toHaveBeenCalled();
    // The seat is counted as addMember() counts one.
    expect(mockRefuseSeats).toHaveBeenCalledWith(CUSTOMER_ORG, { platformAdmin: false });
  });

  it('`join` with a role gives that role', async () => {
    registerSignupOrgResolver(() => ({ kind: 'join', orgId: CUSTOMER_ORG, role: 'ADMIN' }));
    db.org.findUnique.mockResolvedValue({ id: CUSTOMER_ORG, status: 'ACTIVE', settings: {} });

    expect(await signupOrgMemberships(person, EMAIL)).toEqual({
      membership: { orgId: CUSTOMER_ORG, role: ORG_ADMIN_ROLE },
    });
  });

  it('`install` keeps the decision as it was, with nothing logged', async () => {
    registerSignupOrgResolver(() => ({ kind: 'install' }));

    expect(await signupOrgMemberships(person, EMAIL)).toBeNull();
    expect(mockCreateSignupOrg).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('`join` naming the install org is the install-org decision, not a membership of the role named', async () => {
    registerSignupOrgResolver(() => ({ kind: 'join', orgId: INSTALL_ORG_ID, role: 'OWNER' }));

    expect(await signupOrgMemberships(person, EMAIL)).toBeNull();
  });

  describe('falls back to the install org, logged at error, and never throws', () => {
    it('when it names an org that does not exist', async () => {
      registerSignupOrgResolver(() => ({ kind: 'join', orgId: 'cmorg000000000000000000gone' }));

      expect(await signupOrgMemberships(person, EMAIL)).toBeNull();
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('does not exist'),
        expect.objectContaining({ orgId: 'cmorg000000000000000000gone' })
      );
    });

    it.each([
      ['is not active', { status: 'SUSPENDED', settings: {} }],
      [
        'is still awaiting its own founder',
        { status: 'ACTIVE', settings: { awaitingFounder: true } },
      ],
    ])('when it names an org that %s', async (why, row) => {
      registerSignupOrgResolver(() => ({ kind: 'join', orgId: CUSTOMER_ORG }));
      db.org.findUnique.mockResolvedValue({ id: CUSTOMER_ORG, ...row });

      expect(await signupOrgMemberships(person, EMAIL)).toBeNull();
      expect(logger.error).toHaveBeenCalledWith(
        `Signup-org resolver named an org that ${why}; using the install org`,
        expect.objectContaining({ orgId: CUSTOMER_ORG })
      );
    });

    it('when it names an org at its seats limit', async () => {
      registerSignupOrgResolver(() => ({ kind: 'join', orgId: CUSTOMER_ORG }));
      db.org.findUnique.mockResolvedValue({ id: CUSTOMER_ORG, status: 'ACTIVE', settings: {} });
      mockRefuseSeats.mockRejectedValueOnce(new Error('limit of 5 for seats'));

      expect(await signupOrgMemberships(person, EMAIL)).toBeNull();
      expect(logger.error).toHaveBeenCalledWith(
        'Signup-org resolver named an org at its seats limit; using the install org',
        expect.any(Error),
        expect.objectContaining({ orgId: CUSTOMER_ORG })
      );
    });

    it('when it throws', async () => {
      registerSignupOrgResolver(() => {
        throw new Error('CRM down');
      });

      expect(await signupOrgMemberships(person, EMAIL)).toBeNull();
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('resolver failed'),
        expect.objectContaining({ message: 'CRM down' }),
        expect.objectContaining({ email: person.email })
      );
      expect(mockCreateSignupOrg).not.toHaveBeenCalled();
    });

    it('when it rejects', async () => {
      registerSignupOrgResolver(() => Promise.reject(new Error('CRM down')));
      expect(await signupOrgMemberships(person, EMAIL)).toBeNull();
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['an unknown kind', { kind: 'elsewhere' }],
      ['a join with no org', { kind: 'join' }],
      [
        'a join with a role that does not exist',
        { kind: 'join', orgId: CUSTOMER_ORG, role: 'GOD' },
      ],
      ['an own with an empty name', { kind: 'own', name: '   ' }],
    ])('when it answers %s', async (_label, answer) => {
      registerSignupOrgResolver(() => answer as never);

      expect(await signupOrgMemberships(person, EMAIL)).toBeNull();
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('no usable answer'),
        expect.any(Object)
      );
      expect(mockCreateSignupOrg).not.toHaveBeenCalled();
      expect(db.org.findUnique).not.toHaveBeenCalled();
    });

    it('when it runs past its time limit', async () => {
      vi.useFakeTimers();
      registerSignupOrgResolver(() => new Promise(() => {}));

      const pending = signupOrgMemberships(person, EMAIL);
      await vi.advanceTimersByTimeAsync(SIGNUP_ORG_RESOLVER_TIMEOUT_MS);

      expect(await pending).toBeNull();
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('resolver failed'),
        expect.any(Error),
        expect.any(Object)
      );
    });
  });

  it('hasSignupOrgResolver says whether one is registered', () => {
    expect(hasSignupOrgResolver()).toBe(false);
    registerSignupOrgResolver(() => ({ kind: 'own' }));
    expect(hasSignupOrgResolver()).toBe(true);
  });

  it('registering again replaces the first resolver', async () => {
    registerSignupOrgResolver(() => ({ kind: 'install' }));
    registerSignupOrgResolver(() => ({ kind: 'own', name: 'Second' }));

    await signupOrgMemberships(person, EMAIL);

    expect(mockCreateSignupOrg).toHaveBeenCalledWith(expect.objectContaining({ name: 'Second' }));
  });
});

describe('sweepAbandonedSignupOrgs', () => {
  it('makes no query at single, where no signup org is made', async () => {
    mockEnv.TENANCY_MODE = 'single';

    expect(await sweepAbandonedSignupOrgs()).toEqual({ deleted: 0 });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('deletes, in one statement, only marked orgs past the grace period with no member and no signup record naming them', async () => {
    db.$queryRaw.mockResolvedValue([{ id: 'cmorg-abandoned-1' }, { id: 'cmorg-abandoned-2' }]);

    expect(await sweepAbandonedSignupOrgs()).toEqual({ deleted: 2 });

    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = db.$queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const sql = strings.join('?').replace(/\s+/g, ' ');
    expect(sql).toMatch(/^ DELETE FROM org WHERE id IN \(/);
    // The inner select: every condition, in order.
    expect(sql).toContain('WHERE o.settings ? ?');
    expect(sql).toContain('AND o.id <> ?');
    expect(sql).toContain(`AND o."createdAt" < now() - ? * interval '1 millisecond'`);
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM org_membership m WHERE m."orgId" = o.id)');
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM "user" u WHERE u."signupOrgId" = o.id)');
    expect(sql).toContain('LIMIT ?');
    // Re-checked on the row being deleted, so a founder who joined between the
    // select and the delete keeps their org.
    expect(sql).toContain('AND settings ? ?');
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM org_membership m WHERE m."orgId" = org.id)');
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM "user" u WHERE u."signupOrgId" = org.id)');
    expect(values).toEqual([
      'awaitingFounder',
      INSTALL_ORG_ID,
      SIGNUP_ORG_ABANDONED_AFTER_MS,
      SIGNUP_ORG_SWEEP_BATCH,
      'awaitingFounder',
    ]);
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), {
      orgIds: ['cmorg-abandoned-1', 'cmorg-abandoned-2'],
    });
  });

  it('says nothing when there is nothing to delete', async () => {
    expect(await sweepAbandonedSignupOrgs()).toEqual({ deleted: 0 });
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
