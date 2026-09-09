/**
 * Integration Test: Admin Orchestration — Claim an ownerless Experiment
 *
 * POST /api/v1/admin/orchestration/experiments/:id/claim
 *
 * t-678. Erasing an admin leaves their experiments with `createdBy = null`.
 * Claiming is how such a row gets a real owner again and re-enters the normal
 * ownership rules; it must never be a way to take a row that already has one.
 *
 * @see app/api/v1/admin/orchestration/experiments/[id]/claim/route.ts
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/experiments/[id]/claim/route';
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

// ─── Mock dependencies ───────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiExperiment: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
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

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const EXPERIMENT_ID = 'exp-1';

function makeExperiment(overrides: Record<string, unknown> = {}) {
  return { id: EXPERIMENT_ID, name: 'Refund prompt A/B', createdBy: null, ...overrides };
}

function makeRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/experiments/${EXPERIMENT_ID}/claim`,
    { method: 'POST' }
  );
}

function ctx() {
  return { params: Promise.resolve({ id: EXPERIMENT_ID }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

/** A fork's narrower tier: this admin may not read rows nobody owns. */
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
  vi.mocked(prisma.aiExperiment.updateMany).mockResolvedValue({ count: 1 });
  vi.mocked(prisma.aiExperiment.findUniqueOrThrow).mockResolvedValue(
    makeExperiment({ createdBy: ADMIN_ID }) as never
  );
});

afterEach(() => {
  __resetAuthorizationPolicyForTests();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /experiments/:id/claim — auth', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    expect((await POST(makeRequest(), ctx())).status).toBe(401);
  });

  it('returns 403 for a non-admin, and writes nothing', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    expect((await POST(makeRequest(), ctx())).status).toBe(403);
    expect(vi.mocked(prisma.aiExperiment.updateMany)).not.toHaveBeenCalled();
  });
});

describe('POST /experiments/:id/claim — adopting an ownerless experiment', () => {
  it('claims it, stamping the caller as owner', async () => {
    vi.mocked(prisma.aiExperiment.findFirst).mockImplementation(
      ownerScopedFindFirst([makeExperiment({ createdBy: null })]) as never
    );

    const res = await POST(makeRequest(), ctx());

    expect(res.status).toBe(200);
    const body = await parseJson<{ data: { createdBy: string } }>(res);
    expect(body.data.createdBy).toBe(ADMIN_ID);
    // The null guard is in the WHERE, not just the preceding read — that is
    // what makes two admins racing for the same orphan resolve to one winner.
    expect(vi.mocked(prisma.aiExperiment.updateMany)).toHaveBeenCalledWith({
      where: { id: EXPERIMENT_ID, createdBy: null },
      data: { createdBy: ADMIN_ID },
    });
  });

  it('records the claim in the admin audit log', async () => {
    vi.mocked(prisma.aiExperiment.findFirst).mockImplementation(
      ownerScopedFindFirst([makeExperiment({ createdBy: null })]) as never
    );

    await POST(makeRequest(), ctx());

    expect(vi.mocked(logAdminAction)).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'experiment.claim', entityId: EXPERIMENT_ID })
    );
  });

  it('returns 409 when another admin won the race between read and write', async () => {
    vi.mocked(prisma.aiExperiment.findFirst).mockImplementation(
      ownerScopedFindFirst([makeExperiment({ createdBy: null })]) as never
    );
    // The row acquired an owner after the read: the guarded write matches none.
    vi.mocked(prisma.aiExperiment.updateMany).mockResolvedValue({ count: 0 });

    expect((await POST(makeRequest(), ctx())).status).toBe(409);
  });
});

describe('POST /experiments/:id/claim — what cannot be claimed', () => {
  it("returns 404 for another admin's owned experiment, and takes nothing", async () => {
    // The owner-aware fake is what makes this able to fail: the route has to
    // ask for rows it may see, and a foreign owned row is not among them.
    vi.mocked(prisma.aiExperiment.findFirst).mockImplementation(
      ownerScopedFindFirst([makeExperiment({ createdBy: 'someone-else' })]) as never
    );

    const res = await POST(makeRequest(), ctx());

    // 404 and not 403: claiming must not become a way to probe for the
    // existence of other people's experiments.
    expect(res.status).toBe(404);
    expect(vi.mocked(prisma.aiExperiment.updateMany)).not.toHaveBeenCalled();
  });

  it('returns 409 when the caller already owns it', async () => {
    vi.mocked(prisma.aiExperiment.findFirst).mockImplementation(
      ownerScopedFindFirst([makeExperiment({ createdBy: ADMIN_ID })]) as never
    );

    const res = await POST(makeRequest(), ctx());

    expect(res.status).toBe(409);
    expect(vi.mocked(prisma.aiExperiment.updateMany)).not.toHaveBeenCalled();
  });

  it('returns 404 when the policy denies the caller unattributed reads', async () => {
    // A fork whose org admins must not touch another department's abandoned
    // work: the same orphan, the same admin, a narrower policy. The route
    // follows the policy without a line of its own changing.
    denyUnattributedReads();
    vi.mocked(prisma.aiExperiment.findFirst).mockImplementation(
      ownerScopedFindFirst([makeExperiment({ createdBy: null })]) as never
    );

    const res = await POST(makeRequest(), ctx());

    expect(res.status).toBe(404);
    expect(vi.mocked(prisma.aiExperiment.updateMany)).not.toHaveBeenCalled();
  });
});
