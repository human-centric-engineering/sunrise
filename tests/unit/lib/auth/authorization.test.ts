/**
 * Tests: lib/auth/authorization.ts — the policy, the seam, and the parity checker
 *
 * Three properties, and the middle one is the one a reviewer should look at
 * hardest:
 *
 *  1. **The default policy reproduces what the guards asserted inline.** If it
 *     does not, every guarded handler in the tree changed behaviour in a PR
 *     that claims to have changed none.
 *  2. **A registered override changes the answer.** A seam nothing can be seen
 *     to alter is decoration; this is the test that proves the seam is a seam.
 *  3. **The parity checker can go red.** A checker that has never been shown to
 *     report is worth nothing, so the divergent fixture below is not padding —
 *     it is the only evidence the control works.
 *
 * @see lib/auth/authorization.ts · lib/app/authorization.ts
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  DEFAULT_AUTHORIZATION_POLICY,
  SAFE_MODE_POLICY,
  canAdminister,
  canRead,
  subjectScope,
  subjectFilterSelects,
  readSubject,
  readTargetFor,
  getAuthorizationPolicy,
  hasAppAuthorizationPolicy,
  registerAuthorizationPolicy,
  checkAuthorizationParity,
  __resetAuthorizationPolicyForTests,
  __resetOwnerlessWarningsForTests,
  type AuthorizationPolicy,
  type AuthorizationPrincipal,
} from '@/lib/auth/authorization';

vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { logger } from '@/lib/logging';

const ADMIN: AuthorizationPrincipal = { userId: 'admin-1', role: 'ADMIN', credential: 'session' };
const MEMBER: AuthorizationPrincipal = { userId: 'user-1', role: 'USER', credential: 'session' };
const ADMIN_KEY: AuthorizationPrincipal = {
  userId: 'user-2',
  role: 'USER',
  credential: 'api-key',
  scopes: ['admin'],
};
const NARROW_KEY: AuthorizationPrincipal = {
  userId: 'user-2',
  role: 'ADMIN',
  credential: 'api-key',
  scopes: ['chat'],
};

afterEach(() => {
  __resetAuthorizationPolicyForTests();
  __resetOwnerlessWarningsForTests();
  vi.clearAllMocks();
});

describe('the default policy reproduces the guards it replaced', () => {
  it('lets a platform admin administer, and nobody else', async () => {
    await expect(DEFAULT_AUTHORIZATION_POLICY.canAdminister(ADMIN, null, {})).resolves.toBe(true);
    await expect(DEFAULT_AUTHORIZATION_POLICY.canAdminister(MEMBER, null, {})).resolves.toBe(false);
  });

  it('answers an API-key caller from its scopes, not its owner’s role', async () => {
    // Both halves matter and they pull in opposite directions, which is what
    // makes this the real contract rather than a restatement of the row: the
    // admin-scoped key belongs to a USER and is admitted; the chat-scoped key
    // belongs to an ADMIN and is refused. `withAdminAuth` has always worked this
    // way — the scope is the capability check — and Q6 is what keeps it sound.
    await expect(DEFAULT_AUTHORIZATION_POLICY.canAdminister(ADMIN_KEY, null, {})).resolves.toBe(
      true
    );
    await expect(DEFAULT_AUTHORIZATION_POLICY.canAdminister(NARROW_KEY, null, {})).resolves.toBe(
      false
    );
  });

  it('refuses a key principal carrying no scopes at all', async () => {
    // Reachable from a fork's own code rather than from the guards, which always
    // pass the resolved key's scopes. It matters because the alternative reading
    // of an absent list — "unscoped, therefore unrestricted" — is the fail-open
    // one, and the type allows the state.
    await expect(
      DEFAULT_AUTHORIZATION_POLICY.canAdminister(
        { userId: 'user-2', role: 'ADMIN', credential: 'api-key' },
        null,
        {}
      )
    ).resolves.toBe(false);
  });

  it('reads everyone for an admin, and only themselves for everyone else', async () => {
    await expect(
      DEFAULT_AUTHORIZATION_POLICY.canRead(ADMIN, readSubject('user-9'), {})
    ).resolves.toBe(true);
    await expect(
      DEFAULT_AUTHORIZATION_POLICY.canRead(MEMBER, readSubject('user-1'), {})
    ).resolves.toBe(true);
    await expect(
      DEFAULT_AUTHORIZATION_POLICY.canRead(MEMBER, readSubject('user-9'), {})
    ).resolves.toBe(false);
  });

  it('allows a read the route declared no subject for', async () => {
    // The arm every core route takes: nothing supplies a `resource` resolver,
    // so `withAuth` asks about `null` on every request. If this were `false`,
    // wiring the seam would have 403'd the entire authenticated API.
    await expect(
      DEFAULT_AUTHORIZATION_POLICY.canRead(MEMBER, { kind: 'nothing' }, {})
    ).resolves.toBe(true);
  });

  it('refuses a resource it cannot attribute, rather than reading it as unscoped', async () => {
    // The three states `subject`/`resource` encode, and the middle one is why
    // `resource` is passed at all. A route that named `{ kind, id, orgId }` with
    // no `ownerId` — an org-owned row, or a nullable `createdBy` on a SetNull
    // model — used to arrive here indistinguishable from "this route named
    // nothing" and was permitted for every caller. Platform staff still read it,
    // because reading everyone is what the default policy IS; nobody else does
    // until the fork answers for the case in its own `canRead`.
    const orphan = { kind: 'report', id: 'r1', orgId: 'org-7' };

    await expect(
      DEFAULT_AUTHORIZATION_POLICY.canRead(MEMBER, readTargetFor(orphan), {})
    ).resolves.toBe(false);
    await expect(
      DEFAULT_AUTHORIZATION_POLICY.canRead(ADMIN, readTargetFor(orphan), {})
    ).resolves.toBe(true);
    // And the state it must NOT be confused with, one line away so the contrast
    // is the test: same null subject, no resource, still allowed.
    await expect(
      DEFAULT_AUTHORIZATION_POLICY.canRead(MEMBER, { kind: 'nothing' }, {})
    ).resolves.toBe(true);
  });

  it('names the unattributed resource in the log, once per kind rather than per request', async () => {
    // The arm is a fork's steady state — a resolver on an org-owned model
    // returns an ownerless resource every time — so an unlatched warn would be
    // one line per request forever on the hot route the arm exists for.
    __resetOwnerlessWarningsForTests();

    for (let i = 0; i < 3; i++) {
      await DEFAULT_AUTHORIZATION_POLICY.canRead(
        MEMBER,
        readTargetFor({ kind: 'report', id: `r${i}` }),
        {}
      );
    }
    await DEFAULT_AUTHORIZATION_POLICY.canRead(MEMBER, readTargetFor({ kind: 'invoice' }), {});

    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('no ownerId'),
      expect.objectContaining({ kind: 'report' })
    );
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('no ownerId'),
      expect.objectContaining({ kind: 'invoice' })
    );
  });

  it('expresses "everyone" as an absent key, so widening is a deletion', async () => {
    await expect(DEFAULT_AUTHORIZATION_POLICY.subjectScope(ADMIN, {})).resolves.toEqual({});
    await expect(DEFAULT_AUTHORIZATION_POLICY.subjectScope(MEMBER, {})).resolves.toEqual({
      userId: 'user-1',
    });
  });

  it('agrees with itself across both read faces', async () => {
    await expect(
      checkAuthorizationParity(DEFAULT_AUTHORIZATION_POLICY, [
        { label: 'platform admin', viewer: ADMIN, subjects: ['admin-1', 'user-1', 'user-9'] },
        { label: 'member', viewer: MEMBER, subjects: ['user-1', 'user-9'] },
        { label: 'admin key', viewer: ADMIN_KEY, subjects: ['user-2', 'user-9'] },
        { label: 'narrow key', viewer: NARROW_KEY, subjects: ['user-2', 'user-9'] },
      ])
    ).resolves.toEqual([]);
  });
});

describe('the seam', () => {
  it('ships with no app policy, so the default is what runs', () => {
    expect(hasAppAuthorizationPolicy()).toBe(false);
    expect(getAuthorizationPolicy()).toBe(DEFAULT_AUTHORIZATION_POLICY);
  });

  it('changes the answer once a policy is registered', async () => {
    // The test that proves the seam is a seam. Same principal, same call,
    // opposite answers — the fork's "org admin" tier reaching an admin surface
    // a platform-role check would have refused.
    await expect(canAdminister(MEMBER)).resolves.toBe(false);

    registerAuthorizationPolicy({
      ...DEFAULT_AUTHORIZATION_POLICY,
      canAdminister: (viewer) => Promise.resolve(viewer.userId === 'user-1'),
    });

    await expect(canAdminister(MEMBER)).resolves.toBe(true);
    await expect(canAdminister(ADMIN)).resolves.toBe(false);
  });

  it('passes the resource and the scope through to the policy', async () => {
    // Without this the resolver hook would be inert by construction: #367's
    // ownership input and §106's org input both arrive this way.
    const seen: unknown[] = [];
    registerAuthorizationPolicy({
      ...DEFAULT_AUTHORIZATION_POLICY,
      canAdminister: (viewer, resource, scope) => {
        seen.push({ viewer, resource, scope });
        return Promise.resolve(true);
      },
    });

    await canAdminister(MEMBER, { kind: 'agent', id: 'a1', orgId: 'org-7' }, { org: 'org-7' });

    expect(seen).toEqual([
      {
        viewer: MEMBER,
        resource: { kind: 'agent', id: 'a1', orgId: 'org-7' },
        scope: { org: 'org-7' },
      },
    ]);
  });

  it('refuses a second, different policy rather than silently replacing one', () => {
    registerAuthorizationPolicy(DEFAULT_AUTHORIZATION_POLICY);
    expect(() => registerAuthorizationPolicy({ ...DEFAULT_AUTHORIZATION_POLICY })).toThrow(
      /already registered/
    );
    // Re-registering the SAME object is a no-op — module re-import under HMR.
    expect(() => registerAuthorizationPolicy(DEFAULT_AUTHORIZATION_POLICY)).not.toThrow();
  });
});

describe('failure is closed, on every path', () => {
  it('keeps the two read faces agreeing when the policy throws', async () => {
    // The invariant a hand-written per-face fallback broke. `canRead` answering
    // `false` while `subjectScope` answered `{ userId }` is precisely the
    // divergence the parity checker exists to name: a list containing the
    // viewer's own rows whose detail view 403s. And it was the LIKELY shape, not
    // a corner — one broken shared helper in a fork's policy makes both faces
    // throw at once. The wrappers now answer from SAFE_MODE_POLICY, so the
    // fallback is parity-consistent by construction.
    registerAuthorizationPolicy({
      canAdminister: () => Promise.reject(new Error('boom')),
      canRead: () => Promise.reject(new Error('boom')),
      subjectScope: () => Promise.reject(new Error('boom')),
    });

    await expect(canRead(MEMBER, readSubject('user-1'))).resolves.toBe(true);
    await expect(subjectScope(MEMBER)).resolves.toEqual({ userId: 'user-1' });
    await expect(canRead(MEMBER, readSubject('user-9'))).resolves.toBe(false);
  });

  it('denies when a policy method throws, and says so', async () => {
    registerAuthorizationPolicy({
      canAdminister: () => Promise.reject(new Error('policy lookup failed')),
      canRead: () => Promise.reject(new Error('policy lookup failed')),
      subjectScope: () => Promise.reject(new Error('policy lookup failed')),
    });

    await expect(canAdminister(ADMIN)).resolves.toBe(false);
    await expect(canRead(ADMIN, readSubject('user-9'))).resolves.toBe(false);
    // `{}` is the WIDEST value this type can express, so the fail-closed answer
    // for the list face is the narrow one, not the empty object.
    await expect(subjectScope(ADMIN)).resolves.toEqual({ userId: 'admin-1' });
    expect(vi.mocked(logger.error)).toHaveBeenCalledTimes(3);
    // A platform admin gets no special treatment on the throw path: safe mode
    // does not know who is an admin, because a policy that cannot answer cannot
    // be asked who counts as one.
    await expect(canRead(ADMIN, readSubject('admin-1'))).resolves.toBe(true);
  });

  it('denies the admin surface, but not undeclared reads, in safe mode', async () => {
    // Safe mode is what a failed registration leaves behind. It must be the
    // strictest COHERENT policy: strict enough that a fork's lost narrowing
    // cannot become access, loose enough that an install whose routes declare no
    // subject is not taken down wholesale by an authorization seam.
    await expect(SAFE_MODE_POLICY.canAdminister(ADMIN, null, {})).resolves.toBe(false);
    await expect(SAFE_MODE_POLICY.canRead(ADMIN, readSubject('user-9'), {})).resolves.toBe(false);
    await expect(SAFE_MODE_POLICY.canRead(ADMIN, { kind: 'nothing' }, {})).resolves.toBe(true);
    // Safe mode refuses what it WAS asked about. An unattributed resource is a
    // question it was asked; a route that named nothing is not.
    await expect(
      SAFE_MODE_POLICY.canRead(ADMIN, readTargetFor({ kind: 'report' }), {})
    ).resolves.toBe(false);
    await expect(SAFE_MODE_POLICY.subjectScope(ADMIN, {})).resolves.toEqual({ userId: 'admin-1' });
  });

  it('keeps both read faces agreeing in safe mode too', async () => {
    // Parity is not a fair-weather property. A failure state whose two faces
    // disagree would leak exactly where the operator is least able to look.
    await expect(
      checkAuthorizationParity(SAFE_MODE_POLICY, [
        { label: 'platform admin', viewer: ADMIN, subjects: ['admin-1', 'user-9'] },
        { label: 'admin key', viewer: ADMIN_KEY, subjects: ['user-2', 'user-9'] },
      ])
    ).resolves.toEqual([]);
  });
});

describe('checkAuthorizationParity', () => {
  it('reports a policy whose row read permits what its list hides', async () => {
    // The defect Daybreak's review actually caught, reproduced: `canRead` was
    // widened to teammates and `subjectScope` was left self-only, so the detail
    // page opens a record its own list does not contain.
    const divergent: AuthorizationPolicy = {
      canAdminister: () => Promise.resolve(false),
      canRead: (viewer, target) =>
        Promise.resolve(
          target.kind !== 'subject' ||
            target.userId === viewer.userId ||
            target.userId === 'team-mate'
        ),
      subjectScope: (viewer) => Promise.resolve({ userId: viewer.userId }),
    };

    const violations = await checkAuthorizationParity(divergent, [
      { label: 'a member', viewer: MEMBER, subjects: ['user-1', 'team-mate', 'stranger'] },
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      case: 'a member',
      subject: 'team-mate',
      canRead: true,
      inSubjectScope: false,
    });
    expect(violations[0].message).toContain('comes back empty');
  });

  it('reports the opposite divergence too, and names it differently', async () => {
    // Both directions are real defects and they are not the same defect: this
    // one LEAKS. A checker that only reported the tidy direction would pass the
    // dangerous one.
    const leaky: AuthorizationPolicy = {
      canAdminister: () => Promise.resolve(false),
      canRead: (viewer, target) =>
        Promise.resolve(target.kind !== 'subject' || target.userId === viewer.userId),
      subjectScope: () => Promise.resolve({}),
    };

    const violations = await checkAuthorizationParity(leaky, [
      { viewer: MEMBER, subjects: ['user-1', 'stranger'] },
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ case: 'user-1', subject: 'stranger' });
    expect(violations[0].message).toContain('leaks a row');
  });

  it('refuses a case that names only the viewer, which any policy passes', async () => {
    // The arm this checker was missing, and the one a fork reaches for first.
    // Both faces agree trivially about the viewer, so a self-only case is clean
    // under a correct policy AND under the divergent one above — which is the
    // exact "green because it never looked" failure this function's own docblock
    // claims immunity to.
    const divergent: AuthorizationPolicy = {
      canAdminister: () => Promise.resolve(false),
      canRead: (viewer, target) =>
        Promise.resolve(
          target.kind !== 'subject' ||
            target.userId === viewer.userId ||
            target.userId === 'team-mate'
        ),
      subjectScope: (viewer) => Promise.resolve({ userId: viewer.userId }),
    };

    await expect(
      checkAuthorizationParity(divergent, [{ viewer: MEMBER, subjects: ['user-1'] }])
    ).resolves.toMatchObject([{ case: 'user-1', subject: '(none)' }]);

    // Two subjects that are both the viewer is the same blind spot with an
    // extra element, so the rule is "at least one the viewer is not", not a
    // length check.
    await expect(
      checkAuthorizationParity(divergent, [{ viewer: MEMBER, subjects: ['user-1', 'user-1'] }])
    ).resolves.toMatchObject([{ case: 'user-1', subject: '(none)' }]);
  });

  it('refuses to pass a check that compared nothing', async () => {
    // Both shapes of the "green because it never looked" failure. A parity
    // checker is not exempt from the trap it exists to catch.
    await expect(checkAuthorizationParity(DEFAULT_AUTHORIZATION_POLICY, [])).resolves.toMatchObject(
      [{ case: '(no cases)' }]
    );
    await expect(
      checkAuthorizationParity(DEFAULT_AUTHORIZATION_POLICY, [{ viewer: MEMBER, subjects: [] }])
    ).resolves.toMatchObject([{ case: 'user-1', subject: '(none)' }]);
  });

  it('carries the scope into both faces so a scoped policy is checkable', async () => {
    const seen: string[] = [];
    const scoped: AuthorizationPolicy = {
      canAdminister: () => Promise.resolve(false),
      canRead: (_viewer, _target, scope) => {
        seen.push(`canRead:${scope.ownership ?? '-'}`);
        return Promise.resolve(scope.ownership === 'all');
      },
      subjectScope: (viewer, scope) => {
        seen.push(`subjectScope:${scope.ownership ?? '-'}`);
        return Promise.resolve(scope.ownership === 'all' ? {} : { userId: viewer.userId });
      },
    };

    await expect(
      checkAuthorizationParity(scoped, [
        { viewer: MEMBER, subjects: ['user-1', 'stranger'], scope: { ownership: 'all' } },
      ])
    ).resolves.toEqual([]);
    expect(seen).toEqual(['subjectScope:all', 'canRead:all', 'canRead:all']);
  });
});

describe('subjectFilterSelects', () => {
  it('treats an absent key as every subject, not as a falsy id', () => {
    expect(subjectFilterSelects({}, 'anyone')).toBe(true);
    expect(subjectFilterSelects({ userId: 'user-1' }, 'user-1')).toBe(true);
    expect(subjectFilterSelects({ userId: 'user-1' }, 'user-9')).toBe(false);
  });
});
