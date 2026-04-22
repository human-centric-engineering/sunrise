/**
 * Integration Test: Workflow definition versioning
 *
 * PATCH  /api/v1/admin/orchestration/workflows/:id
 *   — when workflowDefinition changes, old definition is pushed to history
 *
 * GET    /api/v1/admin/orchestration/workflows/:id/definition-history
 *   — returns current definition + history array (newest first) with versionIndex
 *
 * POST   /api/v1/admin/orchestration/workflows/:id/definition-revert
 *   — swaps current definition with a history entry and grows history by 1
 *   — returns 400 when versionIndex is out of range
 *
 * @see app/api/v1/admin/orchestration/workflows/[id]/route.ts
 * @see app/api/v1/admin/orchestration/workflows/[id]/definition-history/route.ts
 * @see app/api/v1/admin/orchestration/workflows/[id]/definition-revert/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { PATCH } from '@/app/api/v1/admin/orchestration/workflows/[id]/route';
import { GET } from '@/app/api/v1/admin/orchestration/workflows/[id]/definition-history/route';
import { POST as REVERT } from '@/app/api/v1/admin/orchestration/workflows/[id]/definition-revert/route';
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
    aiWorkflow: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const WORKFLOW_ID = 'cmjbv4i3x00003wsloputgwul';
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const INVALID_ID = 'not-a-cuid';

const DEF_V1 = {
  steps: [{ id: 'step-1', name: 'Step One', type: 'llm_call', config: {}, nextSteps: [] }],
  entryStepId: 'step-1',
  errorStrategy: 'fail' as const,
};

const DEF_V2 = {
  steps: [{ id: 'step-2', name: 'Step Two', type: 'chain', config: {}, nextSteps: [] }],
  entryStepId: 'step-2',
  errorStrategy: 'retry' as const,
};

const HISTORY_ENTRY_V1 = {
  definition: DEF_V1 as Record<string, unknown>,
  changedAt: '2025-01-01T00:00:00.000Z',
  changedBy: ADMIN_ID,
};

function makeWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKFLOW_ID,
    name: 'Test Workflow',
    slug: 'test-workflow',
    description: 'A test workflow',
    workflowDefinition: DEF_V2,
    workflowDefinitionHistory: [],
    patternsUsed: [],
    isActive: true,
    isTemplate: false,
    metadata: null,
    createdBy: ADMIN_ID,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePatchRequest(body: Record<string, unknown>): NextRequest {
  return {
    method: 'PATCH',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: `http://localhost:3000/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}`,
  } as unknown as NextRequest;
}

function makeGetRequest(): NextRequest {
  return {
    method: 'GET',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve({}),
    url: `http://localhost:3000/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}/definition-history`,
  } as unknown as NextRequest;
}

function makeRevertRequest(body: Record<string, unknown>): NextRequest {
  return {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: `http://localhost:3000/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}/definition-revert`,
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PATCH /api/v1/admin/orchestration/workflows/:id — definition history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  it('pushes the old workflowDefinition onto history when the definition changes', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    // Simulate current workflow with empty history and DEF_V1 as definition
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
      makeWorkflow({ workflowDefinition: DEF_V1, workflowDefinitionHistory: [] }) as never
    );
    vi.mocked(prisma.aiWorkflow.update).mockResolvedValue(
      makeWorkflow({ workflowDefinition: DEF_V2 }) as never
    );

    const response = await PATCH(
      makePatchRequest({ workflowDefinition: DEF_V2 }),
      makeParams(WORKFLOW_ID)
    );

    expect(response.status).toBe(200);

    // Verify the update was called with history containing the old definition
    const updateCall = vi.mocked(prisma.aiWorkflow.update).mock.calls[0][0] as unknown as {
      data: {
        workflowDefinition: unknown;
        workflowDefinitionHistory: Array<{ definition: unknown; changedBy: string }>;
      };
    };
    expect(updateCall.data.workflowDefinitionHistory).toHaveLength(1);
    expect(updateCall.data.workflowDefinitionHistory[0].definition).toEqual(DEF_V1);
    expect(updateCall.data.workflowDefinitionHistory[0].changedBy).toBe(ADMIN_ID);
  });

  it('appends to existing history when the definition changes again', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    // Simulate a workflow that already has one history entry
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
      makeWorkflow({
        workflowDefinition: DEF_V2,
        workflowDefinitionHistory: [HISTORY_ENTRY_V1],
      }) as never
    );
    vi.mocked(prisma.aiWorkflow.update).mockResolvedValue(makeWorkflow() as never);

    await PATCH(makePatchRequest({ workflowDefinition: DEF_V1 }), makeParams(WORKFLOW_ID));

    const updateCall = vi.mocked(prisma.aiWorkflow.update).mock.calls[0][0] as unknown as {
      data: { workflowDefinitionHistory: Array<{ definition: unknown }> };
    };
    // Should now have 2 entries: original HISTORY_ENTRY_V1 + newly pushed DEF_V2
    expect(updateCall.data.workflowDefinitionHistory).toHaveLength(2);
  });

  it('does not modify history when workflowDefinition is not in the PATCH body', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);
    vi.mocked(prisma.aiWorkflow.update).mockResolvedValue(
      makeWorkflow({ name: 'Updated Name' }) as never
    );

    await PATCH(makePatchRequest({ name: 'Updated Name' }), makeParams(WORKFLOW_ID));

    const updateCall = vi.mocked(prisma.aiWorkflow.update).mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    // workflowDefinitionHistory should not be included in the update payload
    expect(updateCall.data).not.toHaveProperty('workflowDefinitionHistory');
  });
});

describe('GET /api/v1/admin/orchestration/workflows/:id/definition-history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const response = await GET(makeGetRequest(), makeParams(WORKFLOW_ID));
      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
      const response = await GET(makeGetRequest(), makeParams(WORKFLOW_ID));
      expect(response.status).toBe(403);
    });
  });

  describe('CUID validation', () => {
    it('returns 400 for an invalid id param', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const response = await GET(makeGetRequest(), makeParams(INVALID_ID));
      expect(response.status).toBe(400);
    });
  });

  describe('Not found', () => {
    it('returns 404 when workflow does not exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(null);
      const response = await GET(makeGetRequest(), makeParams(WORKFLOW_ID));
      expect(response.status).toBe(404);
    });
  });

  describe('Successful retrieval', () => {
    it('returns current definition and empty history when no history exists', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
        makeWorkflow({ workflowDefinition: DEF_V2, workflowDefinitionHistory: [] }) as never
      );

      const response = await GET(makeGetRequest(), makeParams(WORKFLOW_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: { workflowId: string; current: unknown; history: unknown[] };
      }>(response);
      expect(data.success).toBe(true);
      expect(data.data.workflowId).toBe(WORKFLOW_ID);
      expect(data.data.current).toEqual(DEF_V2);
      expect(data.data.history).toHaveLength(0);
    });

    it('returns history entries sorted newest first with correct versionIndex', async () => {
      const historyEntries = [
        { definition: DEF_V1, changedAt: '2025-01-01T00:00:00.000Z', changedBy: ADMIN_ID },
        { definition: DEF_V2, changedAt: '2025-06-01T00:00:00.000Z', changedBy: ADMIN_ID },
      ];

      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
        makeWorkflow({ workflowDefinitionHistory: historyEntries }) as never
      );

      const response = await GET(makeGetRequest(), makeParams(WORKFLOW_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{
        data: { history: Array<{ versionIndex: number; changedAt: string }> };
      }>(response);

      // newest first: index 1 (DEF_V2 at June) should be first
      expect(data.data.history).toHaveLength(2);
      expect(data.data.history[0].versionIndex).toBe(1);
      expect(data.data.history[0].changedAt).toBe('2025-06-01T00:00:00.000Z');
      expect(data.data.history[1].versionIndex).toBe(0);
      expect(data.data.history[1].changedAt).toBe('2025-01-01T00:00:00.000Z');
    });

    it('returns an empty history array when workflowDefinitionHistory is malformed JSON', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
        makeWorkflow({ workflowDefinitionHistory: 'not-an-array' }) as never
      );

      const response = await GET(makeGetRequest(), makeParams(WORKFLOW_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{ data: { history: unknown[] } }>(response);
      expect(data.data.history).toHaveLength(0);
    });
  });
});

describe('POST /api/v1/admin/orchestration/workflows/:id/definition-revert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const response = await REVERT(
        makeRevertRequest({ versionIndex: 0 }),
        makeParams(WORKFLOW_ID)
      );
      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
      const response = await REVERT(
        makeRevertRequest({ versionIndex: 0 }),
        makeParams(WORKFLOW_ID)
      );
      expect(response.status).toBe(403);
    });
  });

  describe('Rate limiting', () => {
    it('returns 429 when rate limit is exceeded', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);
      const response = await REVERT(
        makeRevertRequest({ versionIndex: 0 }),
        makeParams(WORKFLOW_ID)
      );
      expect(response.status).toBe(429);
    });
  });

  describe('CUID validation', () => {
    it('returns 400 for an invalid id param', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const response = await REVERT(makeRevertRequest({ versionIndex: 0 }), makeParams(INVALID_ID));
      expect(response.status).toBe(400);
    });
  });

  describe('Not found', () => {
    it('returns 404 when workflow does not exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(null);
      const response = await REVERT(
        makeRevertRequest({ versionIndex: 0 }),
        makeParams(WORKFLOW_ID)
      );
      expect(response.status).toBe(404);
    });
  });

  describe('Out-of-range versionIndex', () => {
    it('returns 400 when versionIndex equals the history length (out of range)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
        makeWorkflow({ workflowDefinitionHistory: [HISTORY_ENTRY_V1] }) as never
      );

      // history has 1 entry (index 0); requesting index 1 is out of range
      const response = await REVERT(
        makeRevertRequest({ versionIndex: 1 }),
        makeParams(WORKFLOW_ID)
      );
      expect(response.status).toBe(400);
    });

    it('returns 400 when versionIndex exceeds history length', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
        makeWorkflow({ workflowDefinitionHistory: [HISTORY_ENTRY_V1] }) as never
      );

      const response = await REVERT(
        makeRevertRequest({ versionIndex: 99 }),
        makeParams(WORKFLOW_ID)
      );
      expect(response.status).toBe(400);
    });

    it('returns 400 when history is empty and any versionIndex is requested', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
        makeWorkflow({ workflowDefinitionHistory: [] }) as never
      );

      const response = await REVERT(
        makeRevertRequest({ versionIndex: 0 }),
        makeParams(WORKFLOW_ID)
      );
      expect(response.status).toBe(400);
    });
  });

  describe('Successful revert', () => {
    it('swaps current definition with the target history entry and returns 200', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
        makeWorkflow({
          workflowDefinition: DEF_V2,
          workflowDefinitionHistory: [HISTORY_ENTRY_V1],
        }) as never
      );
      vi.mocked(prisma.aiWorkflow.update).mockResolvedValue(
        makeWorkflow({ workflowDefinition: DEF_V1 }) as never
      );

      const response = await REVERT(
        makeRevertRequest({ versionIndex: 0 }),
        makeParams(WORKFLOW_ID)
      );

      expect(response.status).toBe(200);
    });

    it('saves the reverted-from definition onto history so no value is lost', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
        makeWorkflow({
          workflowDefinition: DEF_V2,
          workflowDefinitionHistory: [HISTORY_ENTRY_V1],
        }) as never
      );
      vi.mocked(prisma.aiWorkflow.update).mockResolvedValue(makeWorkflow() as never);

      await REVERT(makeRevertRequest({ versionIndex: 0 }), makeParams(WORKFLOW_ID));

      const updateCall = vi.mocked(prisma.aiWorkflow.update).mock.calls[0][0] as unknown as {
        data: {
          workflowDefinition: unknown;
          workflowDefinitionHistory: Array<{ definition: unknown; changedBy: string }>;
        };
      };

      // New definition should be the target (DEF_V1)
      expect(updateCall.data.workflowDefinition).toEqual(DEF_V1);

      // History should now have 2 entries: original + newly appended DEF_V2
      expect(updateCall.data.workflowDefinitionHistory).toHaveLength(2);
      const lastEntry =
        updateCall.data.workflowDefinitionHistory[
          updateCall.data.workflowDefinitionHistory.length - 1
        ];
      expect(lastEntry.definition).toEqual(DEF_V2);
      expect(lastEntry.changedBy).toBe(ADMIN_ID);
    });
  });

  describe('Request body validation', () => {
    it('returns 400 when versionIndex is missing from the body', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);

      const response = await REVERT(makeRevertRequest({}), makeParams(WORKFLOW_ID));
      expect(response.status).toBe(400);
    });

    it('returns 400 when versionIndex is negative', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);

      const response = await REVERT(
        makeRevertRequest({ versionIndex: -1 }),
        makeParams(WORKFLOW_ID)
      );
      expect(response.status).toBe(400);
    });
  });
});
