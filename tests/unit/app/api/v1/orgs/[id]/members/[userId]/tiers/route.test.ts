/**
 * Unit Tests: PUT /api/v1/orgs/[id]/members/[userId]/tiers (t-1123)
 *
 * The sibling members route's harness: real guard, real policy, real entry,
 * real resolver; the lifecycle's `setMemberTiers` mocked at the module (its
 * rules are `lifecycle.test.ts`'s). Pins that the handler hands it the URL's
 * org and user and the body's tiers, that its refusals reach the client with
 * their own status and code, and that a MEMBER and an API key are refused.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { DEFAULT_ORG_ROLE, ORG_ADMIN_ROLE } from '@/lib/tenancy/roles';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'single' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

const mockGetSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: mockGetSession } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    org: { findUnique: vi.fn() },
    orgMembership: { findUnique: vi.fn() },
    aiApiKey: { findFirst: vi.fn(), update: vi.fn() },
  },
}));

const lifecycle = vi.hoisted(() => ({ setMemberTiers: vi.fn() }));
vi.mock('@/lib/tenancy/lifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tenancy/lifecycle')>()),
  ...lifecycle,
}));

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/api/context', () => ({ getRouteLogger: vi.fn(async () => mockLog) }));
vi.mock('@/lib/logging', () => ({ logger: mockLog }));

import { PUT } from '@/app/api/v1/orgs/[id]/members/[userId]/tiers/route';
import { OrgLifecycleError } from '@/lib/tenancy/lifecycle';
import { prisma } from '@/lib/db/client';
import { createMockAuthSession } from '@/tests/helpers/auth';

const ORG = 'cmorg000000000000000other';
const TARGET = 'cmjbv4i3x00005wsloputgwuy';

function session(role: 'USER' | 'ADMIN', activeOrgId: string | null) {
  const base = createMockAuthSession();
  return { session: { ...base.session, activeOrgId }, user: { ...base.user, role } };
}

function memberOf(role: string) {
  vi.mocked(prisma.orgMembership.findUnique).mockResolvedValue({
    role,
    org: { status: 'ACTIVE' },
  } as never);
}

function put(body: unknown, headers: Record<string, string> = {}) {
  const request = new Request(`http://localhost/api/v1/orgs/${ORG}/members/${TARGET}/tiers`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
  return PUT(request, { params: Promise.resolve({ id: ORG, userId: TARGET }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.TENANCY_MODE = 'single';
  vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.org.findUnique).mockResolvedValue({ id: ORG } as never);
  mockGetSession.mockResolvedValue(session('USER', ORG));
  memberOf(ORG_ADMIN_ROLE);
  lifecycle.setMemberTiers.mockImplementation((orgId: string, userId: string, tiers: string[]) =>
    Promise.resolve({ orgId, userId, tiers })
  );
});

describe('PUT /api/v1/orgs/[id]/members/[userId]/tiers', () => {
  it('sets the grant through the lifecycle, keyed on the URL, and answers it', async () => {
    const res = await put({ tiers: ['media', 'brand'] });
    const json = JSON.parse(await res.text());

    expect(res.status).toBe(200);
    expect(json.data).toEqual({ orgId: ORG, userId: TARGET, tiers: ['media', 'brand'] });
    expect(lifecycle.setMemberTiers).toHaveBeenCalledWith(ORG, TARGET, ['media', 'brand']);
  });

  it('takes an empty list, which removes the grant', async () => {
    const res = await put({ tiers: [] });
    expect(res.status).toBe(200);
    expect(lifecycle.setMemberTiers).toHaveBeenCalledWith(ORG, TARGET, []);
  });

  it.each([
    ['a missing list', {}],
    ['a name that is not a tier name', { tiers: ['Media Library'] }],
    ['a list that is not one', { tiers: 'media' }],
  ])('refuses %s with a 400, before the lifecycle', async (_label, body) => {
    const res = await put(body);
    expect(res.status).toBe(400);
    expect(lifecycle.setMemberTiers).not.toHaveBeenCalled();
  });

  it.each([
    ['TIER_NOT_GRANTABLE', 400],
    ['GRANT_NEEDS_MEMBER', 409],
    ['NOT_A_MEMBER', 404],
  ] as const)('surfaces the lifecycle’s %s refusal with its status', async (code, status) => {
    lifecycle.setMemberTiers.mockRejectedValue(new OrgLifecycleError(code, 'no'));
    const res = await put({ tiers: ['media'] });
    const json = JSON.parse(await res.text());
    expect(res.status).toBe(status);
    expect(json.error.code).toBe(code);
  });

  it('refuses a MEMBER of the org without touching the lifecycle', async () => {
    memberOf(DEFAULT_ORG_ROLE);
    const res = await put({ tiers: ['media'] });
    expect(res.status).toBe(403);
    expect(lifecycle.setMemberTiers).not.toHaveBeenCalled();
  });

  it('refuses an admin-scoped API key, as every write to the roster', async () => {
    // A platform credential the policy admits everywhere: the handler's own
    // browser-session check is what refuses it.
    vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue({
      id: 'cmkey000000000000000key1',
      userId: 'cmjbv4i3x00003wsloputgwul',
      scopes: ['admin'],
      rateLimitRpm: null,
      expiresAt: null,
      createdAt: new Date(),
      orgId: null,
      user: {
        id: 'cmjbv4i3x00003wsloputgwul',
        name: 'Key Owner',
        email: 'owner@example.com',
        emailVerified: true,
        image: null,
        role: 'ADMIN',
        accountType: 'HUMAN',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    } as never);

    const res = await put(
      { tiers: ['media'] },
      { authorization: 'Bearer sk_deadbeefdeadbeefdeadbeefdeadbeef' }
    );

    expect(res.status).toBe(403);
    expect(lifecycle.setMemberTiers).not.toHaveBeenCalled();
  });
});
