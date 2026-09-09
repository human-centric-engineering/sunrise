/**
 * Tests: a route that made no ownership decision is reported
 *
 * This is the half of #367 the seam did not have. `subjectScope` gave owner
 * scoping one name and one implementation, so it could not be *inconsistent* —
 * but nothing made forgetting to call it fail, and a list route that forgets
 * returns 200 with every row while every test about it passes.
 *
 * The whole file is written around one hazard: **a control that has never been
 * shown to fire proves nothing.** So the first test is a deliberately unscoped
 * fixture route that the mechanism reports, and the second is that same route
 * with an unrestricted caller, going quiet. Without the pair, "no violation" is
 * indistinguishable from "the check cannot see anything".
 *
 * The pair also states the design in the only place it can be checked: the
 * obligation exists **only when the caller is actually narrowed**. That runtime
 * fact is what separates a leak from correct behaviour on this axis — a
 * single-tenant install has one class of admin, so a route reading every row is
 * right, and 97 reads in this tree are exactly that.
 *
 * @see lib/auth/guards.ts — `RouteOwnership`, `reportOwnershipGap`
 * @see .context/auth/authorization.md — the marker, and what it cannot see
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('next/headers', () => ({ headers: vi.fn() }));

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));

vi.mock('@/lib/auth/api-keys', () => ({
  resolveApiKey: vi.fn().mockResolvedValue(null),
  hasScope: (scopes: string[], required: string) =>
    scopes.includes(required) || scopes.includes('admin'),
  listValidApiKeyScopes: vi.fn(() => ['chat', 'admin']),
}));

vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { headers } from 'next/headers';
import { auth } from '@/lib/auth/config';
import { resolveApiKey } from '@/lib/auth/api-keys';
import { logger } from '@/lib/logging';
import { withAuth, withAdminAuth, type AuthenticatedSession } from '@/lib/auth/guards';
import {
  DEFAULT_AUTHORIZATION_POLICY,
  registerAuthorizationPolicy,
  __resetAuthorizationPolicyForTests,
  type SubjectFilter,
} from '@/lib/auth/authorization';

function session(role: 'USER' | 'ADMIN' = 'USER', id = 'user_1') {
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

const request = () => new NextRequest('http://localhost:3000/api/v1/widgets');
const ok = () => Response.json({ success: true });

/** The `logger.error` calls this mechanism makes, and nothing else's. */
function ownershipReports(): unknown[] {
  return vi
    .mocked(logger.error)
    .mock.calls.filter(
      (call) => String(call[0]) === 'authorization: a route made no ownership decision'
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

describe('a route that decides nothing, for a caller the policy narrows', () => {
  it('is reported, and the request fails', async () => {
    // The deliberately unscoped fixture route: a plain list handler that reads a
    // table and never asks whose rows it may see. Under the DEFAULT policy a
    // member is narrowed to their own rows, so this request had an ownership
    // question and answered none of it.
    vi.mocked(auth.api.getSession).mockResolvedValue(session('USER'));
    const handler = vi.fn(() => ok());

    const response = await withAuth(handler)(request());

    expect(response.status).toBe(500);
    expect(ownershipReports()).toHaveLength(1);
    // The fix belongs in the log line, not only in a doc: whoever reads this at
    // 2am is reading the log, not `.context/auth/authorization.md`.
    expect(vi.mocked(logger.error).mock.calls[0]?.[2]).toMatchObject({
      path: '/api/v1/widgets',
      guard: 'withAuth',
      declared: '(none)',
    });
  });

  it('goes quiet for a caller the policy does NOT narrow — the same route, unchanged', async () => {
    // The control, and the reason the test above means anything. Identical
    // route, identical handler; the only difference is that this caller may see
    // every subject, so there is no boundary to have forgotten. If this one also
    // reported, the mechanism would be firing on the fixture rather than on the
    // property, and every "clean" result elsewhere would be worthless.
    vi.mocked(auth.api.getSession).mockResolvedValue(session('ADMIN'));
    const handler = vi.fn(() => ok());

    const response = await withAuth(handler)(request());

    expect(response.status).toBe(200);
    expect(ownershipReports()).toHaveLength(0);
    expect(handler).toHaveBeenCalled();
  });

  it('does not pile on when the handler itself threw', async () => {
    // No response means no rows went out, so there is nothing to report — and
    // reporting a missing ownership decision on top of a real failure would bury
    // the failure under a second one that is not what broke.
    vi.mocked(auth.api.getSession).mockResolvedValue(session('USER'));

    const response = await withAuth(() => {
      throw new Error('the handler blew up');
    })(request());

    expect(response.status).toBe(500);
    expect(ownershipReports()).toHaveLength(0);
  });
});

describe('a response that carried no rows', () => {
  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockResolvedValue(session('USER'));
  });

  it("does not report a 'policy' route that returned early", async () => {
    // The trap this closes. The recipe pairs `decidedBy: 'policy'` with the
    // handler shape core itself uses, and 38 guarded routes in this tree open
    // with `if (!rateLimit.success) return createRateLimitResponse(rateLimit)`.
    // A rate-limited request never reaches the `session.subjectFilter` read, so
    // without this the check would turn a correct 429 into a 500 — breaking the
    // routes that were written correctly, on exactly the requests an attacker
    // can provoke.
    const response = await withAuth(
      () => Response.json({ error: 'Too many requests' }, { status: 429 }),
      { ownership: { decidedBy: 'policy' } }
    )(request());

    expect(response.status).toBe(429);
    expect(ownershipReports()).toHaveLength(0);
  });

  it('still reports the same route when it answers 200', async () => {
    // The control. Without it, "no report on a 429" is indistinguishable from
    // "the check stopped working", and the fix for the trap would have quietly
    // disabled the feature.
    const response = await withAuth(() => ok(), { ownership: { decidedBy: 'policy' } })(request());

    expect(response.status).toBe(500);
    expect(ownershipReports()).toHaveLength(1);
  });
});

describe('the four ways to satisfy the obligation', () => {
  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockResolvedValue(session('USER'));
  });

  it("accepts 'self' — keyed on the caller's own id", async () => {
    const response = await withAuth(() => ok(), {
      ownership: { decidedBy: 'self', because: 'Reads only session.user.id.' },
    })(request());

    expect(response.status).toBe(200);
    expect(ownershipReports()).toHaveLength(0);
  });

  it("accepts 'nothing' — no ownership decision, said out loud", async () => {
    const response = await withAuth(() => ok(), {
      ownership: { decidedBy: 'nothing', because: 'A public catalogue; rows have no owner.' },
    })(request());

    expect(response.status).toBe(200);
    expect(ownershipReports()).toHaveLength(0);
  });

  it("accepts 'resource' — the policy decided about the row the resolver named", async () => {
    const response = await withAuth(() => ok(), {
      resource: () => ({ kind: 'widget', id: 'w1', ownerId: 'user_1' }),
      ownership: { decidedBy: 'resource', because: 'Returns only that widget.' },
    })(request());

    expect(response.status).toBe(200);
    expect(ownershipReports()).toHaveLength(0);
  });

  it("warns at route-definition time about 'resource' with no resolver", () => {
    // Said at boot, not per request, because it is a property of how the route
    // is written — the same shape as the `scope` warning above it. This fires
    // even if nobody ever calls the endpoint.
    withAuth(() => ok(), {
      ownership: { decidedBy: 'resource', because: 'Returns only the row the resolver named.' },
    });

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      "withAuth: ownership says 'resource' but the route declares no resource resolver",
      expect.objectContaining({ fix: expect.stringContaining('Add the `resource` resolver') })
    );
  });

  it('does not warn when the resolver is there', () => {
    // The control. A warning that fires on the correct shape too would be noise
    // a fork learns to ignore, and then it catches nothing.
    withAuth(() => ok(), {
      resource: () => ({ kind: 'widget', id: 'w1', ownerId: 'user_1' }),
      ownership: { decidedBy: 'resource', because: 'Returns only that widget.' },
    });

    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });

  it("reports 'resource' declared with no resolver — the arm's whole meaning is gone", async () => {
    // A dropped or renamed `resource` key while copying the users/[id] recipe.
    // The declaration says "the resolver decided"; with no resolver `canRead`
    // was asked about `{ kind: 'nothing' }`, which the default policy always
    // permits — so no decision about any row was ever made, and the declaration
    // would be exempting a route that reads whatever it likes.
    const response = await withAuth(() => ok(), {
      ownership: { decidedBy: 'resource', because: 'Returns only the row the resolver named.' },
    })(request());

    expect(response.status).toBe(500);
    expect(ownershipReports()).toHaveLength(1);
    const context = vi.mocked(logger.error).mock.calls[0]?.[2] as { fix: string };
    expect(context.fix).toContain('supplies no `resource` resolver');
  });

  it('does NOT let a bare resolver exempt the handler', async () => {
    // A resolver used to exempt the whole route automatically, on the grounds
    // that `canRead` had already decided. It decided about ONE ROW — it says
    // nothing about a list of siblings the same handler goes on to run, and that
    // made it the one escape hatch needing no sentence and producing no log
    // line. Now it has to be claimed like the others.
    const response = await withAuth(() => ok(), {
      resource: () => ({ kind: 'widget', id: 'w1', ownerId: 'user_1' }),
    })(request());

    expect(response.status).toBe(500);
    expect(ownershipReports()).toHaveLength(1);
  });

  it("accepts 'policy' when the handler actually reads the filter", async () => {
    let seen: SubjectFilter | undefined;

    const response = await withAuth(
      (_request, s: AuthenticatedSession) => {
        seen = s.subjectFilter;
        return ok();
      },
      { ownership: { decidedBy: 'policy' } }
    )(request());

    expect(response.status).toBe(200);
    expect(ownershipReports()).toHaveLength(0);
    // The filter is the policy's answer for THIS caller, not a constant: a
    // member is narrowed to themselves.
    expect(seen).toEqual({ userId: 'user_1' });
  });

  it("rejects 'policy' when the handler never reads the filter — claiming is not enough", async () => {
    // The mistake this arm exists for, and it is a different mistake from
    // declaring nothing: the author knew the rule, wrote the marker, and the
    // query still went out unnarrowed. It gets its own message for that reason.
    const response = await withAuth(() => ok(), { ownership: { decidedBy: 'policy' } })(request());

    expect(response.status).toBe(500);
    expect(ownershipReports()).toHaveLength(1);

    const context = vi.mocked(logger.error).mock.calls[0]?.[2] as { declared: string; fix: string };
    expect(context.declared).toBe('policy');
    expect(context.fix).toContain('never read session.subjectFilter');
  });
});

describe('withAdminAuth: inert on this install, obligated on a fork that narrows', () => {
  it('asks nothing of an admin route under the default policy', async () => {
    // Why 262 `withAdminAuth` handlers needed no annotation. Everyone who gets
    // past `canAdminister` here is a platform admin, whose `subjectScope` is
    // `{}` — so there is no ownership question on any of them, and adding a
    // field to 262 files to say so would have been ceremony, not a declaration.
    vi.mocked(auth.api.getSession).mockResolvedValue(session('ADMIN'));

    const response = await withAdminAuth(() => ok())(request());

    expect(response.status).toBe(200);
    expect(ownershipReports()).toHaveLength(0);
  });

  it('reports the same route once a fork admits a narrowed admin', async () => {
    // The population this mechanism is FOR: an org-admin tier (#366) whose
    // holder administers a surface but must only see their own org's rows. The
    // moment `canAdminister` says yes and `subjectScope` narrows, every admin
    // route that never asked becomes a question — which is the migration a fork
    // wants surfaced route by route rather than discovered in a support ticket.
    registerAuthorizationPolicy({
      ...DEFAULT_AUTHORIZATION_POLICY,
      canAdminister: () => Promise.resolve(true),
      subjectScope: (viewer) => Promise.resolve({ userId: viewer.userId }),
    });
    vi.mocked(auth.api.getSession).mockResolvedValue(session('USER', 'org_admin_9'));

    const response = await withAdminAuth(() => ok())(request());

    expect(response.status).toBe(500);
    expect(ownershipReports()).toHaveLength(1);
    expect(vi.mocked(logger.error).mock.calls[0]?.[2]).toMatchObject({
      guard: 'withAdminAuth',
      userId: 'org_admin_9',
    });
  });

  it('hands that fork admin the narrowed filter to build their query from', async () => {
    // The other half: the mechanism does not just complain, it supplies. A
    // handler declaring 'policy' gets the fragment to AND into its `where`
    // without reconstructing a principal — the widening bug `AuthenticatedSession`
    // was introduced to remove.
    registerAuthorizationPolicy({
      ...DEFAULT_AUTHORIZATION_POLICY,
      canAdminister: () => Promise.resolve(true),
      subjectScope: (viewer) => Promise.resolve({ userId: viewer.userId }),
    });
    vi.mocked(auth.api.getSession).mockResolvedValue(session('USER', 'org_admin_9'));

    let seen: SubjectFilter | undefined;
    const response = await withAdminAuth(
      (_request, s: AuthenticatedSession) => {
        seen = s.subjectFilter;
        return ok();
      },
      { ownership: { decidedBy: 'policy' } }
    )(request());

    expect(response.status).toBe(200);
    expect(seen).toEqual({ userId: 'org_admin_9' });
    expect(ownershipReports()).toHaveLength(0);
  });
});

describe('the filter the guard hands over', () => {
  it('is the policy answer for the caller, and reading it twice asks nothing twice', async () => {
    // It is a getter, which is unusual enough to be worth pinning: the point of
    // the getter is that READING is observable, not that reading recomputes.
    // A handler that reads it in a loop must not re-enter the policy.
    const scopeCalls: string[] = [];
    registerAuthorizationPolicy({
      ...DEFAULT_AUTHORIZATION_POLICY,
      subjectScope: (viewer) => {
        scopeCalls.push(viewer.userId);
        return Promise.resolve({ userId: viewer.userId });
      },
    });
    vi.mocked(auth.api.getSession).mockResolvedValue(session('USER'));

    const response = await withAuth(
      (_request, s: AuthenticatedSession) => {
        const first = s.subjectFilter;
        const second = s.subjectFilter;
        expect(first).toBe(second);
        return ok();
      },
      { ownership: { decidedBy: 'policy' } }
    )(request());

    expect(response.status).toBe(200);
    expect(scopeCalls).toEqual(['user_1']);
  });

  it('is not computed for a route that said it does not need it', async () => {
    // The filter is only asked for when the check needs it (nothing declared) or
    // the handler does (`'policy'`). On the other 284 of this tree's 285 guarded
    // routes nobody reads it, and a fork whose `subjectScope` does a membership
    // lookup should not pay a round-trip per request for a discarded value.
    const scopeCalls: string[] = [];
    registerAuthorizationPolicy({
      ...DEFAULT_AUTHORIZATION_POLICY,
      subjectScope: (viewer) => {
        scopeCalls.push(viewer.userId);
        return Promise.resolve({ userId: viewer.userId });
      },
    });
    vi.mocked(auth.api.getSession).mockResolvedValue(session('USER'));

    await withAuth(() => ok(), {
      ownership: { decidedBy: 'self', because: 'Reads only session.user.id.' },
    })(request());

    expect(scopeCalls).toEqual([]);
  });

  it('answers the NARROWEST value when it was not computed, and says so', async () => {
    // The dangerous way to implement the optimisation above is to hand back
    // `{}` — the WIDEST value this type can express. A `'self'` route reading it
    // would be told "every subject" and could build an unnarrowed query out of
    // it: the exact leak, delivered by the mechanism meant to prevent it.
    //
    // So it answers the reader's own id instead. A query built from that returns
    // too FEW rows, never too many, and the mistake is loud in the log rather
    // than a 500 for real users — which is the same trade `subjectScope`'s own
    // wrapper makes with a policy it cannot trust, and the same one
    // OWNERSHIP_GAP_ACTION makes two functions up.
    vi.mocked(auth.api.getSession).mockResolvedValue(session('USER'));

    const response = await withAuth(
      (_request, s: AuthenticatedSession) => Response.json({ filter: s.subjectFilter }),
      { ownership: { decidedBy: 'self', because: 'Reads only session.user.id.' } }
    )(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ filter: { userId: 'user_1' } });
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      'authorization: subjectFilter read on a route that did not ask for it',
      undefined,
      expect.objectContaining({ declared: 'self' })
    );
  });

  it('is a copy, so a handler cannot contaminate the next request through it', async () => {
    // The policy here caches one filter object and returns it every time —
    // the natural shape for a fork that memoises a membership lookup, and the
    // reason the guard copies rather than handing the reference over. A handler
    // that widens its own copy must not widen the next caller's scope.
    const cached: SubjectFilter = { userId: 'user_1' };
    registerAuthorizationPolicy({
      ...DEFAULT_AUTHORIZATION_POLICY,
      subjectScope: () => Promise.resolve(cached),
    });
    vi.mocked(auth.api.getSession).mockResolvedValue(session('USER'));

    const widen = withAuth(
      (_request, s: AuthenticatedSession) => {
        const mine = s.subjectFilter;
        delete mine.userId; // "every subject" — the widest value this type has
        return ok();
      },
      { ownership: { decidedBy: 'policy' } }
    );
    await widen(request());

    let secondCaller: SubjectFilter | undefined;
    await withAuth(
      (_request, s: AuthenticatedSession) => {
        secondCaller = s.subjectFilter;
        return ok();
      },
      { ownership: { decidedBy: 'policy' } }
    )(request());

    expect(secondCaller).toEqual({ userId: 'user_1' });
    // And the policy's own object is untouched, which is the other direction:
    // the guard must not mutate something it does not own either.
    expect(cached).toEqual({ userId: 'user_1' });
  });

  it('is not consumed by a handler that merely spreads the session', async () => {
    // The way a checkable claim could have been fooled: `{ ...session }` copies
    // enumerable properties, so an enumerable getter would fire on a handler
    // that logged the session and never narrowed anything — and the route would
    // pass while leaking. `subjectFilter` is non-enumerable for exactly this,
    // and the assertion below is what stops that being a comment.
    vi.mocked(auth.api.getSession).mockResolvedValue(session('USER'));

    const response = await withAuth(
      (_request, s: AuthenticatedSession) => {
        const copy = { ...s };
        expect('subjectFilter' in copy).toBe(false);
        return ok();
      },
      { ownership: { decidedBy: 'policy' } }
    )(request());

    // Reported: spreading is not reading, so this route still owes its decision.
    expect(response.status).toBe(500);
    expect(ownershipReports()).toHaveLength(1);
  });

  it('is still reachable by name after that', async () => {
    // The control for the test above: non-enumerable must not mean unreadable,
    // or the fix would have broken the feature and both tests would still be
    // green about the wrong thing.
    vi.mocked(auth.api.getSession).mockResolvedValue(session('USER'));

    const response = await withAuth(
      (_request, s: AuthenticatedSession) => Response.json({ filter: s.subjectFilter }),
      { ownership: { decidedBy: 'policy' } }
    )(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ filter: { userId: 'user_1' } });
    expect(ownershipReports()).toHaveLength(0);
  });

  it('still satisfies a handler that only wants the session', async () => {
    // `AuthenticatedSession` gained a required member, so this asserts the
    // additive claim rather than leaving it to the type-checker's mood: a
    // handler written against the old shape keeps compiling and running.
    vi.mocked(auth.api.getSession).mockResolvedValue(session('USER'));

    const response = await withAuth((_request, s) => Response.json({ id: s.user.id }), {
      ownership: { decidedBy: 'self', because: 'Reads only session.user.id.' },
    })(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: 'user_1' });
  });
});
