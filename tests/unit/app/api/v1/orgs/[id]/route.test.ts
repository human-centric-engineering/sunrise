/**
 * Unit Tests: GET /api/v1/orgs/[id] (§106 t-672)
 *
 * Real `withAuth`. The route is self-scoped on the caller's own membership
 * row, so what is pinned: a MEMBER can read their org (the policy's org arm
 * would refuse them on a resource route — this one is not), the read is
 * keyed on `(orgId, session.user.id)` and never on a body, and a non-member
 * gets the guard's own `Access denied` whether the org exists or not.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { DEFAULT_ORG_ROLE } from '@/lib/tenancy/roles';

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

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/api/context', () => ({ getRouteLogger: vi.fn(async () => mockLog) }));
vi.mock('@/lib/logging', () => ({ logger: mockLog }));

import { GET } from '@/app/api/v1/orgs/[id]/route';
import { prisma } from '@/lib/db/client';
import { createMockAuthSession } from '@/tests/helpers/auth';

const USER_ID = 'cmjbv4i3x00003wsloputgwul';
const OTHER = 'cmorg000000000000000other';

function get(orgId: string) {
  return GET(new Request(`http://localhost/api/v1/orgs/${orgId}`) as unknown as NextRequest, {
    params: Promise.resolve({ id: orgId }),
  });
}

const membershipRow = {
  role: DEFAULT_ORG_ROLE,
  createdAt: new Date('2026-09-02'),
  org: {
    id: OTHER,
    slug: 'other',
    name: 'Other Org',
    status: 'ACTIVE',
    createdAt: new Date('2026-09-01'),
    _count: { memberships: 4 },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.TENANCY_MODE = 'single';
  vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue(null);
  // Session in the install org (no entry read); the URL names another org
  // the caller is a plain MEMBER of.
  mockGetSession.mockResolvedValue(createMockAuthSession());
});

describe('GET /api/v1/orgs/[id]', () => {
  it('answers a MEMBER with the org and their role, keyed on their own membership', async () => {
    vi.mocked(prisma.orgMembership.findUnique).mockResolvedValue(membershipRow as never);

    const res = await get(OTHER);
    const json = JSON.parse(await res.text());

    expect(res.status).toBe(200);
    expect(json.data).toEqual({
      id: OTHER,
      slug: 'other',
      name: 'Other Org',
      status: 'ACTIVE',
      createdAt: '2026-09-01T00:00:00.000Z',
      // No slice stored: every window is the platform's (§108 t-713).
      settings: { retention: null },
      memberCount: 4,
      role: DEFAULT_ORG_ROLE,
      joinedAt: '2026-09-02T00:00:00.000Z',
    });
    expect(prisma.orgMembership.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId_userId: { orgId: OTHER, userId: USER_ID } } })
    );
  });

  it('refuses a non-member with the guard’s own wording, whether the org exists or not', async () => {
    vi.mocked(prisma.orgMembership.findUnique).mockResolvedValue(null);

    const a = await get(OTHER);
    const b = await get('cmorg00000000000000nowhere');

    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    expect(JSON.parse(await a.text()).error.message).toBe('Access denied');
    expect(JSON.parse(await b.text()).error.message).toBe('Access denied');
  });

  it('reads the install org the same way', async () => {
    vi.mocked(prisma.orgMembership.findUnique).mockResolvedValue({
      ...membershipRow,
      org: { ...membershipRow.org, id: INSTALL_ORG_ID, slug: 'install' },
    } as never);
    const json = JSON.parse(await (await get(INSTALL_ORG_ID)).text());
    expect(json.data.id).toBe(INSTALL_ORG_ID);
  });

  it('rejects a malformed segment before reading', async () => {
    const res = await get('has%20space');
    expect(res.status).toBe(400);
    expect(prisma.orgMembership.findUnique).not.toHaveBeenCalled();
  });

  it('returns 401 without a session', async () => {
    mockGetSession.mockResolvedValue(null);
    expect((await get(OTHER)).status).toBe(401);
  });
});

describe('GET /api/v1/orgs/[id] — the retention slice (§108 t-713)', () => {
  it('publishes the validated slice and nothing else from the column', async () => {
    // `Org.settings` is one JSON object and a fork keeps its own org config
    // beside the platform's slice. This route is readable by every MEMBER, so
    // it publishes only the key it can vouch for.
    vi.mocked(prisma.orgMembership.findUnique).mockResolvedValue({
      ...membershipRow,
      org: {
        ...membershipRow.org,
        settings: {
          retention: { executionRetentionDays: 365 },
          integrations: { slackToken: 'xoxb-not-the-platforms-to-publish' },
        },
      },
    } as never);

    const json = JSON.parse(await (await get(OTHER)).text());

    expect(json.data.settings).toEqual({ retention: { executionRetentionDays: 365 } });
    expect(JSON.stringify(json)).not.toContain('xoxb-');
  });

  it('answers null for a slice it cannot read, the way the sweep treats it', async () => {
    vi.mocked(prisma.orgMembership.findUnique).mockResolvedValue({
      ...membershipRow,
      org: { ...membershipRow.org, settings: { retention: 'nonsense' } },
    } as never);

    const json = JSON.parse(await (await get(OTHER)).text());

    expect(json.data.settings).toEqual({ retention: null });
  });
});
