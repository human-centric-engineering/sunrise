/**
 * Unit Tests: GET/PATCH/DELETE /api/v1/admin/orgs/[id] (§106 t-672)
 *
 * Real `withAdminAuth`. The reads are Prisma; the writes are the lifecycle
 * and `eraseOrg`, mocked at their modules. Pins the install-org refusals
 * reaching the client as 400s with their codes, the PATCH body's shape, and
 * that DELETE calls `eraseOrg` and nothing else.
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
    org: { findUnique: vi.fn(), delete: vi.fn() },
    orgMembership: { findUnique: vi.fn() },
    aiApiKey: { findFirst: vi.fn(), update: vi.fn() },
  },
}));

const mockUpdateOrg = vi.hoisted(() => vi.fn());
vi.mock('@/lib/tenancy/lifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tenancy/lifecycle')>()),
  updateOrg: mockUpdateOrg,
}));
const mockEraseOrg = vi.hoisted(() => vi.fn());
vi.mock('@/lib/privacy/erase-org', () => ({ eraseOrg: mockEraseOrg }));

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/api/context', () => ({ getRouteLogger: vi.fn(async () => mockLog) }));
vi.mock('@/lib/logging', () => ({ logger: mockLog }));

import { GET, PATCH, DELETE } from '@/app/api/v1/admin/orgs/[id]/route';
import { OrgLifecycleError } from '@/lib/tenancy/lifecycle';
import { prisma } from '@/lib/db/client';
import { createMockAuthSession } from '@/tests/helpers/auth';

const OTHER = 'cmorg000000000000000other';
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';

function session(role: 'USER' | 'ADMIN') {
  const base = createMockAuthSession();
  return { ...base, user: { ...base.user, role } };
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (id = OTHER) =>
  GET(new Request(`http://localhost/api/v1/admin/orgs/${id}`) as unknown as NextRequest, ctx(id));
const patch = (body: unknown, id = OTHER) =>
  PATCH(
    new Request(`http://localhost/api/v1/admin/orgs/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }) as unknown as NextRequest,
    ctx(id)
  );
const del = (id = OTHER) =>
  DELETE(
    new Request(`http://localhost/api/v1/admin/orgs/${id}`, {
      method: 'DELETE',
    }) as unknown as NextRequest,
    ctx(id)
  );

const orgRow = {
  id: OTHER,
  slug: 'other',
  name: 'Other Org',
  status: 'ACTIVE',
  createdAt: new Date('2026-09-01'),
  updatedAt: new Date('2026-09-01'),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.TENANCY_MODE = 'single';
  vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue(null);
  mockGetSession.mockResolvedValue(session('ADMIN'));
  vi.mocked(prisma.org.findUnique).mockResolvedValue({
    ...orgRow,
    memberships: [
      {
        role: ORG_OWNER_ROLE,
        createdAt: new Date('2026-09-01'),
        user: { id: ADMIN_ID, name: 'Owner', email: 'owner@example.com', image: null },
      },
    ],
  } as never);
  mockUpdateOrg.mockResolvedValue({ ...orgRow, name: 'Renamed' });
  mockEraseOrg.mockResolvedValue({
    erasedAt: new Date('2026-09-18'),
    members: 1,
    pendingInvitations: 0,
    sessionsCleared: 2,
  });
});

describe('GET /api/v1/admin/orgs/[id]', () => {
  it('returns the org with its roster', async () => {
    const res = await get();
    const json = JSON.parse(await res.text());
    expect(res.status).toBe(200);
    expect(json.data.id).toBe(OTHER);
    expect(json.data.members).toEqual([
      expect.objectContaining({ id: ADMIN_ID, email: 'owner@example.com', role: ORG_OWNER_ROLE }),
    ]);
  });

  it('is a 404 for an org that does not exist', async () => {
    vi.mocked(prisma.org.findUnique).mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(404);
    expect(JSON.parse(await res.text()).error.code).toBe('ORG_NOT_FOUND');
  });

  it('refuses a USER', async () => {
    mockGetSession.mockResolvedValue(session('USER'));
    expect((await get()).status).toBe(403);
    expect(prisma.org.findUnique).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/v1/admin/orgs/[id]', () => {
  it('hands the lifecycle the validated patch', async () => {
    const res = await patch({ name: ' Renamed ', status: 'SUSPENDED' });
    expect(res.status).toBe(200);
    expect(mockUpdateOrg).toHaveBeenCalledWith(OTHER, { name: 'Renamed', status: 'SUSPENDED' });
  });

  it('surfaces the install-org refusal as a 400 with its code (ruling b)', async () => {
    mockUpdateOrg.mockRejectedValue(
      new OrgLifecycleError('INSTALL_ORG_IMMUTABLE', 'The install organisation cannot be suspended')
    );
    const res = await patch({ status: 'SUSPENDED' }, INSTALL_ORG_ID);
    const json = JSON.parse(await res.text());
    expect(res.status).toBe(400);
    expect(json.error.code).toBe('INSTALL_ORG_IMMUTABLE');
  });

  it.each([[{}], [{ status: 'DELETED' }], [{ slug: 'Not A Slug' }], [{ name: '' }]])(
    'rejects a malformed body %j before writing',
    async (body) => {
      const res = await patch(body);
      expect(res.status).toBe(400);
      expect(mockUpdateOrg).not.toHaveBeenCalled();
    }
  );

  it('refuses a USER before validating', async () => {
    mockGetSession.mockResolvedValue(session('USER'));
    expect((await patch({ name: 'x' })).status).toBe(403);
    expect(mockUpdateOrg).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/v1/admin/orgs/[id]', () => {
  it('erases through eraseOrg with the acting admin, and reports the counts', async () => {
    const res = await del();
    const json = JSON.parse(await res.text());

    expect(res.status).toBe(200);
    expect(mockEraseOrg).toHaveBeenCalledWith({ orgId: OTHER, actorUserId: ADMIN_ID });
    expect(json.data).toEqual(
      expect.objectContaining({ orgId: OTHER, members: 1, sessionsCleared: 2 })
    );
    // Never a bare Prisma delete from the route.
    expect(prisma.org.delete).not.toHaveBeenCalled();
  });

  it('surfaces the install-org refusal (ruling b)', async () => {
    mockEraseOrg.mockRejectedValue(
      new OrgLifecycleError('INSTALL_ORG_IMMUTABLE', 'The install organisation cannot be deleted')
    );
    const res = await del(INSTALL_ORG_ID);
    expect(res.status).toBe(400);
    expect(JSON.parse(await res.text()).error.code).toBe('INSTALL_ORG_IMMUTABLE');
  });

  it('is a 404 for an org that does not exist', async () => {
    mockEraseOrg.mockRejectedValue(
      new OrgLifecycleError('ORG_NOT_FOUND', 'Organisation not found')
    );
    expect((await del()).status).toBe(404);
  });

  it('refuses a USER without erasing', async () => {
    mockGetSession.mockResolvedValue(session('USER'));
    expect((await del()).status).toBe(403);
    expect(mockEraseOrg).not.toHaveBeenCalled();
  });
});
