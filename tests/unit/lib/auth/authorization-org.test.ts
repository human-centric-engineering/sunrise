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
import { describe, it, expect, vi, afterEach } from 'vitest';
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

  it('the org role does not leak into the API-key path: a narrow key in an org is still a narrow key', async () => {
    const key: AuthorizationPrincipal = {
      ...ORG_OWNER,
      credential: 'api-key',
      scopes: ['chat'],
    };
    // The org arm reads orgRole regardless of credential — a chat key held by
    // an org OWNER may administer that org's rows, which is what "the key
    // enters the org it was minted in" means. What it must NOT reach is
    // anything outside that org.
    await expect(policy.canAdminister(key, ORG_ROW, { org: ORG })).resolves.toBe(true);
    await expect(policy.canAdminister(key, null, { org: ORG })).resolves.toBe(false);
    await expect(policy.canAdminister(key, OTHER_ORG_ROW, { org: ORG })).resolves.toBe(false);
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
