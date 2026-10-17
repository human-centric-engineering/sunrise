/**
 * Tests: the default policy's org arm (§106) — and the byte-identical sweep
 *
 * Two halves. The first is what the arm grants: an org OWNER/ADMIN
 * administers, and reads the ownerless `this-row` of, a resource carrying
 * THEIR org — and nothing else: not a null resource, not one without an
 * `orgId`, not another org's, not the capability question, not as a MEMBER.
 * Including the trap the fork seam's docblock names — a resource with no
 * `orgId` against a principal with no `orgId` compares `undefined ===
 * undefined`, and must NOT grant.
 *
 * The second is the promise the feature makes to every single-tenant
 * install: with no org-carrying resource, every answer the policy gave
 * before is the answer it gives now, with and without org facts on the
 * principal. Swept over every principal × every question the old tests ask
 * rather than asserted by sentence. And `checkOwnerlessReachability` over a
 * roster that now includes an org admin: no kind closes.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  DEFAULT_AUTHORIZATION_POLICY,
  SAFE_MODE_POLICY,
  checkAuthorizationParity,
  readSubject,
  readTargetFor,
  readUnattributedKind,
  __resetOwnerlessWarningsForTests,
  type AuthorizationPrincipal,
  type AuthorizationResource,
  type ReadTarget,
} from '@/lib/auth/authorization';
import { checkOwnerlessReachability, UNATTRIBUTED_READ_KINDS } from '@/lib/auth/orphan-reads';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { env } from '@/lib/env';

vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
import { logger } from '@/lib/logging';

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
const ORG_MEMBER: AuthorizationPrincipal = { ...ORG_OWNER, userId: 'member-1', orgRole: 'MEMBER' };
const ORG_NONE: AuthorizationPrincipal = { ...ORG_OWNER, userId: 'none-1', orgRole: null };
const PLATFORM_ADMIN: AuthorizationPrincipal = {
  userId: 'admin-1',
  role: 'ADMIN',
  credential: 'session',
  orgId: INSTALL_ORG_ID,
  orgRole: 'OWNER',
};

const ORG_ROW: AuthorizationResource = { kind: 'agent', id: 'a1', orgId: ORG };
const OTHER_ORG_ROW: AuthorizationResource = { kind: 'agent', id: 'a2', orgId: OTHER_ORG };
const ORGLESS_ROW: AuthorizationResource = { kind: 'agent', id: 'a3' };

const policy = DEFAULT_AUTHORIZATION_POLICY;

afterEach(() => {
  __resetOwnerlessWarningsForTests();
  vi.clearAllMocks();
});

describe('canAdminister — the org arm', () => {
  it('an org OWNER and an org ADMIN administer a resource carrying their org', async () => {
    await expect(policy.canAdminister(ORG_OWNER, ORG_ROW, { org: ORG })).resolves.toBe(true);
    await expect(policy.canAdminister(ORG_ADMIN, ORG_ROW, { org: ORG })).resolves.toBe(true);
  });

  it('a MEMBER, and a principal with no org role, do not', async () => {
    await expect(policy.canAdminister(ORG_MEMBER, ORG_ROW, { org: ORG })).resolves.toBe(false);
    await expect(policy.canAdminister(ORG_NONE, ORG_ROW, { org: ORG })).resolves.toBe(false);
  });

  it('another org’s resource grants nothing', async () => {
    await expect(policy.canAdminister(ORG_OWNER, OTHER_ORG_ROW, { org: ORG })).resolves.toBe(false);
  });

  it('a null resource grants nothing — platform-ops surfaces stay platform-only', async () => {
    await expect(policy.canAdminister(ORG_OWNER, null, { org: ORG })).resolves.toBe(false);
  });

  it('a resource without an orgId grants nothing, even against a principal without one (the undefined === undefined trap)', async () => {
    const orgless: AuthorizationPrincipal = {
      userId: 'x',
      role: 'USER',
      credential: 'session',
      orgRole: 'OWNER',
    };
    await expect(policy.canAdminister(orgless, ORGLESS_ROW, {})).resolves.toBe(false);
    await expect(policy.canAdminister(ORG_OWNER, ORGLESS_ROW, { org: ORG })).resolves.toBe(false);
  });

  it('a platform admin still administers everything, org or not', async () => {
    await expect(policy.canAdminister(PLATFORM_ADMIN, OTHER_ORG_ROW, {})).resolves.toBe(true);
    await expect(policy.canAdminister(PLATFORM_ADMIN, null, {})).resolves.toBe(true);
  });

  it('an API key never takes the org arm: a narrow key is narrower than its owner, whatever org role rode in on it', async () => {
    // t-671 let a chat key held by an org OWNER administer that org's rows.
    // t-672's security review showed why not: `enterApiKeyOrg` projects the
    // OWNER's platform role onto a key at `single`, so a chat key minted by
    // a platform admin arrived at the install org as OWNER and could read
    // the whole roster where the same key is refused every admin route.
    // A key's standing is its scopes; only an `admin` key administers, and
    // it does so through `administersEverything`, not here.
    const key: AuthorizationPrincipal = {
      ...ORG_OWNER,
      credential: 'api-key',
      scopes: ['chat'],
    };
    await expect(policy.canAdminister(key, ORG_ROW, { org: ORG })).resolves.toBe(false);
    await expect(policy.canRead(key, readTargetFor(ORG_ROW), { org: ORG })).resolves.toBe(false);
    await expect(policy.canAdminister(key, null, { org: ORG })).resolves.toBe(false);
    await expect(policy.canAdminister(key, OTHER_ORG_ROW, { org: ORG })).resolves.toBe(false);

    // The control: the same principal as a session IS admitted, so the
    // refusal above is the credential, not the fixture.
    await expect(policy.canAdminister(ORG_OWNER, ORG_ROW, { org: ORG })).resolves.toBe(true);
    // And an admin key of a platform admin still administers everything.
    const adminKey: AuthorizationPrincipal = { ...key, role: 'ADMIN', scopes: ['admin'] };
    await expect(policy.canAdminister(adminKey, ORG_ROW, { org: ORG })).resolves.toBe(true);
    await expect(policy.canRead(adminKey, readTargetFor(ORG_ROW), { org: ORG })).resolves.toBe(
      true
    );
  });
});

describe('canAdminister — the tier arm (§111 t-810)', () => {
  // The arm opens an org-tier surface to an org OWNER/ADMIN of the entered
  // org, at `multi` only. Every case below is asked with a null resource,
  // which is what an admin route without a resolver and the admin layout
  // pass, so the org arm (`administersOrgOf`) cannot be what answers.
  const ORG_TIER = { org: ORG, tier: 'org' };
  let previousMode: typeof env.TENANCY_MODE;
  beforeEach(() => {
    previousMode = env.TENANCY_MODE;
    env.TENANCY_MODE = 'multi';
  });
  afterEach(() => {
    env.TENANCY_MODE = previousMode;
  });

  it('admits an org OWNER and an org ADMIN of the entered org to an org-tier surface', async () => {
    await expect(policy.canAdminister(ORG_OWNER, null, ORG_TIER)).resolves.toBe(true);
    await expect(policy.canAdminister(ORG_ADMIN, null, ORG_TIER)).resolves.toBe(true);
  });

  it('admits them nowhere else: the same principals on an undeclared surface are refused', async () => {
    // The control for the case above, and the test that fails if the tier
    // check is removed: without it the arm would admit an org admin to every
    // platform surface.
    await expect(policy.canAdminister(ORG_OWNER, null, { org: ORG })).resolves.toBe(false);
    await expect(policy.canAdminister(ORG_ADMIN, null, {})).resolves.toBe(false);
    // A tier the default policy does not know is not the org tier.
    await expect(policy.canAdminister(ORG_OWNER, null, { org: ORG, tier: 'team' })).resolves.toBe(
      false
    );
  });

  it('refuses a MEMBER, a principal with no role in the entered org, and one with no org facts', async () => {
    await expect(policy.canAdminister(ORG_MEMBER, null, ORG_TIER)).resolves.toBe(false);
    // An admin of another org acting here holds no role here: the guard's
    // entry either refuses them (not a member) or projects their role here.
    await expect(policy.canAdminister(ORG_NONE, null, ORG_TIER)).resolves.toBe(false);
    const noOrgFacts: AuthorizationPrincipal = {
      userId: 'oadmin-2',
      role: 'USER',
      credential: 'session',
    };
    await expect(policy.canAdminister(noOrgFacts, null, ORG_TIER)).resolves.toBe(false);
  });

  it('refuses a resource that names another org, whatever the tier says', async () => {
    // The tier opens a surface, not every row its resolver can name: an
    // `/orgs/[id]`-shaped route must not admit org A's admin to org B's row.
    await expect(policy.canAdminister(ORG_OWNER, OTHER_ORG_ROW, ORG_TIER)).resolves.toBe(false);
    // Their own org's row, and a row placed in no org, are the surface's.
    await expect(policy.canAdminister(ORG_OWNER, ORG_ROW, ORG_TIER)).resolves.toBe(true);
    await expect(policy.canAdminister(ORG_ADMIN, ORGLESS_ROW, ORG_TIER)).resolves.toBe(true);
    // A platform admin is not narrowed by it.
    await expect(policy.canAdminister(PLATFORM_ADMIN, OTHER_ORG_ROW, ORG_TIER)).resolves.toBe(true);
  });

  it('refuses an org-bound API key, whatever org role rode in on it', async () => {
    const key: AuthorizationPrincipal = { ...ORG_OWNER, credential: 'api-key', scopes: ['chat'] };
    await expect(policy.canAdminister(key, null, ORG_TIER)).resolves.toBe(false);
    // An `admin` key of a platform admin is a platform credential and is
    // admitted as one.
    await expect(
      policy.canAdminister({ ...key, role: 'ADMIN', scopes: ['admin'] }, null, ORG_TIER)
    ).resolves.toBe(true);
  });

  it('admits nobody new at single, where no row isolation bounds what the surface reads', async () => {
    env.TENANCY_MODE = 'single';
    // The case that makes this a rule rather than an assumption: an OWNER of
    // a non-install org, which a session can act in at `single`.
    await expect(policy.canAdminister(ORG_OWNER, null, ORG_TIER)).resolves.toBe(false);
    await expect(policy.canAdminister(PLATFORM_ADMIN, null, ORG_TIER)).resolves.toBe(true);
  });

  it('a platform admin is admitted with or without a tier, and safe mode admits nobody', async () => {
    await expect(policy.canAdminister(PLATFORM_ADMIN, null, ORG_TIER)).resolves.toBe(true);
    await expect(policy.canAdminister(PLATFORM_ADMIN, null, {})).resolves.toBe(true);
    await expect(SAFE_MODE_POLICY.canAdminister(ORG_OWNER, null, ORG_TIER)).resolves.toBe(false);
  });

  it('leaves the read faces in parity for an org admin asked about an org-tier surface', async () => {
    await expect(
      checkAuthorizationParity(policy, [
        {
          label: 'org owner, org tier',
          viewer: ORG_OWNER,
          subjects: ['owner-1', 'member-1'],
          scope: ORG_TIER,
        },
        {
          label: 'org admin, org tier',
          viewer: ORG_ADMIN,
          subjects: ['oadmin-1', 'owner-1'],
          scope: ORG_TIER,
        },
      ])
    ).resolves.toEqual([]);
  });
});

describe('canRead — the unattributed arm', () => {
  it('an org OWNER/ADMIN reads the ownerless this-row of a resource carrying their org, without the diagnostic', async () => {
    await expect(policy.canRead(ORG_OWNER, readTargetFor(ORG_ROW), { org: ORG })).resolves.toBe(
      true
    );
    await expect(policy.canRead(ORG_ADMIN, readTargetFor(ORG_ROW), { org: ORG })).resolves.toBe(
      true
    );
    // Answered before warnOnceAboutUnattributed: an org resource with no
    // ownerId is a fork's steady state, not a misconfigured resolver.
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('a MEMBER does not, and the diagnostic then fires once', async () => {
    await expect(policy.canRead(ORG_MEMBER, readTargetFor(ORG_ROW), { org: ORG })).resolves.toBe(
      false
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('another org’s ownerless row is refused', async () => {
    await expect(
      policy.canRead(ORG_OWNER, readTargetFor(OTHER_ORG_ROW), { org: ORG })
    ).resolves.toBe(false);
  });

  it('the capability question (any-row-of-this-kind) stays platform-only for an org admin', async () => {
    for (const kind of UNATTRIBUTED_READ_KINDS) {
      await expect(policy.canRead(ORG_OWNER, readUnattributedKind(kind), {})).resolves.toBe(false);
    }
    await expect(
      policy.canRead(PLATFORM_ADMIN, readUnattributedKind('conversation'), {})
    ).resolves.toBe(true);
  });

  it('the subject arm is unchanged: an org admin reads themselves and not another member', async () => {
    await expect(policy.canRead(ORG_OWNER, readSubject('owner-1'), { org: ORG })).resolves.toBe(
      true
    );
    await expect(policy.canRead(ORG_OWNER, readSubject('member-1'), { org: ORG })).resolves.toBe(
      false
    );
  });

  it('subjectScope is unchanged: an org admin is narrowed to their own rows', async () => {
    await expect(policy.subjectScope(ORG_OWNER, { org: ORG })).resolves.toEqual({
      userId: 'owner-1',
    });
  });
});

describe('byte-identical: with no org-carrying resource, org facts change no answer', () => {
  // Every principal the old tests ask about, with and without the org facts
  // the guard now adds at `single` (install org, role projected).
  const bare: AuthorizationPrincipal[] = [
    { userId: 'admin-1', role: 'ADMIN', credential: 'session' },
    { userId: 'user-1', role: 'USER', credential: 'session' },
    { userId: 'user-2', role: 'ADMIN', credential: 'api-key', scopes: ['admin'] },
    { userId: 'user-2', role: 'USER', credential: 'api-key', scopes: ['admin'] },
    { userId: 'user-2', role: 'ADMIN', credential: 'api-key', scopes: ['chat'] },
    { userId: 'user-3', role: null, credential: 'session' },
  ];
  const withOrg = (p: AuthorizationPrincipal): AuthorizationPrincipal => ({
    ...p,
    orgId: INSTALL_ORG_ID,
    orgRole: p.role === 'ADMIN' ? 'OWNER' : 'MEMBER',
  });
  // Every question a core route other than the org members routes can ask:
  // none of these resources carries an orgId — no core ADMIN resolver names
  // one until §107, and the members routes (t-672) are the org arm's
  // intended callers, covered by their own tests rather than swept here.
  const resources: (AuthorizationResource | null)[] = [
    null,
    { kind: 'thing', id: 't1', ownerId: 'user-1' },
    { kind: 'thing', id: 't2', ownerId: 'user-9' },
    { kind: 'thing', id: 't3' },
  ];
  const targets: ReadTarget[] = [
    ...resources.map(readTargetFor),
    ...UNATTRIBUTED_READ_KINDS.map(readUnattributedKind),
    readSubject('user-1'),
    readSubject('user-9'),
  ];
  const scopes = [{}, { org: INSTALL_ORG_ID }];

  it.each([
    ['DEFAULT_AUTHORIZATION_POLICY', DEFAULT_AUTHORIZATION_POLICY],
    ['SAFE_MODE_POLICY', SAFE_MODE_POLICY],
  ])('%s answers every existing case identically', async (_label, p) => {
    let asked = 0;
    for (const principal of bare) {
      for (const scope of scopes) {
        for (const resource of resources) {
          expect(await p.canAdminister(withOrg(principal), resource, scope)).toBe(
            await p.canAdminister(principal, resource, scope)
          );
          asked++;
        }
        for (const target of targets) {
          expect(await p.canRead(withOrg(principal), target, scope)).toBe(
            await p.canRead(principal, target, scope)
          );
          asked++;
        }
        expect(await p.subjectScope(withOrg(principal), scope)).toEqual(
          await p.subjectScope(principal, scope)
        );
        asked++;
      }
    }
    // The sweep is only evidence if it asked something.
    expect(asked).toBeGreaterThan(100);
  });

  it('at single, declaring the org tier changes no answer for any principal (§111 t-810)', async () => {
    // With org-tier surfaces declared, the layout and the guards ask with
    // `tier: 'org'` where they asked with no tier. At `single` that must not
    // move a single answer, with org facts on the principal or without.
    expect(env.TENANCY_MODE).toBe('single');
    let asked = 0;
    for (const principal of [...bare, ...bare.map(withOrg)]) {
      for (const resource of resources) {
        for (const scope of scopes) {
          expect(await policy.canAdminister(principal, resource, { ...scope, tier: 'org' })).toBe(
            await policy.canAdminister(principal, resource, scope)
          );
          asked++;
        }
      }
    }
    expect(asked).toBeGreaterThan(50);
  });

  it('control: the sweep sees a difference the moment a resource carries an org', async () => {
    const owner = withOrg({ userId: 'user-1', role: 'USER', credential: 'session' });
    const orgRow: AuthorizationResource = { kind: 'thing', id: 't9', orgId: INSTALL_ORG_ID };
    // A platform USER is install-org MEMBER by the projection, so still no…
    expect(await policy.canAdminister(owner, orgRow, {})).toBe(false);
    // …but an install-org OWNER who is not a platform admin (an invited
    // orgRole: OWNER, or a demoted admin — t-672's drift) now administers it.
    expect(await policy.canAdminister({ ...owner, orgRole: 'OWNER' }, orgRow, {})).toBe(true);
    expect(
      await policy.canAdminister(
        { userId: 'user-1', role: 'USER', credential: 'session' },
        orgRow,
        {}
      )
    ).toBe(false);
  });
});

describe('the two checkers, over a roster that includes an org admin', () => {
  it('parity holds for an org OWNER and an org MEMBER', async () => {
    await expect(
      checkAuthorizationParity(policy, [
        { label: 'org owner', viewer: ORG_OWNER, subjects: ['owner-1', 'member-1', 'user-9'] },
        { label: 'org member', viewer: ORG_MEMBER, subjects: ['member-1', 'user-9'] },
        { label: 'platform admin', viewer: PLATFORM_ADMIN, subjects: ['admin-1', 'user-9'] },
      ])
    ).resolves.toEqual([]);
  });

  it('no ownerless kind closes: platform staff still reach every kind, the org admin none', async () => {
    await expect(
      checkOwnerlessReachability(policy, [
        { label: 'org owner', viewer: ORG_OWNER },
        { label: 'platform admin', viewer: PLATFORM_ADMIN },
      ])
    ).resolves.toEqual([]);
    // And the org admin alone would close every kind — which is the deliberate
    // limit until §107 scopes those reads by org, stated rather than assumed.
    const alone = await checkOwnerlessReachability(policy, [
      { label: 'org owner', viewer: ORG_OWNER },
    ]);
    expect(alone.map((v) => v.kind).sort()).toEqual([...UNATTRIBUTED_READ_KINDS].sort());
  });
});
