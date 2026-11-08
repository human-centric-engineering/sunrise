/**
 * Tests: the default policy's tier arm on a fork's named tiers (t-999)
 *
 * A fork registers a tier narrower than an org admin with
 * `registerAdminTier(name, { holds })` and declares it where it would declare
 * `'org'`. The policy then admits, on a surface declared for that tier:
 *
 * - the org's OWNER/ADMIN, as on an `'org'` surface — the owner's ruling on
 *   t-999, so moving a page from `'org'` to a named tier only adds people —
 *   without asking `holds()`;
 * - whoever `holds()` says holds the tier in the entered org;
 *
 * and nobody else. A holder reaches their own tier's surfaces only: no `'org'`
 * surface, no platform one, no other named tier's. Every rule the `'org'`
 * tier keeps (multi only, session only, the entered org, not another org's
 * row) holds for a named tier too. A tier nobody registered admits nobody,
 * org admins included.
 *
 * The fork's init is the real one-shot gate in
 * `lib/auth/org-tier-admin-pages.ts`, over a stand-in for the scaffold, so the
 * policy reads the registry the way it does in production: lazily, in its
 * own realm.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const fork = vi.hoisted(() => ({ init: (): void => {} }));
vi.mock('@/lib/app/admin-tier', () => ({
  initAppOrgTierAdminPages: () => fork.init(),
}));
vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { logger } from '@/lib/logging';
import {
  DEFAULT_AUTHORIZATION_POLICY,
  canAdminister,
  type AuthorizationPrincipal,
  type AuthorizationResource,
  type AuthorizationScope,
} from '@/lib/auth/authorization';
import { registerAdminTier, registerOrgTierAdminPage } from '@/lib/auth/admin-tier';
import {
  __resetAppOrgTierAdminPagesForTests,
  namedAdminTiers,
} from '@/lib/auth/org-tier-admin-pages';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { env } from '@/lib/env';

const ORG = 'cmorg00000000000000000orga';
const OTHER_ORG = 'cmorg00000000000000000orgb';

const ORG_OWNER: AuthorizationPrincipal = {
  userId: 'owner-1',
  role: 'USER',
  credential: 'session',
  orgId: ORG,
  orgRole: 'OWNER',
};
const ORG_ADMIN: AuthorizationPrincipal = { ...ORG_OWNER, userId: 'oadmin-1', orgRole: 'ADMIN' };
/** An agency person: a MEMBER of the client's org whom the fork's rows say holds `page_designs`. */
const DESIGNER: AuthorizationPrincipal = { ...ORG_OWNER, userId: 'designer-1', orgRole: 'MEMBER' };
/** A MEMBER the fork's rows say holds nothing. */
const MEMBER: AuthorizationPrincipal = { ...ORG_OWNER, userId: 'member-1', orgRole: 'MEMBER' };
const PLATFORM_ADMIN: AuthorizationPrincipal = {
  userId: 'admin-1',
  role: 'ADMIN',
  credential: 'session',
  orgId: INSTALL_ORG_ID,
  orgRole: 'OWNER',
};

const policy = DEFAULT_AUTHORIZATION_POLICY;
const DESIGNS: AuthorizationScope = { org: ORG, tier: 'page_designs' };
const MEDIA: AuthorizationScope = { org: ORG, tier: 'media' };
const ORG_TIER: AuthorizationScope = { org: ORG, tier: 'org' };
const PLATFORM: AuthorizationScope = { org: ORG };

/**
 * The fork's stand-in for its own access rows: `designer-1` holds
 * `page_designs` in ORG, and nothing in any other org. Answers for the org it
 * is told, as the definition's contract says.
 */
const holdsDesigns = vi.fn((viewer: Readonly<AuthorizationPrincipal>) =>
  Promise.resolve(viewer.userId === 'designer-1' && viewer.orgId === ORG)
);
const holdsMedia = vi.fn((_viewer: Readonly<AuthorizationPrincipal>) => Promise.resolve(false));

let previousMode: typeof env.TENANCY_MODE;
beforeEach(() => {
  previousMode = env.TENANCY_MODE;
  env.TENANCY_MODE = 'multi';
  __resetAppOrgTierAdminPagesForTests();
  holdsDesigns.mockClear();
  holdsMedia.mockClear();
  fork.init = () => {
    registerAdminTier('page_designs', { holds: holdsDesigns, landing: '/admin/designs' });
    registerAdminTier('media', { holds: holdsMedia });
    registerOrgTierAdminPage('/admin/designs', { tier: 'page_designs' });
  };
});
afterEach(() => {
  env.TENANCY_MODE = previousMode;
  __resetAppOrgTierAdminPagesForTests();
  vi.clearAllMocks();
});

describe('canAdminister on a named tier (t-999)', () => {
  it('reads the fork’s tiers through the lazy init, as every other reader does', () => {
    expect(namedAdminTiers()).toEqual(['page_designs', 'media']);
  });

  it('admits a holder of the tier to a surface declared for it', async () => {
    await expect(policy.canAdminister(DESIGNER, null, DESIGNS)).resolves.toBe(true);
    expect(holdsDesigns).toHaveBeenCalledTimes(1);
  });

  it('refuses a MEMBER who does not hold it — the population above is not empty', async () => {
    await expect(policy.canAdminister(MEMBER, null, DESIGNS)).resolves.toBe(false);
    expect(holdsDesigns).toHaveBeenCalledTimes(1);
  });

  it('admits the org’s OWNER and ADMIN without asking holds() (the owner’s ruling)', async () => {
    await expect(policy.canAdminister(ORG_OWNER, null, DESIGNS)).resolves.toBe(true);
    await expect(policy.canAdminister(ORG_ADMIN, null, DESIGNS)).resolves.toBe(true);
    await expect(policy.canAdminister(ORG_ADMIN, null, MEDIA)).resolves.toBe(true);
    expect(holdsDesigns).not.toHaveBeenCalled(); // test-review:accept no_arg_called — the ruling is that holds() is not their gate;
    expect(holdsMedia).not.toHaveBeenCalled(); // test-review:accept no_arg_called — as above;
  });

  it('opens a holder no org-tier surface, no platform surface and no other named tier', async () => {
    // The control: the same holder IS admitted to their own tier.
    await expect(policy.canAdminister(DESIGNER, null, DESIGNS)).resolves.toBe(true);
    for (const scope of [ORG_TIER, PLATFORM, {}, MEDIA]) {
      await expect(policy.canAdminister(DESIGNER, null, scope)).resolves.toBe(false);
    }
    // holds() is asked about the tier the surface declared and no other: not
    // for 'org', not for the platform, and the media tier's own is asked once.
    expect(holdsDesigns).toHaveBeenCalledTimes(1);
    expect(holdsMedia).toHaveBeenCalledTimes(1);
  });

  it('admits nobody to a tier nobody registered — org admins included', async () => {
    const unregistered = { org: ORG, tier: 'page_design' };
    await expect(policy.canAdminister(ORG_OWNER, null, unregistered)).resolves.toBe(false);
    await expect(policy.canAdminister(DESIGNER, null, unregistered)).resolves.toBe(false);
    // A platform admin is admitted everywhere, as on any surface.
    await expect(policy.canAdminister(PLATFORM_ADMIN, null, unregistered)).resolves.toBe(true);
  });

  it('keeps the org tier’s rules: multi only, a browser session, the entered org, its own rows', async () => {
    const otherOrgRow: AuthorizationResource = { kind: 'design', id: 'd2', orgId: OTHER_ORG };
    const ownRow: AuthorizationResource = { kind: 'design', id: 'd1', orgId: ORG };
    await expect(policy.canAdminister(DESIGNER, ownRow, DESIGNS)).resolves.toBe(true);
    await expect(policy.canAdminister(DESIGNER, otherOrgRow, DESIGNS)).resolves.toBe(false);

    const key: AuthorizationPrincipal = { ...DESIGNER, credential: 'api-key', scopes: ['admin'] };
    await expect(policy.canAdminister(key, null, DESIGNS)).resolves.toBe(false);

    const noOrg: AuthorizationPrincipal = {
      userId: 'designer-1',
      role: 'USER',
      credential: 'session',
    };
    await expect(policy.canAdminister(noOrg, null, DESIGNS)).resolves.toBe(false);

    env.TENANCY_MODE = 'single';
    await expect(policy.canAdminister(DESIGNER, null, DESIGNS)).resolves.toBe(false);
    await expect(policy.canAdminister(ORG_OWNER, null, DESIGNS)).resolves.toBe(false);
    // Only the first (own-row) case reached holds(): every refusal above was
    // the arm's own rule, not the fork's answer.
    expect(holdsDesigns).toHaveBeenCalledTimes(1);
  });

  it('hands holds() a frozen copy of the principal, so the fork cannot change what the guard sees', async () => {
    let seen: Readonly<AuthorizationPrincipal> | undefined;
    holdsDesigns.mockImplementationOnce((viewer) => {
      seen = viewer;
      return Promise.resolve(true);
    });
    await policy.canAdminister(DESIGNER, null, DESIGNS);
    expect(seen).toEqual(DESIGNER);
    expect(seen).not.toBe(DESIGNER);
    expect(Object.isFrozen(seen)).toBe(true);
  });

  it('reads a holds() that throws, or answers anything but true, as no', async () => {
    holdsDesigns.mockRejectedValueOnce(new Error('access rows unreachable'));
    await expect(policy.canAdminister(DESIGNER, null, DESIGNS)).resolves.toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('named admin tier'),
      expect.objectContaining({ tier: 'page_designs', userId: 'designer-1' })
    );

    // A truthy value that is not `true` — a row, say — has not said yes.
    holdsDesigns.mockImplementationOnce(() => ({ id: 'access-1' }) as unknown as Promise<boolean>);
    await expect(policy.canAdminister(DESIGNER, null, DESIGNS)).resolves.toBe(false);
  });

  it('accepts a holds() that answers synchronously', async () => {
    holdsDesigns.mockImplementationOnce(() => true as unknown as Promise<boolean>);
    await expect(canAdminister(DESIGNER, null, DESIGNS)).resolves.toBe(true);
  });

  it('with no tier registered, answers every question as before t-999', async () => {
    // Behaviour-neutral at rest: the shipped scaffold registers nothing, and
    // the named tier above is then just an unknown tier.
    __resetAppOrgTierAdminPagesForTests();
    fork.init = () => {};
    expect(namedAdminTiers()).toEqual([]);
    const cases: [AuthorizationPrincipal, AuthorizationScope, boolean][] = [
      [ORG_OWNER, ORG_TIER, true],
      [ORG_ADMIN, ORG_TIER, true],
      [MEMBER, ORG_TIER, false],
      [DESIGNER, ORG_TIER, false],
      [ORG_OWNER, PLATFORM, false],
      [PLATFORM_ADMIN, PLATFORM, true],
      [ORG_OWNER, DESIGNS, false],
      [DESIGNER, DESIGNS, false],
    ];
    for (const [viewer, scope, expected] of cases) {
      await expect(policy.canAdminister(viewer, null, scope)).resolves.toBe(expected);
    }
    expect(holdsDesigns).not.toHaveBeenCalled(); // test-review:accept no_arg_called — nothing registered, nothing to ask;
  });
});
