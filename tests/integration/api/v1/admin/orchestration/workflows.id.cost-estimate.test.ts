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
    aiOrchestrationSettings: { findUnique: vi.fn() },
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
import { GET, POST } from '@/app/api/v1/admin/orchestration/workflows/[id]/cost-estimate/route';
import type { WorkflowDefinition } from '@/types/orchestration';

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
  modelMix: [
    {
      modelId: 'claude-sonnet-4-6',
      role: 'work' as const,
      inputTokens: 12_000,
      outputTokens: 4_000,
      costUsd: 0.42,
      pricingKnown: true,
    },
  ],
  workflowHasSupervisor: false,
  llmStepCount: 5,
  perStep: [],
  notes: 'Calibrated from 7 past runs.',
};

describe('GET /api/v1/admin/orchestration/workflows/:id/cost-estimate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
    vi.mocked(estimateWorkflowCost).mockResolvedValue(SAMPLE_ESTIMATE);
    // resolveEffectiveCap reads the singleton settings row; default to
    // no org-level cap configured so existing assertions don't need to
    // care unless they specifically test the cap.
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      defaultMaxCostPerExecutionUsd: null,
    } as never);
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
      expect(body.data).toEqual({ ...SAMPLE_ESTIMATE, effectiveCapUsd: null });
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

// ---------------------------------------------------------------------------
// Minimal valid definition fixture — one llm_call step, no supervisor.
// ---------------------------------------------------------------------------
const MINIMAL_DEFINITION: WorkflowDefinition = {
  steps: [
    {
      id: 'step-1',
      name: 'Draft reply',
      type: 'llm_call',
      config: { agentId: 'cmjbv4i3x00003wsloputgwul' },
      nextSteps: [],
    },
  ],
  entryStepId: 'step-1',
  errorStrategy: 'fail',
};

function makePostRequest(body: unknown): NextRequest {
  return {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    url: `http://localhost:3000/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}/cost-estimate`,
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}

function makeInvalidJsonRequest(): NextRequest {
  return {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    url: `http://localhost:3000/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}/cost-estimate`,
    json: () => Promise.reject(new SyntaxError('Unexpected token')),
  } as unknown as NextRequest;
}

describe('POST /api/v1/admin/orchestration/workflows/:id/cost-estimate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
    vi.mocked(estimateWorkflowCost).mockResolvedValue(SAMPLE_ESTIMATE);
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      defaultMaxCostPerExecutionUsd: null,
    } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const response = await POST(
        makePostRequest({ definition: MINIMAL_DEFINITION }),
        makeParams(WORKFLOW_ID)
      );
      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
      const response = await POST(
        makePostRequest({ definition: MINIMAL_DEFINITION }),
        makeParams(WORKFLOW_ID)
      );
      expect(response.status).toBe(403);
    });
  });

  describe('Body validation', () => {
    beforeEach(() => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    });

    it('returns 400 when body is invalid JSON', async () => {
      const response = await POST(makeInvalidJsonRequest(), makeParams(WORKFLOW_ID));
      expect(response.status).toBe(400);
      const body = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(body.success).toBe(false);
    });

    it('returns 400 when body fails Zod (missing definition)', async () => {
      const response = await POST(
        makePostRequest({ itemCount: 5 }), // definition is absent
        makeParams(WORKFLOW_ID)
      );
      expect(response.status).toBe(400);
      const body = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(body.success).toBe(false);
    });
  });

  describe('Workflow lookup', () => {
    beforeEach(() => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    });

    it('returns 404 when workflow not found', async () => {
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(null);
      const response = await POST(
        makePostRequest({ definition: MINIMAL_DEFINITION }),
        makeParams(WORKFLOW_ID)
      );
      expect(response.status).toBe(404);
    });
  });

  describe('Successful estimate', () => {
    beforeEach(() => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue({ id: WORKFLOW_ID } as never);
    });

    it('returns 200 with the estimate + effectiveCapUsd=null when no caps configured', async () => {
      const response = await POST(
        makePostRequest({ definition: MINIMAL_DEFINITION }),
        makeParams(WORKFLOW_ID)
      );
      expect(response.status).toBe(200);
      const body = await parseJson<{
        success: boolean;
        data: typeof SAMPLE_ESTIMATE & { effectiveCapUsd: null };
      }>(response);
      expect(body.success).toBe(true);
      // Route wraps the estimate in the success envelope and appends effectiveCapUsd
      expect(body.data).toEqual({ ...SAMPLE_ESTIMATE, effectiveCapUsd: null });
    });

    it('passes the body definition through to estimateWorkflowCost (not the published one)', async () => {
      const twoStepDefinition: WorkflowDefinition = {
        steps: [
          {
            id: 'step-a',
            name: 'Classify',
            type: 'llm_call',
            config: { agentId: 'cmjbv4i3x00003wsloputgwul' },
            nextSteps: [],
          },
          {
            id: 'step-b',
            name: 'Summarise',
            type: 'llm_call',
            config: { agentId: 'cmjbv4i3x00003wsloputgwul' },
            nextSteps: [],
          },
        ],
        entryStepId: 'step-a',
        errorStrategy: 'fail',
      };

      await POST(makePostRequest({ definition: twoStepDefinition }), makeParams(WORKFLOW_ID));

      // The estimator must receive the in-memory definition, not undefined
      expect(estimateWorkflowCost).toHaveBeenCalledWith(
        expect.objectContaining({ definition: twoStepDefinition })
      );
      // Verify it was NOT called without a definition (i.e. the GET published-version path)
      expect(estimateWorkflowCost).not.toHaveBeenCalledWith(
        expect.not.objectContaining({ definition: expect.anything() })
      );
    });

    it('passes itemCount and supervisor body fields through to estimateWorkflowCost', async () => {
      await POST(
        makePostRequest({ definition: MINIMAL_DEFINITION, itemCount: 20, supervisor: true }),
        makeParams(WORKFLOW_ID)
      );
      expect(estimateWorkflowCost).toHaveBeenCalledWith({
        workflowId: WORKFLOW_ID,
        definition: MINIMAL_DEFINITION,
        itemCount: 20,
        supervisor: true,
      });
    });

    it('effectiveCapUsd resolves to the workflow-level cap when set', async () => {
      // resolveEffectiveCap calls findUnique twice in parallel:
      //   - once with select: { maxCostPerExecutionUsd } (cap resolution)
      //   - once with select: { id } (existence check earlier in the handler)
      // We use mockResolvedValueOnce to feed the existence check first, then
      // the cap-resolution call with the workflow-level cap.
      vi.mocked(prisma.aiWorkflow.findUnique)
        .mockResolvedValueOnce({ id: WORKFLOW_ID } as never) // existence check
        .mockResolvedValueOnce({ maxCostPerExecutionUsd: 2.5 } as never); // cap

      const response = await POST(
        makePostRequest({ definition: MINIMAL_DEFINITION }),
        makeParams(WORKFLOW_ID)
      );
      expect(response.status).toBe(200);
      const body = await parseJson<{ success: boolean; data: { effectiveCapUsd: number | null } }>(
        response
      );
      // Route should propagate the workflow-level cap, not null
      expect(body.data.effectiveCapUsd).toBe(2.5);
    });

    it('effectiveCapUsd falls back to org-default cap when workflow has none', async () => {
      vi.mocked(prisma.aiWorkflow.findUnique)
        .mockResolvedValueOnce({ id: WORKFLOW_ID } as never) // existence check
        .mockResolvedValueOnce({ maxCostPerExecutionUsd: null } as never); // cap (no override)
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
        defaultMaxCostPerExecutionUsd: 1.0,
      } as never);

      const response = await POST(
        makePostRequest({ definition: MINIMAL_DEFINITION }),
        makeParams(WORKFLOW_ID)
      );
      expect(response.status).toBe(200);
      const body = await parseJson<{ success: boolean; data: { effectiveCapUsd: number | null } }>(
        response
      );
      // Route falls back to the org-default cap
      expect(body.data.effectiveCapUsd).toBe(1.0);
    });

    it('effectiveCapUsd is null when both layers are null', async () => {
      vi.mocked(prisma.aiWorkflow.findUnique)
        .mockResolvedValueOnce({ id: WORKFLOW_ID } as never) // existence check
        .mockResolvedValueOnce({ maxCostPerExecutionUsd: null } as never); // cap
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
        defaultMaxCostPerExecutionUsd: null,
      } as never);

      const response = await POST(
        makePostRequest({ definition: MINIMAL_DEFINITION }),
        makeParams(WORKFLOW_ID)
      );
      expect(response.status).toBe(200);
      const body = await parseJson<{ success: boolean; data: { effectiveCapUsd: number | null } }>(
        response
      );
      expect(body.data.effectiveCapUsd).toBeNull();
    });
  });

  describe('Rate limiting', () => {
    beforeEach(() => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    });

    it('returns 429 when rate-limited and calls adminLimiter.check', async () => {
      const { createRateLimitResponse } = await import('@/lib/security/rate-limit');
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await POST(
        makePostRequest({ definition: MINIMAL_DEFINITION }),
        makeParams(WORKFLOW_ID)
      );
      expect(response.status).toBe(429);
      // Verify the limiter was consulted — not just that a 429 appeared
      expect(adminLimiter.check).toHaveBeenCalledOnce();
      expect(createRateLimitResponse).toHaveBeenCalledOnce();
    });
  });
});
