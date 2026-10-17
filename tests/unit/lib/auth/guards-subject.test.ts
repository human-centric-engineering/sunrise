/**
 * Tests: the guards enter the subject context for every handler they run (§115 t-800)
 *
 * What the data layer will read (t-801) must be what the route was told:
 *
 * - a narrowed caller (a member, a non-admin API key) is narrowed to themselves,
 *   and a platform admin or an `admin` key is not — the policy's answer, not a
 *   second rule;
 * - where the guard already asked the policy (a `'policy'` route), the data
 *   layer gets that same answer and the policy is asked once;
 * - where it did not (`'self'` / `'nothing'`), the policy is asked only if
 *   something reads the subject — never for a handler that does not;
 * - nothing leaks after the response.
 *
 * Driven through the real guards and the real default policy, with the auth
 * session and the membership read mocked as `guards-tenancy.test.ts` does.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'single' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

vi.mock('@/lib/db/client', () => ({
  prisma: { orgMembership: { findUnique: vi.fn() }, org: { findMany: vi.fn() } },
}));

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
import { withAuth, withAdminAuth, type AuthenticatedSession } from '@/lib/auth/guards';
import {
  DEFAULT_AUTHORIZATION_POLICY,
  registerAuthorizationPolicy,
  __resetAuthorizationPolicyForTests,
  type SubjectFilter,
} from '@/lib/auth/authorization';
import { getSubjectReadScope, type SubjectReadScope } from '@/lib/auth/subject-context';

function session(role: 'USER' | 'ADMIN') {
  return {
    session: {
      id: 'session_1',
      userId: 'user_1',
      token: 'tok',
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date(),
      updatedAt: new Date(),
      activeOrgId: null,
    },
    user: {
      id: 'user_1',
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

/** A key fixture. An admin-scoped key is owned by a platform admin (#746). */
function apiKey(scopes: string[]) {
  return {
    session: session(scopes.includes('admin') ? 'ADMIN' : 'USER'),
    scopes,
    rateLimitRpm: null,
    orgId: null,
    ownerAccountType: 'HUMAN',
  };
}

const request = () => new NextRequest('http://localhost:3000/api/v1/test');
const ok = () => Response.json({ success: true });
const SELF = { ownership: { decidedBy: 'self', because: 'Fixture.' } } as const;
const POLICY = { ownership: { decidedBy: 'policy' } } as const;

/** The default policy, with its list face counted. */
const subjectScopeSpy = vi.fn(DEFAULT_AUTHORIZATION_POLICY.subjectScope);

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.TENANCY_MODE = 'single';
  vi.mocked(headers).mockResolvedValue(new Headers());
  vi.mocked(resolveApiKey).mockResolvedValue(null);
  registerAuthorizationPolicy({ ...DEFAULT_AUTHORIZATION_POLICY, subjectScope: subjectScopeSpy });
});

afterEach(() => __resetAuthorizationPolicyForTests());

/** Run one request through `guard` with a handler that reads the subject context. */
async function readThrough(
  guard: 'withAuth' | 'withAdminAuth',
  options: typeof SELF | typeof POLICY = SELF
): Promise<SubjectReadScope> {
  let seen: SubjectReadScope | null = null;
  const body = async () => {
    seen = await getSubjectReadScope();
    return ok();
  };
  const handler = guard === 'withAuth' ? withAuth(body, options) : withAdminAuth(body, options);
  const res = await handler(request());
  expect(res.status).toBe(200);
  if (!seen) throw new Error('handler did not run');
  return seen;
}

describe('who is narrowed', () => {
  it('a member is narrowed to themselves', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(session('USER'));
    expect(await readThrough('withAuth')).toMatchObject({
      kind: 'subject',
      principal: { userId: 'user_1', credential: 'session' },
      filter: { userId: 'user_1' },
    });
  });

  it('a platform admin is not', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(session('ADMIN'));
    expect(await readThrough('withAdminAuth')).toMatchObject({ kind: 'subject', filter: {} });
  });

  it('a non-admin API key is narrowed to its owner, an admin key is not', async () => {
    vi.mocked(resolveApiKey).mockResolvedValue(apiKey(['chat']));
    expect(await readThrough('withAuth')).toMatchObject({
      principal: { credential: 'api-key' },
      filter: { userId: 'user_1' },
    });

    vi.mocked(resolveApiKey).mockResolvedValue(apiKey(['admin']));
    expect(await readThrough('withAdminAuth')).toMatchObject({ filter: {} });
  });

  it('carries the ownerless reads the guard resolved', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(session('ADMIN'));
    const scope = await readThrough('withAdminAuth');
    expect(scope.kind === 'subject' && scope.unattributedReads.conversation).toBe(true);
  });

  it('honours shares on the admin surface only, whoever the caller is', async () => {
    // A share is consent to the admin surface, where its reads are audited —
    // so a platform admin on a `withAuth` route reads no share either.
    vi.mocked(auth.api.getSession).mockResolvedValue(session('ADMIN'));
    expect(await readThrough('withAdminAuth')).toMatchObject({ readsShared: true });
    expect(await readThrough('withAuth')).toMatchObject({ readsShared: false });
    vi.mocked(auth.api.getSession).mockResolvedValue(session('USER'));
    expect(await readThrough('withAuth')).toMatchObject({ readsShared: false });
  });
});

describe('one answer per request', () => {
  it("a 'policy' route and the data layer get the same filter, from one policy call", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(session('USER'));
    let fromRoute: SubjectFilter | null = null;
    let fromContext: SubjectReadScope | null = null;
    const handler = withAuth(async (_req, s: AuthenticatedSession) => {
      fromRoute = s.subjectFilter;
      fromContext = await getSubjectReadScope();
      return ok();
    }, POLICY);

    await handler(request());

    expect(fromRoute).toEqual({ userId: 'user_1' });
    expect(fromContext).toMatchObject({ filter: fromRoute });
    expect(subjectScopeSpy).toHaveBeenCalledTimes(1);
  });

  it("a 'self' route that never reads the subject never asks the policy", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(session('USER'));
    await withAuth(() => ok(), SELF)(request());
    expect(subjectScopeSpy).not.toHaveBeenCalled();
  });

  it("a 'self' route whose code does read it asks once, lazily", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(session('USER'));
    const handler = withAuth(async () => {
      await getSubjectReadScope();
      await getSubjectReadScope();
      return ok();
    }, SELF);
    await handler(request());
    expect(subjectScopeSpy).toHaveBeenCalledTimes(1);
  });
});

describe('scope', () => {
  it('nothing leaks after the response', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(session('USER'));
    await readThrough('withAuth');
    expect(await getSubjectReadScope()).toEqual({ kind: 'none' });
  });

  it('an unauthenticated request runs no handler and enters nothing', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(null);
    const handler = vi.fn(() => ok());
    const res = await withAuth(handler, SELF)(request());
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });
});
