/**
 * Integration Test: Admin Orchestration — Cancel Run
 *
 * POST /api/v1/admin/orchestration/evaluations/runs/:id/cancel
 *
 * @see app/api/v1/admin/orchestration/evaluations/runs/[id]/cancel/route.ts
 *
 * Coverage matrix:
 * - 401 / 403 / 400 on auth + CUID validation
 * - 404 when run belongs to another user
 * - 409 when run is already terminal (completed / failed / cancelled)
 * - 200 happy path: queued → cancelled
 * - 200 happy path: running → cancelled
 * - update payload clears lockedBy / lockedAt and sets completedAt
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/evaluations/runs/[id]/cancel/route';
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
    aiEvaluationRun: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(() =>
    Promise.resolve({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
  ),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const RUN_ID = 'cmjbv4i3x00003wsloputgwu1';
const INVALID_ID = 'not-a-cuid';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePostRequest(id: string): NextRequest {
  return {
    method: 'POST',
    headers: new Headers(),
    url: `http://localhost:3000/api/v1/admin/orchestration/evaluations/runs/${id}/cancel`,
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/evaluations/runs/:id/cancel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await POST(makePostRequest(RUN_ID), makeParams(RUN_ID));

    expect(response.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const response = await POST(makePostRequest(RUN_ID), makeParams(RUN_ID));

    expect(response.status).toBe(403);
  });

  it('returns 400 when id is not a valid CUID', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await POST(makePostRequest(INVALID_ID), makeParams(INVALID_ID));

    expect(response.status).toBe(400);
  });

  it('returns 404 when run belongs to another user', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEvaluationRun.findFirst).mockResolvedValue(null);

    const response = await POST(makePostRequest(RUN_ID), makeParams(RUN_ID));

    expect(response.status).toBe(404);
    expect(vi.mocked(prisma.aiEvaluationRun.findFirst)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: RUN_ID, userId: ADMIN_ID }),
      })
    );
    expect(vi.mocked(prisma.aiEvaluationRun.update)).not.toHaveBeenCalled();
  });

  describe.each([['completed' as const], ['failed' as const], ['cancelled' as const]])(
    'terminal state: %s',
    (status) => {
      it(`returns 409 when run is already ${status}`, async () => {
        vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
        vi.mocked(prisma.aiEvaluationRun.findFirst).mockResolvedValue({
          id: RUN_ID,
          status,
        } as never);

        const response = await POST(makePostRequest(RUN_ID), makeParams(RUN_ID));

        expect(response.status).toBe(409);
        const data = await parseJson<{ error: { code: string; message: string } }>(response);
        expect(data.error.code).toBe('CONFLICT');
        expect(data.error.message).toContain(status);
        expect(vi.mocked(prisma.aiEvaluationRun.update)).not.toHaveBeenCalled();
      });
    }
  );

  it('returns 200 and flips queued → cancelled', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEvaluationRun.findFirst).mockResolvedValue({
      id: RUN_ID,
      status: 'queued',
    } as never);
    vi.mocked(prisma.aiEvaluationRun.update).mockResolvedValue({
      id: RUN_ID,
      status: 'cancelled',
    } as never);

    const response = await POST(makePostRequest(RUN_ID), makeParams(RUN_ID));

    expect(response.status).toBe(200);
    const data = await parseJson<{ data: { status: string } }>(response);
    expect(data.data.status).toBe('cancelled');
    expect(vi.mocked(prisma.aiEvaluationRun.update)).toHaveBeenCalledWith({
      where: { id: RUN_ID },
      data: expect.objectContaining({
        status: 'cancelled',
        lockedBy: null,
        lockedAt: null,
        completedAt: expect.any(Date),
      }),
    });
  });

  it('returns 200 and flips running → cancelled', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEvaluationRun.findFirst).mockResolvedValue({
      id: RUN_ID,
      status: 'running',
    } as never);
    vi.mocked(prisma.aiEvaluationRun.update).mockResolvedValue({
      id: RUN_ID,
      status: 'cancelled',
    } as never);

    const response = await POST(makePostRequest(RUN_ID), makeParams(RUN_ID));

    expect(response.status).toBe(200);
  });
});
