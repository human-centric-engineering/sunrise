/**
 * Integration Test: Admin Orchestration — Single Experiment (GET / PATCH / DELETE)
 *
 * GET    /api/v1/admin/orchestration/experiments/:id
 * PATCH  /api/v1/admin/orchestration/experiments/:id
 * DELETE /api/v1/admin/orchestration/experiments/:id
 *
 * @see app/api/v1/admin/orchestration/experiments/[id]/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, PATCH, DELETE } from '@/app/api/v1/admin/orchestration/experiments/[id]/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';
import { ownerScopedFindFirst } from '@/tests/helpers/owner-scoped-prisma';

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
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

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
  return {
    id: EXPERIMENT_ID,
    name: 'Test Experiment',
    description: null,
    agentId: 'agent-1',
    status: 'draft',
    createdBy: ADMIN_ID,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    agent: { id: 'agent-1', name: 'Test Agent', slug: 'test-agent' },
    variants: [
      { id: 'v1', label: 'Control', agentVersionId: null },
      { id: 'v2', label: 'Variant A', agentVersionId: null },
    ],
    creator: { id: ADMIN_ID, name: 'Admin User' },
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

type RouteContext = { params: Promise<{ id: string }> };

function makeContext(id = EXPERIMENT_ID): RouteContext {
  return { params: Promise.resolve({ id }) };
}

function makeGetRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/experiments/${EXPERIMENT_ID}`
  );
}

function makePatchRequest(body: Record<string, unknown>): NextRequest {
  return {
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: `http://localhost:3000/api/v1/admin/orchestration/experiments/${EXPERIMENT_ID}`,
  } as unknown as NextRequest;
}

function makeDeleteRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/experiments/${EXPERIMENT_ID}`,
    { method: 'DELETE' }
  );
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/experiments/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(makeExperiment() as never);
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await GET(makeGetRequest(), makeContext());

    expect(response.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const response = await GET(makeGetRequest(), makeContext());

    expect(response.status).toBe(403);
  });

  it('returns 404 when experiment not found', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(null);

    const response = await GET(makeGetRequest(), makeContext('unknown-id'));

    expect(response.status).toBe(404);
  });

  it('returns 200 with experiment data', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await GET(makeGetRequest(), makeContext());

    expect(response.status).toBe(200);
    const data = await parseJson<{ success: boolean; data: { id: string } }>(response);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(data.success).toBe(true);
    expect(data.data.id).toBe(EXPERIMENT_ID);
  });
});

describe('PATCH /api/v1/admin/orchestration/experiments/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(makeExperiment() as never);
    vi.mocked(prisma.aiExperiment.update).mockResolvedValue(makeExperiment() as never);
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await PATCH(makePatchRequest({ name: 'New Name' }), makeContext());

    expect(response.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const response = await PATCH(makePatchRequest({ name: 'New Name' }), makeContext());

    expect(response.status).toBe(403);
  });

  it('returns 400 when no fields are provided', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await PATCH(makePatchRequest({}), makeContext());

    expect(response.status).toBe(400);
  });

  it('returns 404 when experiment not found', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(null);

    const response = await PATCH(makePatchRequest({ name: 'New Name' }), makeContext());

    expect(response.status).toBe(404);
  });

  it('updates name and returns 200', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiExperiment.update).mockResolvedValue(
      makeExperiment({ name: 'Updated Name' }) as never
    );

    const response = await PATCH(makePatchRequest({ name: 'Updated Name' }), makeContext());

    expect(response.status).toBe(200);
    const data = await parseJson<{ success: boolean; data: { name: string } }>(response);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(data.success).toBe(true);
    // Verify the serialised response body contains the updated name — a broken
    // successResponse serialiser that echoed the old value would not be caught otherwise.
    expect(data.data.name).toBe('Updated Name');
    expect(vi.mocked(logAdminAction)).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'experiment.update' })
    );
  });

  it('allows valid status transition draft → completed', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(
      makeExperiment({ status: 'draft' }) as never
    );
    vi.mocked(prisma.aiExperiment.update).mockResolvedValue(
      makeExperiment({ status: 'completed' }) as never
    );

    const response = await PATCH(makePatchRequest({ status: 'completed' }), makeContext());

    expect(response.status).toBe(200);
  });

  it('allows valid status transition running → completed', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(
      makeExperiment({ status: 'running' }) as never
    );
    vi.mocked(prisma.aiExperiment.update).mockResolvedValue(
      makeExperiment({ status: 'completed' }) as never
    );

    const response = await PATCH(makePatchRequest({ status: 'completed' }), makeContext());

    expect(response.status).toBe(200);
  });

  it('rejects invalid status transition completed → draft', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(
      makeExperiment({ status: 'completed' }) as never
    );

    const response = await PATCH(makePatchRequest({ status: 'draft' }), makeContext());

    expect(response.status).toBe(400);
  });

  it('rejects invalid status transition running → draft', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(
      makeExperiment({ status: 'running' }) as never
    );

    const response = await PATCH(makePatchRequest({ status: 'draft' }), makeContext());

    expect(response.status).toBe(400);
  });

  it('rejects invalid status transition completed → running', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(
      makeExperiment({ status: 'completed' }) as never
    );

    const response = await PATCH(makePatchRequest({ status: 'running' }), makeContext());

    expect(response.status).toBe(400);
  });

  it('rejects status transition draft → running (must use /run endpoint)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(
      makeExperiment({ status: 'draft' }) as never
    );

    const response = await PATCH(makePatchRequest({ status: 'running' }), makeContext());

    expect(response.status).toBe(400);
    expect(vi.mocked(prisma.aiExperiment.update)).not.toHaveBeenCalled();
  });

  it('updates description only when name and status are absent', async () => {
    // Catches a regression where the conditional spread `...(body.description !== undefined)`
    // is accidentally removed, silently discarding description-only updates.
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiExperiment.update).mockResolvedValue(
      makeExperiment({ description: 'Updated description' }) as never
    );

    const response = await PATCH(
      makePatchRequest({ description: 'Updated description' }),
      makeContext()
    );

    expect(response.status).toBe(200);
    expect(vi.mocked(prisma.aiExperiment.update)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ description: 'Updated description' }),
      })
    );
    // name and status must NOT appear in the update data when not supplied
    expect(vi.mocked(prisma.aiExperiment.update)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ name: expect.anything() }),
      })
    );
  });

  it('passes description: null to Prisma to explicitly clear the field', async () => {
    // Catches a regression where the nullish-coalescing operator or optional-chaining
    // strips null before it reaches the DB, leaving the old description in place.
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiExperiment.update).mockResolvedValue(
      makeExperiment({ description: null }) as never
    );

    const response = await PATCH(makePatchRequest({ description: null }), makeContext());

    expect(response.status).toBe(200);
    expect(vi.mocked(prisma.aiExperiment.update)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ description: null }),
      })
    );
  });

  it('spreads name, description and status together when all three are provided', async () => {
    // Catches a regression where the conditional-spread logic for one field
    // clobbers or skips the others when multiple fields are patched at once.
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiExperiment.update).mockResolvedValue(
      makeExperiment({ name: 'New Name', description: 'New desc', status: 'completed' }) as never
    );

    const response = await PATCH(
      makePatchRequest({ name: 'New Name', description: 'New desc', status: 'completed' }),
      makeContext()
    );

    expect(response.status).toBe(200);
    expect(vi.mocked(prisma.aiExperiment.update)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: 'New Name',
          description: 'New desc',
          status: 'completed',
        }),
      })
    );
  });

  it('returns 400 when the existing experiment has an unrecognised status (ALLOWED_TRANSITIONS fallback)', async () => {
    // Exercises the `ALLOWED_TRANSITIONS[existing.status] ?? []` fallback for an
    // unknown status value (e.g. a row migrated to a legacy/custom status string).
    // The empty-array fallback means NO transition is allowed, so any target status
    // must produce a 400. If the `?? []` guard is removed the access returns
    // `undefined` and `undefined.includes(...)` throws a 500 instead.
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(
      makeExperiment({ status: 'archived' }) as never
    );

    const response = await PATCH(makePatchRequest({ status: 'completed' }), makeContext());

    expect(response.status).toBe(400);
    const data = await parseJson<{ success: boolean; error: { code: string; message: string } }>(
      response
    );
    expect(data.success).toBe(false);
    expect(data.error.code).toBe('VALIDATION_ERROR');
    // Message must name both the source and target to help operators diagnose
    expect(data.error.message).toContain('archived');
    expect(vi.mocked(prisma.aiExperiment.update)).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/v1/admin/orchestration/experiments/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(makeExperiment() as never);
    vi.mocked(prisma.aiExperiment.delete).mockResolvedValue(makeExperiment() as never);
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await DELETE(makeDeleteRequest(), makeContext());

    expect(response.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    // Catches a regression where the withAdminAuth guard is accidentally
    // replaced with withAuth, allowing any authenticated user to delete experiments.
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const response = await DELETE(makeDeleteRequest(), makeContext());

    expect(response.status).toBe(403);
    expect(vi.mocked(prisma.aiExperiment.delete)).not.toHaveBeenCalled();
  });

  it('returns 404 when experiment not found', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(null);

    const response = await DELETE(makeDeleteRequest(), makeContext());

    expect(response.status).toBe(404);
  });

  it('returns 400 when deleting a running experiment', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(
      makeExperiment({ status: 'running' }) as never
    );

    const response = await DELETE(makeDeleteRequest(), makeContext());

    expect(response.status).toBe(400);
    expect(vi.mocked(prisma.aiExperiment.delete)).not.toHaveBeenCalled();
  });

  it('deletes draft experiment and returns { deleted: true }', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await DELETE(makeDeleteRequest(), makeContext());

    expect(response.status).toBe(200);
    const data = await parseJson<{ success: boolean; data: { deleted: boolean } }>(response);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(data.success).toBe(true);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(data.data.deleted).toBe(true);
    expect(vi.mocked(logAdminAction)).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'experiment.delete' })
    );
  });

  it('deletes completed experiment and returns { deleted: true }', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(
      makeExperiment({ status: 'completed' }) as never
    );

    const response = await DELETE(makeDeleteRequest(), makeContext());

    expect(response.status).toBe(200);
    const data = await parseJson<{ success: boolean; data: { deleted: boolean } }>(response);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(data.data.deleted).toBe(true);
  });
});

/**
 * #741: the list and detail routes read every admin's experiments while
 * `run` / `compare` / `verdicts` 404'd across users. These pin the posture the
 * whole family now shares.
 *
 * The owner-aware fake is what makes them able to fail: with
 * `mockResolvedValue(foreignRow)` the route gets its row back whether or not it
 * asked for its own, so the 404 assertions would pass against an unscoped
 * `findUnique({ where: { id } })` too.
 */
describe('ownership — a cross-user read, edit or delete is a 404', () => {
  const FOREIGN = [makeExperiment({ createdBy: 'someone-else' })];
  const OWN = [makeExperiment({ createdBy: ADMIN_ID })];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiExperiment.update).mockResolvedValue(makeExperiment() as never);
    vi.mocked(prisma.aiExperiment.delete).mockResolvedValue(makeExperiment() as never);
  });

  it('GET returns 404 for another admin’s experiment, and asks for its own', async () => {
    vi.mocked(prisma.aiExperiment.findFirst).mockImplementation(
      ownerScopedFindFirst(FOREIGN) as never
    );

    const response = await GET(makeGetRequest(), makeContext());

    expect(response.status).toBe(404);
    expect(vi.mocked(prisma.aiExperiment.findFirst).mock.calls[0][0]).toMatchObject({
      where: { id: EXPERIMENT_ID, createdBy: ADMIN_ID },
    });
  });

  it('PATCH returns 404 for another admin’s experiment and writes nothing', async () => {
    vi.mocked(prisma.aiExperiment.findFirst).mockImplementation(
      ownerScopedFindFirst(FOREIGN) as never
    );

    const response = await PATCH(makePatchRequest({ name: 'Hijacked' }), makeContext());

    expect(response.status).toBe(404);
    expect(vi.mocked(prisma.aiExperiment.update)).not.toHaveBeenCalled();
  });

  it('DELETE returns 404 for another admin’s experiment and deletes nothing', async () => {
    vi.mocked(prisma.aiExperiment.findFirst).mockImplementation(
      ownerScopedFindFirst(FOREIGN) as never
    );

    const response = await DELETE(makeDeleteRequest(), makeContext());

    expect(response.status).toBe(404);
    expect(vi.mocked(prisma.aiExperiment.delete)).not.toHaveBeenCalled();
  });

  // The control for all three: same fake, same fixture, only `createdBy`
  // differs. Without it a fake that returned null unconditionally would make
  // the three cases above green while proving nothing.
  it('GET returns 200 when the caller owns it', async () => {
    vi.mocked(prisma.aiExperiment.findFirst).mockImplementation(ownerScopedFindFirst(OWN) as never);

    const response = await GET(makeGetRequest(), makeContext());

    expect(response.status).toBe(200);
  });

  it('DELETE returns 200 when the caller owns it', async () => {
    vi.mocked(prisma.aiExperiment.findFirst).mockImplementation(ownerScopedFindFirst(OWN) as never);

    const response = await DELETE(makeDeleteRequest(), makeContext());

    expect(response.status).toBe(200);
    // Deliberately not an exact match on `{ where: { id } }`. The owner test
    // is the `findFirst` above, matching how the webhooks family does it; a
    // later hardening to `deleteMany({ where: { id, createdBy } })` should not
    // have to fight this route's own ownership test to land.
    expect(vi.mocked(prisma.aiExperiment.delete)).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: EXPERIMENT_ID }) })
    );
  });
});
