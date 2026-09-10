/**
 * Integration Test: Admin Orchestration — Claim an ownerless dataset
 *
 * POST /api/v1/admin/orchestration/evaluations/datasets/:id/claim
 *
 * t-679. Erasing an admin leaves their datasets with `userId = null`. Claiming
 * is how such a row gets a real owner again; it must never be a way to take a
 * row that already has one, nor to learn that one exists.
 *
 * @see app/api/v1/admin/orchestration/evaluations/datasets/[id]/claim/route.ts
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/evaluations/datasets/[id]/claim/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';
import { ownerScopedFindFirst } from '@/tests/helpers/owner-scoped-prisma';
import {
  registerAuthorizationPolicy,
  __resetAuthorizationPolicyForTests,
  DEFAULT_AUTHORIZATION_POLICY,
} from '@/lib/auth/authorization';

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));
vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiDataset: { findFirst: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
  },
}));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
}));
vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(() =>
    Promise.resolve({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
  ),
}));

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const DATASET_ID = 'cmjbv4i3x00003wsloputgwu7';

function makeDataset(overrides: Record<string, unknown> = {}) {
  return { id: DATASET_ID, name: 'refund fixtures', userId: null, ...overrides };
}

function makeRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/evaluations/datasets/${DATASET_ID}/claim`,
    { method: 'POST' }
  );
}

function ctx() {
  return { params: Promise.resolve({ id: DATASET_ID }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

function denyUnattributedReads() {
  registerAuthorizationPolicy({
    ...DEFAULT_AUTHORIZATION_POLICY,
    canRead: (viewer, target, scope) =>
      target.kind === 'unattributed'
        ? Promise.resolve(false)
        : DEFAULT_AUTHORIZATION_POLICY.canRead(viewer, target, scope),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  vi.mocked(prisma.aiDataset.updateMany).mockResolvedValue({ count: 1 });
  vi.mocked(prisma.aiDataset.findUniqueOrThrow).mockResolvedValue(
    makeDataset({ userId: ADMIN_ID }) as never
  );
});

afterEach(() => {
  __resetAuthorizationPolicyForTests();
});

describe('POST /datasets/:id/claim — auth', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    expect((await POST(makeRequest(), ctx())).status).toBe(401);
  });

  it('returns 403 for a non-admin, and writes nothing', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    expect((await POST(makeRequest(), ctx())).status).toBe(403);
    expect(vi.mocked(prisma.aiDataset.updateMany)).not.toHaveBeenCalled();
  });
});

describe('POST /datasets/:id/claim — adopting an ownerless dataset', () => {
  beforeEach(() => {
    vi.mocked(prisma.aiDataset.findFirst).mockImplementation(
      ownerScopedFindFirst([makeDataset({ userId: null })]) as never
    );
  });

  it('claims it, stamping the caller as owner', async () => {
    const res = await POST(makeRequest(), ctx());

    expect(res.status).toBe(200);
    const body = await parseJson<{ data: { userId: string } }>(res);
    expect(body.data.userId).toBe(ADMIN_ID);
    // The null guard is in the WHERE, not just the preceding read — that is
    // what makes two admins racing for the same orphan resolve to one winner.
    expect(vi.mocked(prisma.aiDataset.updateMany)).toHaveBeenCalledWith({
      where: { id: DATASET_ID, userId: null },
      data: { userId: ADMIN_ID },
    });
  });

  it('records the claim as non-owner access in the audit log', async () => {
    await POST(makeRequest(), ctx());

    expect(vi.mocked(logAdminAction)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'dataset.claim',
        entityId: DATASET_ID,
        metadata: expect.objectContaining({ accessBasis: 'orphan' }),
      })
    );
  });

  it('returns 409 when another admin won the race between read and write', async () => {
    vi.mocked(prisma.aiDataset.updateMany).mockResolvedValue({ count: 0 });

    expect((await POST(makeRequest(), ctx())).status).toBe(409);
  });
});

describe('POST /datasets/:id/claim — what cannot be claimed', () => {
  it("returns 404 for another admin's owned dataset, and takes nothing", async () => {
    // The owner-aware fake is what makes this able to fail: the route has to
    // ask for rows it may see, and a foreign owned row is not among them.
    vi.mocked(prisma.aiDataset.findFirst).mockImplementation(
      ownerScopedFindFirst([makeDataset({ userId: 'another-admin' })]) as never
    );

    const res = await POST(makeRequest(), ctx());

    // 404 and not 403: claiming must not become a way to probe for the
    // existence of other people's datasets.
    expect(res.status).toBe(404);
    expect(vi.mocked(prisma.aiDataset.updateMany)).not.toHaveBeenCalled();
  });

  it('returns 409 when the caller already owns it', async () => {
    vi.mocked(prisma.aiDataset.findFirst).mockImplementation(
      ownerScopedFindFirst([makeDataset({ userId: ADMIN_ID })]) as never
    );

    const res = await POST(makeRequest(), ctx());

    expect(res.status).toBe(409);
    expect(vi.mocked(prisma.aiDataset.updateMany)).not.toHaveBeenCalled();
  });

  it('returns 404 when the policy denies the caller unattributed reads', async () => {
    // A fork whose org admins must not touch another department's abandoned
    // work: same orphan, same admin, narrower policy. The route follows it
    // without a line of its own changing.
    denyUnattributedReads();
    vi.mocked(prisma.aiDataset.findFirst).mockImplementation(
      ownerScopedFindFirst([makeDataset({ userId: null })]) as never
    );

    const res = await POST(makeRequest(), ctx());

    expect(res.status).toBe(404);
    expect(vi.mocked(prisma.aiDataset.updateMany)).not.toHaveBeenCalled();
  });
});
