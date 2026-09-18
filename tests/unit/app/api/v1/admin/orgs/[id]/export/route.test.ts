/**
 * Unit Tests: GET /api/v1/admin/orgs/[id]/export (§106 t-672)
 *
 * Real `withAdminAuth`; `exportOrgData` mocked at the module. Pins the
 * download headers, the actor passed through, the 404 for a missing org,
 * and the per-admin sub-cap.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'single' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

const mockGetSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: mockGetSession } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    orgMembership: { findUnique: vi.fn() },
    aiApiKey: { findFirst: vi.fn(), update: vi.fn() },
  },
}));

const mockExport = vi.hoisted(() => vi.fn());
vi.mock('@/lib/privacy/export-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/privacy/export-org')>()),
  exportOrgData: mockExport,
}));

const mockLimiter = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock('@/lib/security/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/security/rate-limit')>()),
  exportLimiter: mockLimiter,
}));

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/api/context', () => ({ getRouteLogger: vi.fn(async () => mockLog) }));
vi.mock('@/lib/logging', () => ({ logger: mockLog }));

import { GET } from '@/app/api/v1/admin/orgs/[id]/export/route';
import { OrgNotFoundError } from '@/lib/privacy/export-org';
import { prisma } from '@/lib/db/client';
import { createMockAuthSession } from '@/tests/helpers/auth';

const OTHER = 'cmorg000000000000000other';
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';

function session(role: 'USER' | 'ADMIN') {
  const base = createMockAuthSession();
  return { ...base, user: { ...base.user, role } };
}

const get = (id = OTHER) =>
  GET(new Request(`http://localhost/api/v1/admin/orgs/${id}/export`) as unknown as NextRequest, {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue(null);
  mockGetSession.mockResolvedValue(session('ADMIN'));
  mockLimiter.check.mockReturnValue({
    success: true,
    limit: 5,
    remaining: 4,
    reset: Date.now() + 1000,
  });
  mockExport.mockResolvedValue({
    meta: { orgId: OTHER },
    org: { id: OTHER },
    data: {},
    attributions: {},
  });
});

describe('GET /api/v1/admin/orgs/[id]/export', () => {
  it('serves the bundle as an uncached download, naming the acting admin', async () => {
    const res = await get();
    const json = JSON.parse(await res.text());

    expect(res.status).toBe(200);
    expect(json.data.meta.orgId).toBe(OTHER);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Content-Disposition')).toBe(
      `attachment; filename="org-data-${OTHER}.json"`
    );
    expect(mockExport).toHaveBeenCalledWith({ orgId: OTHER, actorUserId: ADMIN_ID });
    expect(mockLimiter.check).toHaveBeenCalledWith(`export:org:${ADMIN_ID}`);
  });

  it('is a 404 for an org that does not exist', async () => {
    mockExport.mockRejectedValue(new OrgNotFoundError(OTHER));
    expect((await get()).status).toBe(404);
  });

  it('honours the per-admin sub-cap before exporting', async () => {
    mockLimiter.check.mockReturnValue({
      success: false,
      limit: 5,
      remaining: 0,
      reset: Date.now() + 1000,
    });
    expect((await get()).status).toBe(429);
    expect(mockExport).not.toHaveBeenCalled();
  });

  it('refuses a USER without exporting', async () => {
    mockGetSession.mockResolvedValue(session('USER'));
    expect((await get()).status).toBe(403);
    expect(mockExport).not.toHaveBeenCalled();
  });

  it('rejects a malformed segment before exporting', async () => {
    expect((await get('has%20space')).status).toBe(400);
    expect(mockExport).not.toHaveBeenCalled();
  });
});
