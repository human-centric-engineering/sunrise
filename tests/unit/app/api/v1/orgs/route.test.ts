/**
 * Unit Tests: GET /api/v1/orgs (§106 t-672)
 *
 * Real `withAuth`. Pins that the list is keyed on the caller's own id, that
 * the implicit active org at `single` is reported as the install org, that
 * suspended orgs are listed rather than hidden — and the property this
 * route exists for: a member whose active org is suspended, or who was
 * removed from it, still gets the list (the route does not enter the
 * session's org), where any other route would refuse them.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { DEFAULT_ORG_ROLE, ORG_OWNER_ROLE } from '@/lib/tenancy/roles';
import { TENANT_HEADER_NAME } from '@/lib/tenancy/resolver';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'single' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

const mockGetSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: mockGetSession } } }));
const mockHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(mockHeaders.current)) }));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    orgMembership: { findUnique: vi.fn(), findMany: vi.fn() },
    aiApiKey: { findFirst: vi.fn(), update: vi.fn() },
  },
}));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { GET } from '@/app/api/v1/orgs/route';
import { prisma } from '@/lib/db/client';
import { createMockAuthSession } from '@/tests/helpers/auth';

const USER_ID = 'cmjbv4i3x00003wsloputgwul';
const OTHER = 'cmorg000000000000000other';

function session(activeOrgId: string | null) {
  const base = createMockAuthSession();
  return { ...base, session: { ...base.session, activeOrgId } };
}

const rows = [
  {
    role: ORG_OWNER_ROLE,
    createdAt: new Date('2026-09-01'),
    org: { id: INSTALL_ORG_ID, slug: 'install', name: 'Default organisation', status: 'ACTIVE' },
  },
  {
    role: DEFAULT_ORG_ROLE,
    createdAt: new Date('2026-09-02'),
    org: { id: OTHER, slug: 'other', name: 'Other Org', status: 'SUSPENDED' },
  },
];

/** `headers` is what the proxy wrote onto the request, read via `next/headers` like the guard. */
const get = (headers: Record<string, string> = {}) => {
  mockHeaders.current = new Headers(headers);
  return GET(new Request('http://localhost/api/v1/orgs') as unknown as NextRequest);
};

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.TENANCY_MODE = 'single';
  vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.orgMembership.findMany).mockResolvedValue(rows as never);
});

describe('GET /api/v1/orgs', () => {
  it('lists the caller’s memberships, keyed on their own id, marking the active one', async () => {
    mockGetSession.mockResolvedValue(session(OTHER));

    const res = await get();
    const json = JSON.parse(await res.text());

    expect(res.status).toBe(200);
    expect(prisma.orgMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID } })
    );
    expect(json.data.activeOrgId).toBe(OTHER);
    expect(json.data.orgs).toEqual([
      expect.objectContaining({ id: INSTALL_ORG_ID, role: ORG_OWNER_ROLE, active: false }),
      expect.objectContaining({
        id: OTHER,
        role: DEFAULT_ORG_ROLE,
        status: 'SUSPENDED',
        active: true,
      }),
    ]);
  });

  it('reports the install org as active when the session names none, at single', async () => {
    mockGetSession.mockResolvedValue(session(null));
    const json = JSON.parse(await (await get()).text());
    expect(json.data.activeOrgId).toBe(INSTALL_ORG_ID);
    expect(json.data.orgs[0]).toEqual(
      expect.objectContaining({ id: INSTALL_ORG_ID, active: true })
    );
  });

  it('lets the proxy’s resolver header name the active org over the cookie, as the entry rule does', async () => {
    // A fork resolving by hostname: the cookie still says install, the host
    // says the other org. Every other request on this host acts in the
    // other org, so this list must say so too.
    mockGetSession.mockResolvedValue(session(INSTALL_ORG_ID));
    const json = JSON.parse(await (await get({ [TENANT_HEADER_NAME]: OTHER })).text());
    expect(json.data.activeOrgId).toBe(OTHER);
    expect(
      json.data.orgs.map((org: { id: string; active: boolean }) => [org.id, org.active])
    ).toEqual([
      [INSTALL_ORG_ID, false],
      [OTHER, true],
    ]);
  });

  it('reports no active org when the session names none, at multi', async () => {
    mockEnv.TENANCY_MODE = 'multi';
    mockGetSession.mockResolvedValue(session(null));
    const res = await get();
    // The guard admits the request (this route enters no org), and the
    // answer says honestly that nothing is active.
    expect(res.status).toBe(200);
    const json = JSON.parse(await res.text());
    expect(json.data.activeOrgId).toBeNull();
    expect(json.data.orgs.every((org: { active: boolean }) => !org.active)).toBe(true);
  });

  it('still answers a member whose active org is suspended — the way out', async () => {
    // Entering the org would refuse this session; this route does not enter.
    mockGetSession.mockResolvedValue(session(OTHER));
    vi.mocked(prisma.orgMembership.findUnique).mockResolvedValue({
      role: DEFAULT_ORG_ROLE,
      org: { status: 'SUSPENDED' },
    } as never);

    const res = await get();

    expect(res.status).toBe(200);
    // No entry read was made at all.
    expect(prisma.orgMembership.findUnique).not.toHaveBeenCalled();
  });

  it('returns 401 without a session', async () => {
    mockGetSession.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    expect(prisma.orgMembership.findMany).not.toHaveBeenCalled();
  });
});
