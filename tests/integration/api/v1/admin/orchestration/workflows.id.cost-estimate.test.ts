/**
 * Integration Test: Workflow cost-estimate endpoint
 *
 * GET /api/v1/admin/orchestration/workflows/:id/cost-estimate
 *   ?itemCount=N&supervisor=true|false
 *
 * Key behaviours:
 *   - Returns 200 with the estimate payload for any workflow (generic)
 *   - Returns 404 when the workflow id doesn't resolve
 *   - Returns 400 for missing / malformed query params
 *   - Admin auth required (401 / 403)
 *   - itemCount and supervisor are both optional — workflows without
 *     a scaling input or supervisor step omit them
 *
 * The estimator function itself is mocked — its own unit tests cover the
 * empirical/heuristic logic. This file verifies the route wiring.
 *
 * @see app/api/v1/admin/orchestration/workflows/[id]/cost-estimate/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflow: { findUnique: vi.fn() },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/orchestration/cost-estimation/workflow-cost', () => ({
  estimateWorkflowCost: vi.fn(),
}));

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';
import { estimateWorkflowCost } from '@/lib/orchestration/cost-estimation/workflow-cost';
import { GET } from '@/app/api/v1/admin/orchestration/workflows/[id]/cost-estimate/route';

const WORKFLOW_ID = 'cmjbv4i3x00003wsloputgwul';
const INVALID_ID = 'not-a-cuid';

function makeRequest(query: string = 'itemCount=5&supervisor=false'): NextRequest {
  return {
    method: 'GET',
    headers: new Headers(),
    url: `http://localhost:3000/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}/cost-estimate?${query}`,
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

const SAMPLE_ESTIMATE = {
  midUsd: 0.42,
  lowUsd: 0.3,
  highUsd: 0.6,
  basedOn: 'empirical' as const,
  sampleSize: 7,
  modelUsed: 'claude-sonnet-4-6',
  judgeModelUsed: null,
  workflowHasSupervisor: false,
  llmStepCount: 5,
  notes: 'Calibrated from 7 past runs.',
};

describe('GET /api/v1/admin/orchestration/workflows/:id/cost-estimate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
    vi.mocked(estimateWorkflowCost).mockResolvedValue(SAMPLE_ESTIMATE);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const response = await GET(makeRequest(), makeParams(WORKFLOW_ID));
      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
      const response = await GET(makeRequest(), makeParams(WORKFLOW_ID));
      expect(response.status).toBe(403);
    });
  });

  describe('Param validation', () => {
    beforeEach(() => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    });

    it('returns 400 for an invalid workflow CUID', async () => {
      const response = await GET(makeRequest(), makeParams(INVALID_ID));
      expect(response.status).toBe(400);
    });

    it('returns 400 for a negative itemCount', async () => {
      const response = await GET(
        makeRequest('itemCount=-1&supervisor=true'),
        makeParams(WORKFLOW_ID)
      );
      expect(response.status).toBe(400);
    });

    it('returns 400 for a non-boolean supervisor value', async () => {
      const response = await GET(
        makeRequest('itemCount=5&supervisor=maybe'),
        makeParams(WORKFLOW_ID)
      );
      expect(response.status).toBe(400);
    });

    it('accepts an empty query string (both params optional)', async () => {
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue({ id: WORKFLOW_ID } as never);
      const response = await GET(makeRequest(''), makeParams(WORKFLOW_ID));
      expect(response.status).toBe(200);
      expect(estimateWorkflowCost).toHaveBeenCalledWith({
        workflowId: WORKFLOW_ID,
        itemCount: undefined,
        supervisor: undefined,
      });
    });
  });

  describe('Workflow lookup', () => {
    beforeEach(() => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    });

    it('returns 404 when the workflow id does not exist', async () => {
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(null);
      const response = await GET(makeRequest(), makeParams(WORKFLOW_ID));
      expect(response.status).toBe(404);
    });

    it('works for any workflow (no slug gating)', async () => {
      // Generic — used to be slug-gated to tpl-provider-model-audit but
      // is now a service any workflow's trigger UI can call.
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue({
        id: WORKFLOW_ID,
        slug: 'some-other-workflow',
      } as never);
      const response = await GET(makeRequest(), makeParams(WORKFLOW_ID));
      expect(response.status).toBe(200);
    });
  });

  describe('Successful estimate', () => {
    beforeEach(() => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue({ id: WORKFLOW_ID } as never);
    });

    it('returns 200 with the estimate payload', async () => {
      const response = await GET(
        makeRequest('itemCount=5&supervisor=false'),
        makeParams(WORKFLOW_ID)
      );
      expect(response.status).toBe(200);
      const body = await parseJson<{ success: boolean; data: typeof SAMPLE_ESTIMATE }>(response);
      expect(body.success).toBe(true);
      expect(body.data).toEqual(SAMPLE_ESTIMATE);
    });

    it('passes the parsed itemCount and supervisor flag to the estimator', async () => {
      await GET(makeRequest('itemCount=12&supervisor=true'), makeParams(WORKFLOW_ID));
      expect(estimateWorkflowCost).toHaveBeenCalledWith({
        workflowId: WORKFLOW_ID,
        itemCount: 12,
        supervisor: true,
      });
    });

    it("accepts itemCount=0 (operator hasn't selected anything yet)", async () => {
      const response = await GET(
        makeRequest('itemCount=0&supervisor=false'),
        makeParams(WORKFLOW_ID)
      );
      expect(response.status).toBe(200);
    });
  });
});
