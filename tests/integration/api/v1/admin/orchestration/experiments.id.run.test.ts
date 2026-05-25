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

const {
  mockEvalSessionCreate,
  mockEvalRunCreate,
  mockVariantUpdate,
  mockTxFindUnique,
  mockTxUpdate,
} = vi.hoisted(() => ({
  mockEvalSessionCreate: vi.fn(),
  mockEvalRunCreate: vi.fn(),
  mockVariantUpdate: vi.fn(),
  mockTxFindUnique: vi.fn(),
  mockTxUpdate: vi.fn(),
}));

vi.mock('@/lib/db/client', () => {
  const experimentFindFirst = vi.fn();

  const txProxy = {
    aiEvaluationSession: { create: (...args: unknown[]) => mockEvalSessionCreate(...args) },
    aiEvaluationRun: { create: (...args: unknown[]) => mockEvalRunCreate(...args) },
    aiExperimentVariant: { update: (...args: unknown[]) => mockVariantUpdate(...args) },
    aiExperiment: {
      findFirst: (...args: unknown[]) => mockTxFindUnique(...args),
      update: (...args: unknown[]) => mockTxUpdate(...args),
    },
  };

  return {
    prisma: {
      aiExperiment: {
        findFirst: experimentFindFirst,
      },
      $transaction: vi.fn((cb: (tx: typeof txProxy) => Promise<unknown>) => cb(txProxy)),
    },
  };
});

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
    // Outer findUnique: 404 check (select: { id: true })
    vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue({ id: EXPERIMENT_ID } as never);
    // Inner tx findUnique: full experiment with variants
    mockTxFindUnique.mockResolvedValue(makeExperiment() as never);
    mockTxUpdate.mockResolvedValue(makeExperimentWithAgent({ status: 'running' }) as never);
    mockEvalSessionCreate.mockResolvedValue({ id: 'eval-session-1' });
    mockEvalRunCreate.mockResolvedValue({ id: 'eval-run-1' });
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
  });

  describe('Not found', () => {
    it('returns 404 when experiment does not exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(null);

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
      // test-review:accept tobe_true — structural boolean assertion on API response field
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

      // tx.aiExperiment.findFirst is called inside the transaction with
      // a userId-scoped where clause (cross-user 404, matching the
      // posture every other Phase 2 evaluation route uses).
      expect(mockTxFindUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: EXPERIMENT_ID, createdBy: ADMIN_ID },
          include: expect.objectContaining({ variants: true }),
        })
      );
      // The outer prisma.aiExperiment.findFirst applies the same
      // userId scope at the pre-transaction 404 check.
      expect(vi.mocked(prisma.aiExperiment.findFirst)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: EXPERIMENT_ID, createdBy: ADMIN_ID },
          select: { id: true },
        })
      );
    });
  });

  describe('Dataset-driven path (Phase 2.4)', () => {
    function datasetDrivenExperiment(overrides: Record<string, unknown> = {}) {
      return makeExperiment({
        datasetId: 'ds-1',
        metricConfigs: [{ slug: 'judge_agent', config: { agentSlug: 'eval-judge-relevance' } }],
        dataset: { id: 'ds-1', userId: ADMIN_ID, contentHash: 'h-abc', caseCount: 12 },
        ...overrides,
      });
    }

    it('creates one AiEvaluationRun per variant when datasetId + metricConfigs are set', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      mockTxFindUnique.mockResolvedValue(datasetDrivenExperiment() as never);

      await POST(makePostRequest(), makeContext());

      expect(mockEvalRunCreate).toHaveBeenCalledTimes(2);
      expect(mockEvalSessionCreate).not.toHaveBeenCalled();
      expect(mockEvalRunCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            subjectKind: 'agent',
            agentId: 'agent-1',
            datasetId: 'ds-1',
            datasetContentHash: 'h-abc',
            status: 'queued',
          }),
        })
      );
    });

    it('links the new eval runs to variants via evaluationRunId', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      mockTxFindUnique.mockResolvedValue(datasetDrivenExperiment() as never);
      mockEvalRunCreate.mockResolvedValue({ id: 'eval-run-123' });

      await POST(makePostRequest(), makeContext());

      expect(mockVariantUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'v1' },
          data: { evaluationRunId: 'eval-run-123' },
        })
      );
    });

    it('falls back to the legacy session path when datasetId is null', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      // datasetId omitted, dataset relation null
      mockTxFindUnique.mockResolvedValue(
        makeExperiment({ datasetId: null, dataset: null }) as never
      );

      await POST(makePostRequest(), makeContext());

      expect(mockEvalSessionCreate).toHaveBeenCalledTimes(2);
      expect(mockEvalRunCreate).not.toHaveBeenCalled();
    });

    it('records the dataset_driven mode on the admin audit entry', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      mockTxFindUnique.mockResolvedValue(datasetDrivenExperiment() as never);
      mockTxUpdate.mockResolvedValue({
        ...makeExperimentWithAgent({ status: 'running' }),
        variants: [
          { id: 'v1', evaluationRunId: 'eval-run-123' },
          { id: 'v2', evaluationRunId: 'eval-run-124' },
        ],
      } as never);

      await POST(makePostRequest(), makeContext());

      expect(vi.mocked(logAdminAction)).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ mode: 'dataset_driven' }),
        })
      );
    });
  });

  describe('Cross-user isolation', () => {
    it('returns 404 when the experiment belongs to a different admin (existence does not leak)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      // Outer findFirst returns null because the where clause includes
      // createdBy = caller.id, and the foreign experiment doesn't match.
      vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(null);

      const response = await POST(makePostRequest(), makeContext());

      expect(response.status).toBe(404);
      // Crucially, no inserts on either path. Pre-fix, the caller's
      // userId would have ended up on AiEvaluationRun rows hash-pinned
      // to the foreign dataset, letting them exfiltrate its content
      // via their own runs list.
      expect(mockEvalRunCreate).not.toHaveBeenCalled();
      expect(mockEvalSessionCreate).not.toHaveBeenCalled();
      expect(mockTxUpdate).not.toHaveBeenCalled();
    });

    it('returns 404 when the bound dataset belongs to a different admin (defence in depth)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      // Outer 404 check passes (the experiment is the caller's), but the
      // dataset linkage references a foreign user's dataset. This
      // shouldn't be possible via the create-experiment route today —
      // POST /experiments enforces dataset ownership at write time —
      // but the defence-in-depth check protects against a future writer
      // adding a new experiment-create path that misses it.
      vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue({ id: EXPERIMENT_ID } as never);
      mockTxFindUnique.mockResolvedValue({
        id: EXPERIMENT_ID,
        name: 'Test Experiment',
        agentId: 'agent-1',
        status: 'draft',
        createdBy: ADMIN_ID,
        datasetId: 'ds-foreign',
        metricConfigs: [{ slug: 'judge_agent', config: { agentSlug: 'eval-judge-relevance' } }],
        dataset: {
          id: 'ds-foreign',
          userId: 'another-admin',
          contentHash: 'h',
          caseCount: 12,
        },
        variants: [
          { id: 'v1', label: 'Control' },
          { id: 'v2', label: 'Variant A' },
        ],
      } as never);

      const response = await POST(makePostRequest(), makeContext());

      expect(response.status).toBe(404);
      expect(mockEvalRunCreate).not.toHaveBeenCalled();
      expect(mockTxUpdate).not.toHaveBeenCalled();
    });
  });
});
