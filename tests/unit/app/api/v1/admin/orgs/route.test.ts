/**
 * Unit Tests: GET/POST /api/v1/admin/orgs (§106 t-672)
 *
 * Real `withAdminAuth`: a platform admin is admitted, a USER is refused
 * before any read, and — the control-plane split — an org OWNER who is not a
 * platform admin is refused too, because creating orgs is the vendor's act.
 * The list is one enriched read (member and owner counts in two queries, not
 * one per row); the create hands the lifecycle the validated body.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { ORG_OWNER_ROLE } from '@/lib/tenancy/roles';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'single' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

const mockGetSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: mockGetSession } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    org: { findMany: vi.fn() },
    orgMembership: { findUnique: vi.fn(), groupBy: vi.fn() },
    orgSupportGrant: { findMany: vi.fn() },
    aiApiKey: { findFirst: vi.fn(), update: vi.fn() },
  },
}));

const mockCreateOrg = vi.hoisted(() => vi.fn());
vi.mock('@/lib/tenancy/lifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tenancy/lifecycle')>()),
  createOrg: mockCreateOrg,
}));

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/api/context', () => ({ getRouteLogger: vi.fn(async () => mockLog) }));
vi.mock('@/lib/logging', () => ({ logger: mockLog }));

import { GET, POST } from '@/app/api/v1/admin/orgs/route';
import { OrgLifecycleError } from '@/lib/tenancy/lifecycle';
import { prisma } from '@/lib/db/client';
import { createMockAuthSession } from '@/tests/helpers/auth';

const OTHER = 'cmorg000000000000000other';
const OWNER = 'cmjbv4i3x00005wsloputgwuy';

function session(role: 'USER' | 'ADMIN', activeOrgId: string | null = null) {
  const base = createMockAuthSession();
  return { session: { ...base.session, activeOrgId }, user: { ...base.user, role } };
}

const get = () => GET(new Request('http://localhost/api/v1/admin/orgs') as unknown as NextRequest);
const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/v1/admin/orgs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }) as unknown as NextRequest
  );

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.TENANCY_MODE = 'single';
  vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.org.findMany).mockResolvedValue([
    {
      id: INSTALL_ORG_ID,
      slug: 'install',
      name: 'Default organisation',
      status: 'ACTIVE',
      createdAt: new Date('2026-09-01'),
      updatedAt: new Date('2026-09-01'),
      _count: { memberships: 5 },
    },
    {
      id: OTHER,
      slug: 'other',
      name: 'Other Org',
      status: 'SUSPENDED',
      createdAt: new Date('2026-09-02'),
      updatedAt: new Date('2026-09-02'),
      _count: { memberships: 2 },
    },
  ] as never);
  vi.mocked(prisma.orgMembership.groupBy).mockResolvedValue([
    { orgId: INSTALL_ORG_ID, _count: { _all: 1 } },
  ] as never);
  vi.mocked(prisma.orgSupportGrant.findMany).mockResolvedValue([]);
  mockCreateOrg.mockResolvedValue({
    id: OTHER,
    slug: 'other',
    name: 'Other Org',
    status: 'ACTIVE',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

describe('GET /api/v1/admin/orgs', () => {
  it('lists every org with member and owner counts, flagging an owner-less one with 0', async () => {
    mockGetSession.mockResolvedValue(session('ADMIN'));

    const res = await get();
    const json = JSON.parse(await res.text());

    expect(res.status).toBe(200);
    expect(json.data.orgs).toEqual([
      expect.objectContaining({ id: INSTALL_ORG_ID, memberCount: 5, ownerCount: 1 }),
      expect.objectContaining({ id: OTHER, status: 'SUSPENDED', memberCount: 2, ownerCount: 0 }),
    ]);
    // Two queries for N orgs, not one per row.
    expect(prisma.org.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.orgMembership.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.orgMembership.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ by: ['orgId'], where: { role: ORG_OWNER_ROLE } })
    );
  });

  it('carries each org’s open support grant, from one query, and null where there is none (§121 t-823)', async () => {
    mockGetSession.mockResolvedValue(session('ADMIN'));
    const expiresAt = new Date('2026-10-17T09:00:00.000Z');
    vi.mocked(prisma.orgSupportGrant.findMany).mockResolvedValue([
      {
        orgId: OTHER,
        level: 'READ_ONLY',
        expiresAt,
        grantedBy: { orgMemberships: [{ orgId: OTHER }] },
      },
    ] as never);

    const res = await get();
    const json = JSON.parse(await res.text());

    expect(json.data.orgs).toEqual([
      expect.objectContaining({ id: INSTALL_ORG_ID, supportGrant: null }),
      expect.objectContaining({
        id: OTHER,
        supportGrant: { level: 'READ_ONLY', expiresAt: expiresAt.toISOString() },
      }),
    ]);
    expect(prisma.orgSupportGrant.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.orgSupportGrant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        // A suspended org admits nobody, so its grant is not listed as open.
        where: {
          revokedAt: null,
          expiresAt: { gt: expect.any(Date) },
          org: { status: 'ACTIVE' },
        },
      })
    );
  });

  it('leaves out a grant whose granter is no longer an OWNER of that org — it admits nobody (§121 t-824)', async () => {
    mockGetSession.mockResolvedValue(session('ADMIN'));
    vi.mocked(prisma.orgSupportGrant.findMany).mockResolvedValue([
      // The granter is an OWNER elsewhere, not in OTHER.
      {
        orgId: OTHER,
        level: 'ADMIN',
        expiresAt: new Date('2030-01-01T00:00:00.000Z'),
        grantedBy: { orgMemberships: [{ orgId: 'cmorg0000000000000000else' }] },
      },
    ] as never);

    const res = await get();
    const json = JSON.parse(await res.text());

    expect(json.data.orgs).toEqual([
      expect.objectContaining({ id: INSTALL_ORG_ID, supportGrant: null }),
      expect.objectContaining({ id: OTHER, supportGrant: null }),
    ]);
  });

  it('leaves out a grant whose granter has been erased', async () => {
    mockGetSession.mockResolvedValue(session('ADMIN'));
    vi.mocked(prisma.orgSupportGrant.findMany).mockResolvedValue([
      {
        orgId: OTHER,
        level: 'ADMIN',
        expiresAt: new Date('2030-01-01T00:00:00.000Z'),
        grantedBy: null,
      },
    ] as never);

    const json = JSON.parse(await (await get()).text());

    expect(json.data.orgs).toContainEqual(
      expect.objectContaining({ id: OTHER, supportGrant: null })
    );
  });

  it('refuses a USER before any read', async () => {
    mockGetSession.mockResolvedValue(session('USER'));
    const res = await get();
    expect(res.status).toBe(403);
    expect(prisma.org.findMany).not.toHaveBeenCalled();
  });

  it('refuses an org OWNER who is not a platform admin — the vendor’s surface', async () => {
    mockGetSession.mockResolvedValue(session('USER', OTHER));
    vi.mocked(prisma.orgMembership.findUnique).mockResolvedValue({
      role: ORG_OWNER_ROLE,
      org: { status: 'ACTIVE' },
    } as never);
    const res = await get();
    expect(res.status).toBe(403);
    expect(prisma.org.findMany).not.toHaveBeenCalled();
  });

  it('returns 401 without a session', async () => {
    mockGetSession.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
  });
});

describe('POST /api/v1/admin/orgs', () => {
  beforeEach(() => mockGetSession.mockResolvedValue(session('ADMIN')));

  it('creates the org through the lifecycle with the validated body', async () => {
    const res = await post({ slug: 'other', name: '  Other Org  ', ownerUserId: OWNER });
    const json = JSON.parse(await res.text());

    expect(res.status).toBe(201);
    expect(json.data.id).toBe(OTHER);
    expect(mockCreateOrg).toHaveBeenCalledWith({
      slug: 'other',
      name: 'Other Org',
      ownerUserId: OWNER,
    });
  });

  it('creates without an owner when none is named', async () => {
    await post({ slug: 'other', name: 'Other Org' });
    expect(mockCreateOrg).toHaveBeenCalledWith({ slug: 'other', name: 'Other Org' });
  });

  it('answers a taken slug with the lifecycle’s 409', async () => {
    mockCreateOrg.mockRejectedValue(new OrgLifecycleError('SLUG_TAKEN', 'taken'));
    const res = await post({ slug: 'other', name: 'Other Org' });
    expect(res.status).toBe(409);
    expect(JSON.parse(await res.text()).error.code).toBe('SLUG_TAKEN');
  });

  it.each([
    [{}],
    [{ slug: 'Has Caps', name: 'x' }],
    [{ slug: 'ok', name: '' }],
    [{ slug: 'ok', name: 'x', ownerUserId: 'not-a-cuid' }],
    [{ slug: 'a'.repeat(101), name: 'x' }],
  ])('rejects a malformed body %j before writing', async (body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(mockCreateOrg).not.toHaveBeenCalled();
  });

  it('refuses a USER before validating', async () => {
    mockGetSession.mockResolvedValue(session('USER'));
    expect((await post({ slug: 'other', name: 'x' })).status).toBe(403);
    expect(mockCreateOrg).not.toHaveBeenCalled();
  });
});
