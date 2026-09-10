/**
 * Tests: the guards route their decision through the authorization policy
 *
 * `guards.test.ts` covers what the guards DO — 401s, 403s, params, error
 * routing — and all forty of its tests pass unchanged across this wiring, which
 * is the behaviour-neutrality evidence at the guard rather than at 262 handlers.
 * This file covers the wiring itself, which that file cannot see: it asserts the
 * call the guard makes into the policy, and that replacing the policy replaces
 * the outcome.
 *
 * Separate file because these need the REAL `lib/auth/authorization` (a
 * registered policy has to reach the guard) while `guards.test.ts` needs neither
 * and would carry the registration state of every test in it.
 *
 * The load-bearing one is "no resolver ⇒ the policy is asked about null". It is
 * the arm every core route takes, and the task it comes from asks for it to be
 * asserted rather than assumed — an inert seam whose inertness is only claimed
 * is how a behaviour-neutral PR changes behaviour.
 *
 * @see lib/auth/guards.ts · lib/auth/authorization.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('next/headers', () => ({ headers: vi.fn() }));

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));

vi.mock('@/lib/auth/api-keys', () => ({
  resolveApiKey: vi.fn().mockResolvedValue(null),
  hasScope: (scopes: string[], required: string) =>
    scopes.includes(required) || scopes.includes('admin'),
  listValidApiKeyScopes: vi.fn(() => ['chat', 'analytics', 'knowledge', 'webhook', 'admin']),
}));

vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { logger } from '@/lib/logging';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth/config';
import { resolveApiKey } from '@/lib/auth/api-keys';
import { withAuth, withAdminAuth, type AuthSession } from '@/lib/auth/guards';
import {
  DEFAULT_AUTHORIZATION_POLICY,
  registerAuthorizationPolicy,
  __resetAuthorizationPolicyForTests,
  type AuthorizationPrincipal,
  type AuthorizationResource,
  type AuthorizationScope,
  __resetOwnerlessWarningsForTests,
  type ReadTarget,
} from '@/lib/auth/authorization';
import { UNATTRIBUTED_READ_KINDS, type UnattributedReads } from '@/lib/auth/orphan-reads';

/**
 * Most fixtures in this file wrap a stub handler to test *authentication*, and a
 * bare `withAuth(handler)` is now a violation for a member session: the default
 * policy narrows a non-admin to their own rows, and a route that never says how
 * it decides whose rows it reads is what `RouteOwnership` exists to catch. So
 * these say it — and saying "this test is not about ownership" out loud is more
 * honest than an admin session quietly sidestepping the check.
 */
const NOT_ABOUT_OWNERSHIP = {
  ownership: {
    decidedBy: 'nothing',
    because: 'Fixture: this test is about the guard, not about whose rows the route reads.',
  },
} as const;

// No `AuthSession` return annotation on purpose: `auth.api.getSession`'s mocked
// type infers `role` as REQUIRED, and annotating the helper widens it back to
// optional, which the mock then rejects. The literal's own inferred type is what
// satisfies both call sites.
function session(role: 'USER' | 'ADMIN' | null = 'USER', id = 'user_1') {
  return {
    session: {
      id: 'session_1',
      userId: id,
      token: 'tok',
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    user: {
      id,
      name: 'Test User',
      email: 'test@example.com',
      emailVerified: true,
      image: null,
      role,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
}

const request = () => new NextRequest('http://localhost:3000/api/v1/test');
const ok = () => Response.json({ success: true });

interface AdministerCall {
  viewer: AuthorizationPrincipal;
  resource: AuthorizationResource | null;
  scope: AuthorizationScope;
}
interface ReadCall {
  viewer: AuthorizationPrincipal;
  target: ReadTarget;
}

/** A policy that records what it was asked and answers `verdict`. */
function recordingPolicy(verdict: boolean, administered: AdministerCall[], read: ReadCall[]) {
  return {
    ...DEFAULT_AUTHORIZATION_POLICY,
    canAdminister: (
      viewer: AuthorizationPrincipal,
      resource: AuthorizationResource | null,
      scope: AuthorizationScope
    ) => {
      administered.push({ viewer, resource, scope });
      return Promise.resolve(verdict);
    },
    canRead: (viewer: AuthorizationPrincipal, target: ReadTarget) => {
      read.push({ viewer, target });
      return Promise.resolve(verdict);
    },
  };
}

/**
 * The reads a route's own decision produced, with the guards' per-request
 * ownerless precompute filtered out.
 *
 * Before the handler runs, both guards ask the policy — once per core kind —
 * whether this caller may read rows nobody owns, to fill
 * `session.unattributedReads`. Those calls are real, and they have their own
 * assertions below; in the tests about a route's own read decision they are
 * noise, and spelling all four into every expectation would bury the one call
 * each test is about.
 */
function routeReads(read: ReadCall[]): ReadCall[] {
  return read.filter(
    (call) =>
      !(call.target.kind === 'unattributed' && call.target.asking === 'any-row-of-this-kind')
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(headers).mockResolvedValue(new Headers());
  vi.mocked(resolveApiKey).mockResolvedValue(null);
});

afterEach(() => {
  __resetAuthorizationPolicyForTests();
});

describe('withAuth asks the policy about the subject', () => {
  it('asks about null when the route named no resource — the arm every core route takes', async () => {
    const read: ReadCall[] = [];
    registerAuthorizationPolicy(recordingPolicy(true, [], read));
    vi.mocked(auth.api.getSession).mockResolvedValue(session());

    const response = await withAuth(() => ok(), NOT_ABOUT_OWNERSHIP)(request());

    expect(response.status).toBe(200);
    expect(routeReads(read)).toEqual([
      {
        viewer: { userId: 'user_1', role: 'USER', credential: 'session', scopes: undefined },
        target: { kind: 'nothing' },
      },
    ]);
  });

  it('passes the resolved owner as the subject', async () => {
    const read: ReadCall[] = [];
    registerAuthorizationPolicy(recordingPolicy(true, [], read));
    vi.mocked(auth.api.getSession).mockResolvedValue(session());

    await withAuth(() => ok(), {
      resource: () => ({ kind: 'thing', id: 't1', ownerId: 'owner_9' }),
    })(request());

    expect(routeReads(read).map((call) => call.target)).toEqual([
      {
        kind: 'subject',
        userId: 'owner_9',
        resource: { kind: 'thing', id: 't1', ownerId: 'owner_9' },
      },
    ]);
  });

  it('403s a foreign owner under the default policy, without running the handler', async () => {
    // The default policy on a REAL denial rather than a recorded one: this is
    // #367's shape working end to end through the guard.
    vi.mocked(auth.api.getSession).mockResolvedValue(session('USER', 'user_1'));
    const handler = vi.fn(() => ok());

    const response = await withAuth(handler, {
      resource: () => ({ ownerId: 'somebody_else' }),
    })(request());

    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it('lets a platform admin read another owner’s resource', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(session('ADMIN', 'admin_1'));

    const response = await withAuth(() => ok(), {
      resource: () => ({ ownerId: 'somebody_else' }),
    })(request());

    expect(response.status).toBe(200);
  });

  it('does not read an ownerless resource as an unscoped route', async () => {
    // The finding /security-review caught. `subject` used to be the ONLY thing
    // that reached `canRead`, so a resolver naming `{ kind, id, orgId }` — an
    // org-owned row, or a nullable `createdBy` on a SetNull model — arrived as
    // `null` and hit the same allow arm as "this route named nothing". Every
    // caller passed, on a route that looked scoped in the diff and in the log,
    // and a fork could not fix it in its own policy because core discarded the
    // information first.
    vi.mocked(auth.api.getSession).mockResolvedValue(session('USER', 'user_1'));
    const handler = vi.fn(() => ok());

    const response = await withAuth(handler, {
      resource: () => ({ kind: 'report', id: 'r1', orgId: 'org_7' }),
    })(request());

    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it('hands the whole resource to the read face, not just the owner it derived', async () => {
    // Why the assertion above holds rather than being a coincidence: the read
    // face now sees what the admin face always saw. Without this, the fix is one
    // `if` in the default policy that a fork replacing the policy loses.
    const seen: ReadTarget[] = [];
    registerAuthorizationPolicy({
      ...DEFAULT_AUTHORIZATION_POLICY,
      canRead: (_viewer, target) => {
        seen.push(target);
        return Promise.resolve(true);
      },
    });
    vi.mocked(auth.api.getSession).mockResolvedValue(session());

    await withAuth(() => ok(), {
      resource: () => ({ kind: 'report', id: 'r1', orgId: 'org_7' }),
    })(request());
    await withAuth(() => ok(), NOT_ABOUT_OWNERSHIP)(request());

    // The union names the state instead of leaving it to be inferred from a
    // null: the ownerless row is 'unattributed', the resolver-less route is
    // 'nothing', and neither can be mistaken for the other.
    expect(
      seen.filter((target) => target.kind !== 'unattributed' || target.asking === 'this-row')
    ).toEqual([
      {
        kind: 'unattributed',
        asking: 'this-row',
        resource: { kind: 'report', id: 'r1', orgId: 'org_7' },
      },
      { kind: 'nothing' },
    ]);
  });

  it('denies when the resolver names nothing, rather than reading it as unscoped', async () => {
    // The likeliest thing a real resolver does: `findUnique` answers `null` for
    // a deleted row, or one its own `where` excluded. That used to produce the
    // same value as "this route declared no resolver", which the default policy
    // permits — so the handler ran with no ownership check on a route that looks
    // scoped in the diff and in the log. `null` from a resolver now denies.
    const read: ReadCall[] = [];
    registerAuthorizationPolicy(recordingPolicy(true, [], read));
    vi.mocked(auth.api.getSession).mockResolvedValue(session());
    const handler = vi.fn(() => ok());

    const response = await withAuth(handler, { resource: () => null })(request());

    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    // Not even asked: an unresolved scope is not a question the policy can
    // answer, so it is refused in front of it.
    expect(read).toEqual([]);
  });

  it('still allows the route that declares no resolver at all', async () => {
    // The contrast that makes the assertion above a rule rather than a blanket
    // denial — and the arm every core route takes.
    vi.mocked(auth.api.getSession).mockResolvedValue(session());
    const handler = vi.fn(() => ok());

    const response = await withAuth(handler, NOT_ABOUT_OWNERSHIP)(request());

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('denies when the resolver throws, rather than asking about a null subject', async () => {
    // The distinction the `RESOLVER_FAILED` sentinel exists for. Collapsing a
    // failed resolution into "no resource" would hand the policy `null` — which
    // the default policy PERMITS — so a resolver crash would read as an
    // unscoped route and quietly allow the request.
    const read: ReadCall[] = [];
    registerAuthorizationPolicy(recordingPolicy(true, [], read));
    vi.mocked(auth.api.getSession).mockResolvedValue(session());
    const handler = vi.fn(() => ok());

    const response = await withAuth(handler, {
      resource: () => {
        throw new Error('lookup failed');
      },
    })(request());

    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    expect(read).toEqual([]);
  });

  it('describes an API-key caller as one, with its scopes', async () => {
    // The credential is the difference between "this user's role" and "this
    // key's scopes", and a policy that cannot tell them apart cannot implement
    // Q6. Passed rather than sniffed, because the guard already knows.
    const read: ReadCall[] = [];
    registerAuthorizationPolicy(recordingPolicy(true, [], read));
    vi.mocked(resolveApiKey).mockResolvedValue({
      session: session('USER', 'key_owner'),
      scopes: ['chat'],
      rateLimitRpm: null,
    });

    await withAuth(() => ok(), NOT_ABOUT_OWNERSHIP)(request());

    expect(read[0].viewer).toEqual({
      userId: 'key_owner',
      role: 'USER',
      credential: 'api-key',
      scopes: ['chat'],
    });
  });
});

describe('withAdminAuth asks the policy whether to admit', () => {
  it('asks with a null resource when the route named none', async () => {
    const administered: AdministerCall[] = [];
    registerAuthorizationPolicy(recordingPolicy(true, administered, []));
    vi.mocked(auth.api.getSession).mockResolvedValue(session('ADMIN', 'admin_1'));

    const response = await withAdminAuth(() => ok(), NOT_ABOUT_OWNERSHIP)(request());

    expect(response.status).toBe(200);
    expect(administered).toEqual([
      {
        viewer: { userId: 'admin_1', role: 'ADMIN', credential: 'session', scopes: undefined },
        resource: null,
        scope: {},
      },
    ]);
  });

  it('admits a non-admin when the policy says so — the seam is a seam', async () => {
    // The proof the extraction is worth anything: same principal, same route,
    // opposite outcome, and not one of the 262 call sites changed. Under the
    // default policy this is the 403 asserted below it.
    registerAuthorizationPolicy({
      ...DEFAULT_AUTHORIZATION_POLICY,
      canAdminister: (viewer) => Promise.resolve(viewer.userId === 'org_admin'),
    });
    vi.mocked(auth.api.getSession).mockResolvedValue(session('USER', 'org_admin'));

    await expect(withAdminAuth(() => ok(), NOT_ABOUT_OWNERSHIP)(request())).resolves.toHaveProperty(
      'status',
      200
    );
  });

  it('refuses a platform admin when the policy says so', async () => {
    registerAuthorizationPolicy({
      ...DEFAULT_AUTHORIZATION_POLICY,
      canAdminister: (viewer) => Promise.resolve(viewer.userId === 'org_admin'),
    });
    vi.mocked(auth.api.getSession).mockResolvedValue(session('ADMIN', 'admin_1'));
    const handler = vi.fn(() => ok());

    const response = await withAdminAuth(handler, NOT_ABOUT_OWNERSHIP)(request());
    const body = (await response.json()) as { error: { message: string } };

    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    // The message follows the credential, so a person still reads the sentence
    // this guard has always given them.
    expect(body.error.message).toBe('Admin access required');
  });

  it('passes the resolved resource to the policy', async () => {
    const administered: AdministerCall[] = [];
    registerAuthorizationPolicy(recordingPolicy(true, administered, []));
    vi.mocked(auth.api.getSession).mockResolvedValue(session('ADMIN', 'admin_1'));

    await withAdminAuth(() => ok(), {
      resource: () => ({ kind: 'agent', id: 'a1', orgId: 'org_7' }),
    })(request());

    expect(administered[0].resource).toEqual({ kind: 'agent', id: 'a1', orgId: 'org_7' });
  });

  it('keeps the API-key scope check as a floor the policy cannot widen', async () => {
    // Q6 in one assertion. A fork policy that admits everyone still does not
    // admit a key without the `admin` scope, because that scope is the
    // cross-tenant bypass and the guard refuses before the policy is consulted.
    const administered: AdministerCall[] = [];
    registerAuthorizationPolicy(recordingPolicy(true, administered, []));
    vi.mocked(resolveApiKey).mockResolvedValue({
      session: session('ADMIN', 'key_owner'),
      scopes: ['chat'],
      rateLimitRpm: null,
    });

    const response = await withAdminAuth(() => ok(), NOT_ABOUT_OWNERSHIP)(request());
    const body = (await response.json()) as { error: { message: string } };

    expect(response.status).toBe(403);
    expect(body.error.message).toBe('Admin scope required');
    expect(administered).toEqual([]);
  });

  it('lets the policy narrow an admin-scoped key, which the floor does not do', async () => {
    // The other half of "floor, not decision": the guard cannot widen the key
    // path, and the policy cannot bypass the floor — but the policy can still
    // refuse a key the floor admitted.
    registerAuthorizationPolicy({
      ...DEFAULT_AUTHORIZATION_POLICY,
      canAdminister: () => Promise.resolve(false),
    });
    vi.mocked(resolveApiKey).mockResolvedValue({
      session: session('ADMIN', 'key_owner'),
      scopes: ['admin'],
      rateLimitRpm: null,
    });

    const response = await withAdminAuth(() => ok(), NOT_ABOUT_OWNERSHIP)(request());
    const body = (await response.json()) as { error: { message: string } };

    expect(response.status).toBe(403);
    // NOT 'Admin scope required'. The floor above already passed, so the key is
    // the one thing that is fine — sending an operator to look at it is the
    // wrong answer, and in safe mode it is the answer they would always get.
    expect(body.error.message).toBe('Admin access required');
  });

  it('refuses a resolver that named nothing, without running the handler', async () => {
    const handler = vi.fn(() => ok());
    vi.mocked(auth.api.getSession).mockResolvedValue(session('ADMIN', 'admin_1'));

    const response = await withAdminAuth(handler, { resource: () => null })(request());

    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('the handler receives the principal the guard actually decided with', () => {
  // The property: ONE principal per request. The guard asks `canRead` /
  // `canAdminister` with it, and the handler asks `subjectScope` with the same
  // object — so the two faces of the policy cannot disagree because the caller
  // rebuilt the viewer differently from the guard.
  //
  // Before this, a handler could only reconstruct one, and the plausible
  // reconstruction (`credential: 'session'` from the session it was handed) is
  // wrong in the WIDENING direction for every API-key caller. The api-key test
  // below is the control for exactly that: it fails against a guard that
  // hardcodes the credential, or that drops `scopes`.

  it('hands a session caller the same principal object it asked the policy about', async () => {
    const read: ReadCall[] = [];
    registerAuthorizationPolicy(recordingPolicy(true, [], read));
    vi.mocked(auth.api.getSession).mockResolvedValue(session('ADMIN', 'admin_1'));

    let seen: AuthorizationPrincipal | undefined;
    await withAuth((_request, s) => {
      seen = s.principal;
      return ok();
    }, NOT_ABOUT_OWNERSHIP)(request());

    expect(seen).toEqual({
      userId: 'admin_1',
      role: 'ADMIN',
      credential: 'session',
      scopes: undefined,
    });
    // Identity, not just equality: one object, so there is nothing to drift.
    expect(seen).toBe(read[0]?.viewer);
  });

  it('hands an api-key caller the key’s credential AND scopes, not the session shape', async () => {
    const read: ReadCall[] = [];
    registerAuthorizationPolicy(recordingPolicy(true, [], read));
    // A role that WOULD read as platform admin, on a key that is not admin-scoped.
    // This is the combination the widening bug turned into "every subject".
    vi.mocked(resolveApiKey).mockResolvedValue({
      session: session('ADMIN', 'admin_1'),
      scopes: ['chat'],
      rateLimitRpm: null,
    });

    let seen: AuthorizationPrincipal | undefined;
    await withAuth((_request, s) => {
      seen = s.principal;
      return ok();
    }, NOT_ABOUT_OWNERSHIP)(request());

    expect(seen?.credential).toBe('api-key');
    expect(seen?.scopes).toEqual(['chat']);
    expect(seen).toBe(read[0]?.viewer);
  });

  it('hands withAdminAuth’s handler the principal too', async () => {
    const administered: AdministerCall[] = [];
    registerAuthorizationPolicy(recordingPolicy(true, administered, []));
    vi.mocked(auth.api.getSession).mockResolvedValue(session('ADMIN', 'admin_1'));

    let seen: AuthorizationPrincipal | undefined;
    await withAdminAuth((_request, s) => {
      seen = s.principal;
      return ok();
    }, NOT_ABOUT_OWNERSHIP)(request());

    // Both of these before the identity check, because `toBe` on two
    // `undefined`s passes: if the guard ever denies BEFORE asking the policy,
    // `seen` and `administered[0]?.viewer` are both undefined and this test
    // goes green having exercised nothing.
    expect(administered).toHaveLength(1);
    expect(seen).toBeDefined();
    expect(seen).toBe(administered[0]?.viewer);
  });

  it('reaches a route with NO params, which is where the list face is needed', async () => {
    // `context` is undefined for a non-dynamic route, so anything hung off the
    // route context would be unreachable exactly where `subjectScope` is called.
    // That is why the principal rides on the session instead.
    registerAuthorizationPolicy(recordingPolicy(true, [], []));
    vi.mocked(auth.api.getSession).mockResolvedValue(session());

    let seen: AuthorizationPrincipal | undefined;
    const response = await withAuth((_request, s) => {
      seen = s.principal;
      return ok();
    }, NOT_ABOUT_OWNERSHIP)(request());

    expect(response.status).toBe(200);
    expect(seen?.userId).toBe('user_1');
  });

  it('still satisfies a handler declared with the narrower AuthSession', async () => {
    // The additive claim: existing handlers keep compiling. If this stops type-
    // checking, `AuthenticatedSession` stopped being assignable to `AuthSession`
    // and every one of the 285 guarded handlers is a breaking change.
    registerAuthorizationPolicy(recordingPolicy(true, [], []));
    vi.mocked(auth.api.getSession).mockResolvedValue(session());

    const legacy = (_request: NextRequest, s: AuthSession) => Response.json({ id: s.user.id });
    const response = await withAuth(legacy, NOT_ABOUT_OWNERSHIP)(request());

    expect(response.status).toBe(200);
  });
});

describe('the handler receives the ownerless-read answer, already decided', () => {
  // The property: **one policy call per kind per request, and the readers built
  // on it are synchronous.** Four core models can hold a row nobody owns —
  // conversations and executions born that way, datasets and experiments left
  // that way by an Art. 17 erasure — and the helpers that build their `where`
  // fragments compose inline inside larger objects, where an `await` has nowhere
  // clean to go.
  //
  // Deliberately eager, including on requests that touch none of those models.
  // On a default install the built-in rule does no I/O, so it is free; a fork
  // whose policy hits a database pays a fixed cost per request and should cache
  // inside its own policy. See `lib/auth/orphan-reads.ts`.

  it('hands a platform admin the default answer for every core kind', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(session('ADMIN', 'admin_1'));

    let seen: UnattributedReads | undefined;
    const response = await withAdminAuth((_request, s) => {
      seen = s.unattributedReads;
      return ok();
    }, NOT_ABOUT_OWNERSHIP)(request());

    expect(response.status).toBe(200);
    expect(seen).toEqual({
      conversation: true,
      dataset: true,
      execution: true,
      experiment: true,
    });
  });

  it('hands a member the same shape with every answer denied', async () => {
    // Total, not a set of the permitted kinds: a denied kind is present and
    // `false`, so a handler cannot read "denied" and "nobody asked" the same
    // way. That collapse is what `ReadTarget` exists to prevent, and it would be
    // no better here.
    vi.mocked(auth.api.getSession).mockResolvedValue(session('USER', 'user_1'));

    let seen: UnattributedReads | undefined;
    await withAuth((_request, s) => {
      seen = s.unattributedReads;
      return ok();
    }, NOT_ABOUT_OWNERSHIP)(request());

    expect(seen).toEqual({
      conversation: false,
      dataset: false,
      execution: false,
      experiment: false,
    });
  });

  it('lets a fork narrow one kind and not another, which is the whole capability', async () => {
    // Today `conversation-access.ts` and `execution-access.ts` hard-code "every
    // admin sees every ownerless row" and never ask the policy, so this is
    // impossible. A customer tier needs exactly this shape: a tenant's admin may
    // audit their own abandoned datasets without reading another tenant's
    // inbound correspondence.
    registerAuthorizationPolicy({
      ...DEFAULT_AUTHORIZATION_POLICY,
      canRead: (viewer, target, scope) =>
        target.kind === 'unattributed' && target.asking === 'any-row-of-this-kind'
          ? Promise.resolve(target.resource.kind === 'dataset')
          : DEFAULT_AUTHORIZATION_POLICY.canRead(viewer, target, scope),
    });
    vi.mocked(auth.api.getSession).mockResolvedValue(session('ADMIN', 'admin_1'));

    let seen: UnattributedReads | undefined;
    await withAdminAuth((_request, s) => {
      seen = s.unattributedReads;
      return ok();
    }, NOT_ABOUT_OWNERSHIP)(request());

    expect(seen).toEqual({
      conversation: false,
      dataset: true,
      execution: false,
      experiment: false,
    });
  });

  it('asks exactly once per kind, in roster order, before the handler runs', async () => {
    // The reason for precomputing at all. Before this, each reader asked for
    // itself: a list and the detail rows it links to could be answered by two
    // separate policy calls, and a fork policy reading mutable state could
    // answer them differently within one request.
    //
    // What this asserts is the CALL COUNT and the kinds — not that repeated
    // reads are free. An earlier version of this test read the record three
    // times to "prove" that; those reads were decorative, because reading a
    // plain object property cannot issue a policy call under any implementation
    // of this design. A test whose demonstration cannot fail is worse than one
    // that does not attempt it.
    const read: ReadCall[] = [];
    registerAuthorizationPolicy(recordingPolicy(true, [], read));
    vi.mocked(auth.api.getSession).mockResolvedValue(session('ADMIN', 'admin_1'));

    let seenInHandler: UnattributedReads | undefined;
    await withAdminAuth((_request, s) => {
      // Read once, to pin that the record is populated by the time the handler
      // runs rather than filled afterwards.
      seenInHandler = s.unattributedReads;
      return ok();
    }, NOT_ABOUT_OWNERSHIP)(request());

    expect(seenInHandler).toEqual({
      conversation: true,
      dataset: true,
      execution: true,
      experiment: true,
    });

    const probes = read.filter(
      (call) => call.target.kind === 'unattributed' && call.target.asking === 'any-row-of-this-kind'
    );
    // Derived from the roster, not spelled again: `orphan-reads.ts` says nothing
    // depends on the order, and a hard-coded list here would quietly make that
    // false — adding a kind would fail this test for the wrong reason.
    expect(probes).toHaveLength(UNATTRIBUTED_READ_KINDS.length);
    expect(
      probes.map((call) => (call.target.kind === 'unattributed' ? call.target.resource.kind : null))
    ).toEqual([...UNATTRIBUTED_READ_KINDS]);
  });

  it('survives a spread of the session, unlike subjectFilter', async () => {
    // `subjectFilter` is a non-enumerable getter because *reading* it is what
    // makes `ownership: { decidedBy: 'policy' }` checkable, and a spread would
    // record it as consumed by a handler that never used it. Nothing observes
    // this one, so it is an ordinary property — and a helper that reshapes the
    // session (`{ ...session, user: redact(session.user) }`) still carries it
    // rather than silently handing on `undefined`.
    vi.mocked(auth.api.getSession).mockResolvedValue(session('ADMIN', 'admin_1'));

    let seen: UnattributedReads | undefined;
    await withAdminAuth((_request, s) => {
      seen = { ...s }.unattributedReads;
      return ok();
    }, NOT_ABOUT_OWNERSHIP)(request());

    expect(seen).toEqual({
      conversation: true,
      dataset: true,
      execution: true,
      experiment: true,
    });
  });

  it('does not log the resolver diagnostic while asking — on any of the four kinds', async () => {
    // The regression this task closes. The `'unattributed'` arm serves two
    // questions, and the default policy's warning is written for the other one:
    // "a route named a resource with no ownerId — give the resolver one". Asking
    // the capability question used to trip it, so an install serving experiments
    // and datasets logged two false alarms naming a resolver that does not
    // exist. Precomputing would have made it four, on every guarded request.
    __resetOwnerlessWarningsForTests();
    vi.mocked(auth.api.getSession).mockResolvedValue(session('ADMIN', 'admin_1'));

    const response = await withAdminAuth(() => ok(), NOT_ABOUT_OWNERSHIP)(request());

    expect(response.status).toBe(200);
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });

  it('still logs it for a resolver that named a row it could not attribute', async () => {
    // The control for the test above, through the guard rather than the policy:
    // a real misconfiguration must still be heard. Without this, "no warning" is
    // satisfied just as well by having deleted the warning.
    //
    // `withAuth`, because it is the guard that asks `canRead` — `withAdminAuth`
    // hands its resolved resource to `canAdminister`, which has no such
    // diagnostic to trip.
    __resetOwnerlessWarningsForTests();
    vi.mocked(auth.api.getSession).mockResolvedValue(session('ADMIN', 'admin_1'));

    const response = await withAuth(() => ok(), {
      ...NOT_ABOUT_OWNERSHIP,
      resource: () => ({ kind: 'report', id: 'r1' }),
    })(request());

    expect(response.status).toBe(200);

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('no ownerId'),
      expect.objectContaining({ kind: 'report' })
    );
  });
});
