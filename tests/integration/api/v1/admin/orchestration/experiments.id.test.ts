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
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
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
import { adminLimiter } from '@/lib/security/rate-limit';
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
    vi.mocked(prisma.aiExperiment.findUnique).mockResolvedValue(makeExperiment() as never);
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
    vi.mocked(prisma.aiExperiment.findUnique).mockResolvedValue(null);

    const response = await GET(makeGetRequest(), makeContext('unknown-id'));

    expect(response.status).toBe(404);
  });

  it('returns 200 with experiment data', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await GET(makeGetRequest(), makeContext());

    expect(response.status).toBe(200);
    const data = await parseJson<{ success: boolean; data: { id: string } }>(response);
    expect(data.success).toBe(true);
    expect(data.data.id).toBe(EXPERIMENT_ID);
  });
});

describe('PATCH /api/v1/admin/orchestration/experiments/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
    vi.mocked(prisma.aiExperiment.findUnique).mockResolvedValue(makeExperiment() as never);
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

  it('returns 429 when rate limited', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

    const response = await PATCH(makePatchRequest({ name: 'New Name' }), makeContext());

    expect(response.status).toBe(429);
  });

  it('returns 400 when no fields are provided', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await PATCH(makePatchRequest({}), makeContext());

    expect(response.status).toBe(400);
  });

  it('returns 404 when experiment not found', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiExperiment.findUnique).mockResolvedValue(null);

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
    expect(data.success).toBe(true);
    expect(vi.mocked(logAdminAction)).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'experiment.update' })
    );
  });

  it('allows valid status transition draft → completed', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiExperiment.findUnique).mockResolvedValue(
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
    vi.mocked(prisma.aiExperiment.findUnique).mockResolvedValue(
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
    vi.mocked(prisma.aiExperiment.findUnique).mockResolvedValue(
      makeExperiment({ status: 'completed' }) as never
    );

    const response = await PATCH(makePatchRequest({ status: 'draft' }), makeContext());

    expect(response.status).toBe(400);
  });

  it('rejects invalid status transition running → draft', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiExperiment.findUnique).mockResolvedValue(
      makeExperiment({ status: 'running' }) as never
    );

    const response = await PATCH(makePatchRequest({ status: 'draft' }), makeContext());

    expect(response.status).toBe(400);
  });

  it('rejects invalid status transition completed → running', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiExperiment.findUnique).mockResolvedValue(
      makeExperiment({ status: 'completed' }) as never
    );

    const response = await PATCH(makePatchRequest({ status: 'running' }), makeContext());

    expect(response.status).toBe(400);
  });
});

describe('DELETE /api/v1/admin/orchestration/experiments/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
    vi.mocked(prisma.aiExperiment.findUnique).mockResolvedValue(makeExperiment() as never);
    vi.mocked(prisma.aiExperiment.delete).mockResolvedValue(makeExperiment() as never);
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await DELETE(makeDeleteRequest(), makeContext());

    expect(response.status).toBe(401);
  });

  it('returns 429 when rate limited', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

    const response = await DELETE(makeDeleteRequest(), makeContext());

    expect(response.status).toBe(429);
  });

  it('returns 404 when experiment not found', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiExperiment.findUnique).mockResolvedValue(null);

    const response = await DELETE(makeDeleteRequest(), makeContext());

    expect(response.status).toBe(404);
  });

  it('returns 400 when deleting a running experiment', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiExperiment.findUnique).mockResolvedValue(
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
    expect(data.success).toBe(true);
    expect(data.data.deleted).toBe(true);
    expect(vi.mocked(logAdminAction)).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'experiment.delete' })
    );
  });

  it('deletes completed experiment and returns { deleted: true }', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiExperiment.findUnique).mockResolvedValue(
      makeExperiment({ status: 'completed' }) as never
    );

    const response = await DELETE(makeDeleteRequest(), makeContext());

    expect(response.status).toBe(200);
    const data = await parseJson<{ success: boolean; data: { deleted: boolean } }>(response);
    expect(data.data.deleted).toBe(true);
  });
});
