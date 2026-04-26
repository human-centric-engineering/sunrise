/**
 * Integration Test: Admin Orchestration — Run Experiment
 *
 * POST /api/v1/admin/orchestration/experiments/:id/run
 *
 * @see app/api/v1/admin/orchestration/experiments/[id]/run/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/experiments/[id]/run/route';
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

const mockEvalSessionCreate = vi.fn();
const mockVariantUpdate = vi.fn();
const mockTxFindUnique = vi.fn();
const mockTxUpdate = vi.fn();

vi.mock('@/lib/db/client', () => {
  const experimentFindUnique = vi.fn();

  const txProxy = {
    aiEvaluationSession: { create: (...args: unknown[]) => mockEvalSessionCreate(...args) },
    aiExperimentVariant: { update: (...args: unknown[]) => mockVariantUpdate(...args) },
    aiExperiment: {
      findUnique: (...args: unknown[]) => mockTxFindUnique(...args),
      update: (...args: unknown[]) => mockTxUpdate(...args),
    },
  };

  return {
    prisma: {
      aiExperiment: {
        findUnique: experimentFindUnique,
      },
      $transaction: vi.fn((cb: (tx: typeof txProxy) => Promise<unknown>) => cb(txProxy)),
    },
  };
});

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
    agentId: 'agent-1',
    status: 'draft',
    createdBy: ADMIN_ID,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    variants: [
      { id: 'v1', label: 'Control', agentVersionId: null },
      { id: 'v2', label: 'Variant A', agentVersionId: null },
    ],
    ...overrides,
  };
}

function makeExperimentWithAgent(overrides: Record<string, unknown> = {}) {
  return {
    ...makeExperiment(overrides),
    agent: { id: 'agent-1', name: 'Test Agent', slug: 'test-agent' },
    creator: { id: ADMIN_ID, name: 'Admin User' },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

type RouteContext = { params: Promise<{ id: string }> };

function makeContext(id = EXPERIMENT_ID): RouteContext {
  return { params: Promise.resolve({ id }) };
}

function makePostRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/experiments/${EXPERIMENT_ID}/run`,
    { method: 'POST' }
  );
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/experiments/:id/run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
    // Outer findUnique: 404 check (select: { id: true })
    vi.mocked(prisma.aiExperiment.findUnique).mockResolvedValue({ id: EXPERIMENT_ID } as never);
    // Inner tx findUnique: full experiment with variants
    mockTxFindUnique.mockResolvedValue(makeExperiment() as never);
    mockTxUpdate.mockResolvedValue(makeExperimentWithAgent({ status: 'running' }) as never);
    mockEvalSessionCreate.mockResolvedValue({ id: 'eval-session-1' });
    mockVariantUpdate.mockResolvedValue({});
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await POST(makePostRequest(), makeContext());

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await POST(makePostRequest(), makeContext());

      expect(response.status).toBe(403);
    });

    it('returns 429 when rate limited', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await POST(makePostRequest(), makeContext());

      expect(response.status).toBe(429);
    });
  });

  describe('Not found', () => {
    it('returns 404 when experiment does not exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiExperiment.findUnique).mockResolvedValue(null);

      const response = await POST(makePostRequest(), makeContext('unknown-id'));

      expect(response.status).toBe(404);
    });
  });

  describe('Validation errors', () => {
    it('returns 400 when experiment is already running', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      mockTxFindUnique.mockResolvedValue(makeExperiment({ status: 'running' }) as never);

      const response = await POST(makePostRequest(), makeContext());

      expect(response.status).toBe(400);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.success).toBe(false);
    });

    it('returns 400 when experiment is already completed', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      mockTxFindUnique.mockResolvedValue(makeExperiment({ status: 'completed' }) as never);

      const response = await POST(makePostRequest(), makeContext());

      expect(response.status).toBe(400);
    });

    it('returns 400 when experiment has fewer than 2 variants', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      mockTxFindUnique.mockResolvedValue(
        makeExperiment({ variants: [{ id: 'v1', label: 'Control' }] }) as never
      );

      const response = await POST(makePostRequest(), makeContext());

      expect(response.status).toBe(400);
    });
  });

  describe('Successful run', () => {
    it('transitions status to "running" and returns 200', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest(), makeContext());

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { status: string } }>(response);
      expect(data.success).toBe(true);
      expect(data.data.status).toBe('running');
    });

    it('calls tx.aiExperiment.update with status "running"', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      await POST(makePostRequest(), makeContext());

      expect(mockTxUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: EXPERIMENT_ID },
          data: { status: 'running' },
        })
      );
    });

    it('calls logAdminAction with action "experiment.run"', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      await POST(makePostRequest(), makeContext());

      expect(vi.mocked(logAdminAction)).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: ADMIN_ID,
          action: 'experiment.run',
          entityType: 'experiment',
        })
      );
    });

    it('creates one evaluation session per variant', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      await POST(makePostRequest(), makeContext());

      expect(mockEvalSessionCreate).toHaveBeenCalledTimes(2);
      expect(mockEvalSessionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            agentId: 'agent-1',
            title: 'Test Experiment — Control',
            status: 'in_progress',
          }),
        })
      );
      expect(mockEvalSessionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            title: 'Test Experiment — Variant A',
          }),
        })
      );
    });

    it('links evaluation sessions to variants via evaluationSessionId', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      mockEvalSessionCreate.mockResolvedValue({ id: 'eval-session-123' });

      await POST(makePostRequest(), makeContext());

      expect(mockVariantUpdate).toHaveBeenCalledTimes(2);
      expect(mockVariantUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'v1' },
          data: { evaluationSessionId: 'eval-session-123' },
        })
      );
    });

    it('performs status check inside transaction (TOCTOU guard)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      await POST(makePostRequest(), makeContext());

      // tx.aiExperiment.findUnique is called inside the transaction
      expect(mockTxFindUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: EXPERIMENT_ID },
          include: { variants: true },
        })
      );
      // The outer prisma.aiExperiment.findUnique only does a lightweight 404 check
      expect(vi.mocked(prisma.aiExperiment.findUnique)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: EXPERIMENT_ID },
          select: { id: true },
        })
      );
    });
  });
});
