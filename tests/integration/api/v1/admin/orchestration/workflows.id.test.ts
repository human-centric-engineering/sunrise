/**
 * Integration Test: Admin Orchestration Single Workflow (GET / PATCH / DELETE)
 *
 * GET    /api/v1/admin/orchestration/workflows/:id
 * PATCH  /api/v1/admin/orchestration/workflows/:id
 * DELETE /api/v1/admin/orchestration/workflows/:id
 *
 * @see app/api/v1/admin/orchestration/workflows/[id]/route.ts
 */

import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, PATCH, DELETE } from '@/app/api/v1/admin/orchestration/workflows/[id]/route';
import { computeChanges } from '@/lib/orchestration/audit/admin-audit-logger';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';
import { Prisma } from '@prisma/client';

// ─── Mock dependencies ───────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => {
  const prisma = {
    aiWorkflow: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
    // The erased-person check runs in the write's transaction (t-805)
    $executeRaw: vi.fn(async () => 1),
    // A draft write's row lock (§122 t-900)
    $queryRaw: vi.fn(async () => []),
    dataErasureReceipt: { findMany: vi.fn(async () => []) },
    user: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation((cb: (tx: typeof prisma) => unknown) => cb(prisma));
  return { prisma };
});

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { workflowDefinitionVersion } from '@/lib/orchestration/config-versions';
import { prisma } from '@/lib/db/client';
import { uniqueViolationError } from '@/tests/helpers/prisma-errors';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const WORKFLOW_ID = 'cmjbv4i3x00003wsloputgwul';
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const INVALID_ID = 'not-a-cuid';

const VALID_DEFINITION = {
  steps: [
    {
      id: 'step-1',
      name: 'First Step',
      type: 'llm_call',
      config: { prompt: 'Hello' },
      nextSteps: [],
    },
  ],
  entryStepId: 'step-1',
  errorStrategy: 'fail',
};

function makeWorkflow(overrides: Record<string, unknown> = {}) {
  // Compatibility shim: legacy `workflowDefinition` overrides translate to
  // either the published-version relation or the in-progress draft column.
  const { workflowDefinition: snapshotOverride, ...rest } = overrides;
  const snapshot = snapshotOverride === undefined ? VALID_DEFINITION : snapshotOverride;
  return {
    id: WORKFLOW_ID,
    name: 'Test Workflow',
    slug: 'test-workflow',
    description: 'A test workflow',
    draftDefinition: null,
    publishedVersionId: snapshot === null ? null : 'wfv-1',
    publishedVersion: snapshot === null ? null : { id: 'wfv-1', version: 1, snapshot },
    patternsUsed: [1],
    isActive: true,
    isTemplate: false,
    isSystem: false,
    metadata: null,
    createdBy: ADMIN_ID,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...rest,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** `If-Match` from a builder that loaded `makeWorkflow()` (§122 t-900). */
const LOADED = () => workflowDefinitionVersion(makeWorkflow());

function makeRequest(
  method = 'GET',
  body?: Record<string, unknown>,
  ifMatch?: string
): NextRequest {
  return {
    method,
    headers: new Headers({
      'Content-Type': 'application/json',
      ...(ifMatch ? { 'If-Match': ifMatch } : {}),
    }),
    json: () => Promise.resolve(body ?? {}),
    url: `http://localhost:3000/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}`,
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/workflows/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  describe('Successful retrieval', () => {
    it('returns workflow by id', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);

      const response = await GET(makeRequest(), makeParams(WORKFLOW_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { id: string } }>(response);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data.id).toBe(WORKFLOW_ID);
    });

    it('returns the definition version the builder sends back on save (§122 t-900)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);

      const response = await GET(makeRequest(), makeParams(WORKFLOW_ID));

      const data = await parseJson<{ data: { definitionVersion: string } }>(response);
      expect(data.data.definitionVersion).toBe(LOADED());
    });
  });

  describe('Error cases', () => {
    it('returns 400 for invalid CUID param', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await GET(makeRequest(), makeParams(INVALID_ID));

      expect(response.status).toBe(400);
    });

    it('returns 404 when workflow not found', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(null);

      const response = await GET(makeRequest(), makeParams(WORKFLOW_ID));

      expect(response.status).toBe(404);
    });
  });
});

describe('PATCH /api/v1/admin/orchestration/workflows/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.$executeRaw).mockResolvedValue(1);
    vi.mocked(prisma.dataErasureReceipt.findMany).mockResolvedValue([]);
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await PATCH(
        makeRequest('PATCH', { name: 'Updated' }),
        makeParams(WORKFLOW_ID)
      );

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await PATCH(
        makeRequest('PATCH', { name: 'Updated' }),
        makeParams(WORKFLOW_ID)
      );

      expect(response.status).toBe(403);
    });
  });

  describe('Successful update', () => {
    it('updates workflow and returns 200', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);
      vi.mocked(prisma.aiWorkflow.update).mockResolvedValue(
        makeWorkflow({ name: 'Updated' }) as never
      );

      const response = await PATCH(
        makeRequest('PATCH', { name: 'Updated' }),
        makeParams(WORKFLOW_ID)
      );

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean }>(response);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
    });

    it('excludes the always-bumping updatedAt/createdAt from the audit diff (#396)', async () => {
      // `updatedAt` bumps on every Prisma `update()`, so the route must filter
      // it (and createdAt) out of the audit diff — otherwise every PATCH records
      // a spurious timestamp change. computeChanges' ignoreKeys behaviour is
      // unit-tested for real in admin-audit-logger.test.ts.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);
      vi.mocked(prisma.aiWorkflow.update).mockResolvedValue(
        makeWorkflow({ name: 'Updated' }) as never
      );

      await PATCH(makeRequest('PATCH', { name: 'Updated' }), makeParams(WORKFLOW_ID));

      expect(vi.mocked(computeChanges).mock.calls.at(-1)?.[2]).toEqual({
        ignoreKeys: [
          'updatedAt',
          'createdAt',
          'publishedVersion',
          'draftDefinition',
          'definitionVersion',
        ],
      });
    });

    it('updates all optional fields in a single payload', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);
      vi.mocked(prisma.aiWorkflow.update).mockResolvedValue(makeWorkflow() as never);

      const fullPayload = {
        name: 'New Name',
        slug: 'new-slug',
        description: 'New description',
        workflowDefinition: VALID_DEFINITION,
        patternsUsed: [1, 2, 3],
        isActive: false,
        isTemplate: true,
        metadata: { owner: 'platform' },
      };

      await PATCH(makeRequest('PATCH', fullPayload), makeParams(WORKFLOW_ID));

      const updateCall = vi.mocked(prisma.aiWorkflow.update).mock.calls[0][0];
      expect(updateCall.data).toMatchObject({
        name: 'New Name',
        slug: 'new-slug',
        description: 'New description',
        patternsUsed: [1, 2, 3],
        isActive: false,
        isTemplate: true,
        metadata: { owner: 'platform' },
      });
    });

    it('accepts a new draftDefinition with valid schema (writes to draft, not published)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);
      const updatedDef = {
        steps: [{ id: 'step-a', name: 'Step A', type: 'llm_call', config: {}, nextSteps: [] }],
        entryStepId: 'step-a',
        errorStrategy: 'retry',
      };
      vi.mocked(prisma.aiWorkflow.update).mockResolvedValue(
        makeWorkflow({ draftDefinition: updatedDef }) as never
      );
      // The version check reads under the lock first; the route then
      // refetches with the published-version include before responding.
      vi.mocked(prisma.aiWorkflow.findUniqueOrThrow)
        .mockResolvedValueOnce(makeWorkflow() as never)
        .mockResolvedValueOnce(makeWorkflow({ draftDefinition: updatedDef }) as never);

      const response = await PATCH(
        makeRequest('PATCH', { draftDefinition: updatedDef }, LOADED()),
        makeParams(WORKFLOW_ID)
      );

      expect(response.status).toBe(200);
    });

    it('saves an erased address typed into a freshly loaded builder: a deliberate re-add (§122 t-900)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);
      vi.mocked(prisma.aiWorkflow.findUniqueOrThrow).mockResolvedValue(makeWorkflow() as never);
      vi.mocked(prisma.aiWorkflow.update).mockResolvedValue(makeWorkflow() as never);
      vi.mocked(prisma.dataErasureReceipt.findMany).mockResolvedValue([
        {
          subjectUserId: 'cmerasedperson0000000000',
          subjectEmailHash: createHash('sha256').update('gone@example.com').digest('hex'),
          metadata: { addressVerified: true },
        },
      ] as never);
      const draftNamingErasedAddress = {
        steps: [
          {
            id: 'notify',
            name: 'Notify',
            type: 'send_notification',
            config: { channel: 'email', to: 'Gone@Example.com', subject: 'Hi', bodyTemplate: 'x' },
            nextSteps: [],
          },
        ],
        entryStepId: 'notify',
        errorStrategy: 'fail',
      };

      const response = await PATCH(
        makeRequest('PATCH', { draftDefinition: draftNamingErasedAddress }, LOADED()),
        makeParams(WORKFLOW_ID)
      );

      expect(response.status).toBe(200);
      expect(prisma.aiWorkflow.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { draftDefinition: draftNamingErasedAddress } })
      );
    });

    it('saves a draft naming an erased approver id with the id stripped (review round 2)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);
      vi.mocked(prisma.aiWorkflow.update).mockResolvedValue(makeWorkflow() as never);
      vi.mocked(prisma.aiWorkflow.findUniqueOrThrow).mockResolvedValue(makeWorkflow() as never);
      vi.mocked(prisma.dataErasureReceipt.findMany).mockResolvedValue([
        { subjectUserId: 'cmerasedapprover00000000', subjectEmailHash: null, metadata: null },
      ] as never);

      const response = await PATCH(
        makeRequest(
          'PATCH',
          {
            draftDefinition: {
              steps: [
                {
                  id: 'approve',
                  name: 'Approve',
                  type: 'human_approval',
                  config: { prompt: 'OK?', approverUserIds: ['cmerasedapprover00000000'] },
                  nextSteps: [],
                },
              ],
              entryStepId: 'approve',
              errorStrategy: 'fail',
            },
          },
          LOADED()
        ),
        makeParams(WORKFLOW_ID)
      );

      expect(response.status).toBe(200);
      expect(prisma.aiWorkflow.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            draftDefinition: expect.objectContaining({
              steps: [
                expect.objectContaining({
                  config: { prompt: 'OK?', approverUserIds: [] },
                }),
              ],
            }),
          },
        })
      );
    });
  });

  describe('Error cases', () => {
    it('returns 404 when workflow not found', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(null);

      const response = await PATCH(makeRequest('PATCH', { name: 'x' }), makeParams(WORKFLOW_ID));

      expect(response.status).toBe(404);
    });

    it('returns 400 for invalid CUID param', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await PATCH(makeRequest('PATCH', { name: 'x' }), makeParams(INVALID_ID));

      expect(response.status).toBe(400);
    });

    it('returns 409 for P2002 slug conflict on PATCH', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);
      const p2002 = uniqueViolationError({
        index: 'ai_workflow_slug_key',
        modelName: 'AiWorkflow',
      });
      vi.mocked(prisma.aiWorkflow.update).mockRejectedValue(p2002);

      const response = await PATCH(
        makeRequest('PATCH', { slug: 'existing-slug' }),
        makeParams(WORKFLOW_ID)
      );

      expect(response.status).toBe(409);
    });

    it('does not answer the slug message for a P2002 on another constraint (t-814)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);
      const p2002 = uniqueViolationError({
        index: 'ai_workflow_version_workflowId_version_key',
        modelName: 'AiWorkflowVersion',
      });
      vi.mocked(prisma.aiWorkflow.update).mockRejectedValue(p2002);

      const response = await PATCH(
        makeRequest('PATCH', { slug: 'existing-slug' }),
        makeParams(WORKFLOW_ID)
      );

      expect(response.status).toBe(400);
      const otherData = await parseJson<{
        error: { code: string; message: string; details?: unknown };
      }>(response);
      expect(otherData.error.code).toBe('VALIDATION_ERROR');
      expect(otherData.error.message).toBe('A record with that value already exists');
      expect(otherData.error.details).toBeUndefined();
    });

    it('returns 400 when updating draftDefinition with invalid schema', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);

      // Missing entryStepId — schema validation should reject
      const response = await PATCH(
        makeRequest('PATCH', {
          draftDefinition: { steps: [], errorStrategy: 'fail' },
        }),
        makeParams(WORKFLOW_ID)
      );

      expect(response.status).toBe(400);
    });

    it('returns 403 when deactivating a system workflow', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
        makeWorkflow({ isSystem: true }) as never
      );

      const response = await PATCH(
        makeRequest('PATCH', { isActive: false }),
        makeParams(WORKFLOW_ID)
      );

      expect(response.status).toBe(403);
    });

    it('returns 403 when changing template status on a system workflow', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
        makeWorkflow({ isSystem: true }) as never
      );

      const response = await PATCH(
        makeRequest('PATCH', { isTemplate: true }),
        makeParams(WORKFLOW_ID)
      );

      expect(response.status).toBe(403);
    });

    it('clears draftDefinition when null is passed', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);
      vi.mocked(prisma.aiWorkflow.update).mockResolvedValue(
        makeWorkflow({ draftDefinition: null }) as never
      );
      vi.mocked(prisma.aiWorkflow.findUniqueOrThrow)
        .mockResolvedValueOnce(makeWorkflow() as never)
        .mockResolvedValueOnce(makeWorkflow({ draftDefinition: null }) as never);

      const response = await PATCH(
        makeRequest('PATCH', { draftDefinition: null }, LOADED()),
        makeParams(WORKFLOW_ID)
      );

      expect(response.status).toBe(200);
      // The first update call clears the draft via Prisma.DbNull
      const firstUpdateCall = vi.mocked(prisma.aiWorkflow.update).mock.calls[0][0];
      expect(firstUpdateCall.data).toEqual({ draftDefinition: Prisma.DbNull });
    });

    it('rethrows non-P2002 errors (not converted to 409)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);
      vi.mocked(prisma.aiWorkflow.update).mockRejectedValue(new Error('unexpected db failure'));

      // Non-P2002 errors propagate to the route's error handler → 500,
      // not the 409 ConflictError that the P2002 catch arm would synthesise.
      const response = await PATCH(makeRequest('PATCH', { name: 'x' }), makeParams(WORKFLOW_ID));

      expect(response.status).toBe(500);
    });
  });
});

describe('DELETE /api/v1/admin/orchestration/workflows/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await DELETE(makeRequest('DELETE'), makeParams(WORKFLOW_ID));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await DELETE(makeRequest('DELETE'), makeParams(WORKFLOW_ID));

      expect(response.status).toBe(403);
    });
  });

  describe('Successful soft delete', () => {
    it('sets isActive to false and returns success', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);
      vi.mocked(prisma.aiWorkflow.update).mockResolvedValue(
        makeWorkflow({ isActive: false }) as never
      );

      const response = await DELETE(makeRequest('DELETE'), makeParams(WORKFLOW_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { id: string; isActive: boolean } }>(
        response
      );
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data.isActive).toBe(false);

      expect(vi.mocked(prisma.aiWorkflow.update)).toHaveBeenCalledWith(
        expect.objectContaining({ data: { isActive: false } })
      );
    });
  });

  describe('Error cases', () => {
    it('returns 404 when workflow not found', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(null);

      const response = await DELETE(makeRequest('DELETE'), makeParams(WORKFLOW_ID));

      expect(response.status).toBe(404);
    });

    it('returns 400 for invalid CUID param', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await DELETE(makeRequest('DELETE'), makeParams(INVALID_ID));

      expect(response.status).toBe(400);
    });

    it('returns 403 when deleting a system workflow', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
        makeWorkflow({ isSystem: true }) as never
      );

      const response = await DELETE(makeRequest('DELETE'), makeParams(WORKFLOW_ID));

      expect(response.status).toBe(403);
    });
  });
});
