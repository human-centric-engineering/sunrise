/**
 * Unit Tests: Save Workflow as Template (POST)
 *
 * POST /api/v1/admin/orchestration/workflows/:id/save-as-template
 *
 * Test Coverage:
 * - Authentication: 401 unauthenticated, 403 non-admin
 * - Workflow ID validation: 400 for non-CUID
 * - Workflow lookup: 404 when workflow does not exist
 * - Slug uniqueness: loops until a unique slug is found
 * - P2002 slug race conflict: 400 ValidationError when create fails with P2002
 * - Happy path: 200 with success envelope containing template fields
 * - Body validation: 400 for invalid request body (empty name)
 *
 * @see app/api/v1/admin/orchestration/workflows/[id]/save-as-template/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Module mocks (must appear before imports) ──────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

// Shared transaction-internal mocks so tests can assert on the tx writes.
const txMocks = {
  workflowCreate: vi.fn(),
  workflowUpdate: vi.fn(),
  workflowFindUniqueOrThrow: vi.fn(),
  versionCreate: vi.fn(),
};

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflow: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    aiWorkflowVersion: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) =>
      cb({
        aiWorkflow: {
          create: txMocks.workflowCreate,
          update: txMocks.workflowUpdate,
          findUniqueOrThrow: txMocks.workflowFindUniqueOrThrow,
        },
        aiWorkflowVersion: { create: txMocks.versionCreate },
      })
    ),
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: {
    check: vi.fn(() => ({ success: true, limit: 100, remaining: 99, reset: 9999999999 })),
  },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn().mockResolvedValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
}));

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';
import {
  mockAdminUser,
  mockUnauthenticatedUser,
  mockAuthenticatedUser,
} from '@/tests/helpers/auth';
import { POST } from '@/app/api/v1/admin/orchestration/workflows/[id]/save-as-template/route';
import { Prisma } from '@prisma/client';

// ─── Fixtures ────────────────────────────────────────────────────────────────

// Valid CUID v2 (26 chars, starts with 'c')
const WORKFLOW_ID = 'cmjbv4i3x00003wsloputgwul';
const TEMPLATE_ID = 'cmjbv4i3x00005wsloputgwuz';

const VALID_DEFINITION = {
  steps: [
    {
      id: 'step-1',
      name: 'LLM Step',
      type: 'llm_call',
      config: { model: 'gpt-4o-mini', prompt: 'Hello' },
      nextSteps: [],
    },
  ],
  entryStepId: 'step-1',
  errorStrategy: 'fail',
};

function makeWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKFLOW_ID,
    name: 'My Workflow',
    slug: 'my-workflow',
    description: 'A test workflow',
    isActive: true,
    isTemplate: false,
    draftDefinition: null,
    publishedVersionId: 'wfv-1',
    publishedVersion: { id: 'wfv-1', version: 1, snapshot: VALID_DEFINITION },
    patternsUsed: [],
    templateSource: null,
    metadata: {},
    createdBy: 'admin-1',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

function makeTemplate(overrides: Record<string, unknown> = {}) {
  return {
    id: TEMPLATE_ID,
    name: 'My Workflow (Template)',
    slug: 'my-workflow-template',
    description: 'A test workflow',
    isActive: true,
    isTemplate: true,
    templateSource: 'custom',
    draftDefinition: null,
    publishedVersionId: 'wfv-tpl-1',
    patternsUsed: [],
    metadata: {},
    createdBy: 'cmjbv4i3x00003wsloputgwul',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

function makeRequest(
  workflowId: string = WORKFLOW_ID,
  body: Record<string, unknown> = {}
): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/workflows/${workflowId}/save-as-template`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}

function makeParams(id: string = WORKFLOW_ID) {
  return { params: Promise.resolve({ id }) };
}

interface SuccessBody {
  success: boolean;
  data: {
    id: string;
    name: string;
    slug: string;
    isTemplate: boolean;
    templateSource: string;
    createdAt: Date | string;
  };
}

interface ErrorBody {
  success: boolean;
  error: { code: string; message: string };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/workflows/:id/save-as-template', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Restore safe defaults — adminLimiter allows by default
    vi.mocked(adminLimiter.check).mockReturnValue({
      success: true,
      limit: 100,
      remaining: 99,
      reset: 9999999999,
    });

    // Default: slug is unique (findUnique for slug returns null)
    vi.mocked(prisma.aiWorkflow.findUnique).mockImplementation((async (args: unknown) => {
      const { where } = args as { where: { id?: string; slug?: string } };
      if (where.id === WORKFLOW_ID) return makeWorkflow();
      if (where.slug) return null; // slug is available
      return null;
    }) as never);

    // Default: transaction succeeds — clone is created + v1 seeded.
    txMocks.workflowCreate.mockResolvedValue({ id: TEMPLATE_ID });
    txMocks.versionCreate.mockResolvedValue({ id: 'wfv-tpl-1', version: 1 });
    txMocks.workflowFindUniqueOrThrow.mockResolvedValue(makeTemplate());
  });

  // ─── Rate limiting ──────────────────────────────────────────────────

  describe('rate limiting', () => {
    it('should return 429 when adminLimiter.check indicates the limit is exceeded', async () => {
      // Arrange: override the default (success=true) with a failed rate-limit check
      vi.mocked(adminLimiter.check).mockReturnValueOnce({
        success: false,
        limit: 10,
        remaining: 0,
        reset: Date.now() + 60000,
      });
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      // Act
      const response = await POST(makeRequest(), makeParams());
      const body = await parseJson<ErrorBody>(response);

      // Assert: createRateLimitResponse was called and returned a 429
      expect(response.status).toBe(429);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('RATE_LIMITED');
    });
  });

  // ─── Authentication ─────────────────────────────────────────────────

  describe('authentication', () => {
    it('should return 401 when request is unauthenticated', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      // Act
      const response = await POST(makeRequest(), makeParams());
      const body = await parseJson<ErrorBody>(response);

      // Assert
      expect(response.status).toBe(401);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('should return 403 when user is authenticated but not an admin', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      // Act
      const response = await POST(makeRequest(), makeParams());
      const body = await parseJson<ErrorBody>(response);

      // Assert
      expect(response.status).toBe(403);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('FORBIDDEN');
    });
  });

  // ─── Workflow ID validation ─────────────────────────────────────────

  describe('workflow ID validation', () => {
    it('should return 400 with ValidationError for an invalid (non-CUID) workflow ID', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const invalidId = 'not-a-cuid-at-all';

      // Act
      const response = await POST(makeRequest(invalidId), makeParams(invalidId));
      const body = await parseJson<ErrorBody>(response);

      // Assert
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  // ─── Workflow lookup ────────────────────────────────────────────────

  describe('workflow lookup', () => {
    it('should return 404 when the source workflow does not exist', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(null);

      // Act
      const response = await POST(makeRequest(), makeParams());
      const body = await parseJson<ErrorBody>(response);

      // Assert
      expect(response.status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('NOT_FOUND');
    });
  });

  // ─── Happy path ─────────────────────────────────────────────────────

  describe('happy path', () => {
    it('should return 200 success envelope with template fields when workflow exists', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      // Act
      const response = await POST(makeRequest(), makeParams());
      const body = await parseJson<SuccessBody>(response);

      // Assert — status and envelope shape
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);

      // Assert — handler-derived fields (not echoes of input)
      expect(body.data.id).toBe(TEMPLATE_ID);
      expect(body.data.isTemplate).toBe(true);
      expect(body.data.templateSource).toBe('custom');

      // Assert — the transactional create was called with the correct shape.
      // workflowDefinitionHistory is no longer a column — versions replace it.
      expect(txMocks.workflowCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            isTemplate: true,
            templateSource: 'custom',
          }),
        })
      );
      // The transaction also seeds v1 of the new template.
      expect(txMocks.versionCreate).toHaveBeenCalledOnce();
    });

    it('should use provided name and description overrides when supplied', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const overrideName = 'Custom Template Name';
      const overrideDescription = 'Custom description';

      // Act
      await POST(
        makeRequest(WORKFLOW_ID, { name: overrideName, description: overrideDescription }),
        makeParams()
      );

      // Assert — create was called with the overridden name/description
      expect(txMocks.workflowCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: overrideName,
            description: overrideDescription,
          }),
        })
      );
    });

    it('should fall back to "<source name> (Template)" when no name override is provided', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      // Act
      await POST(makeRequest(), makeParams());

      // Assert — name defaults to "<source name> (Template)"
      expect(txMocks.workflowCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: 'My Workflow (Template)',
          }),
        })
      );
    });
  });

  // ─── Slug conflict (P2002) ───────────────────────────────────────────

  describe('slug conflict handling', () => {
    it('should return 400 ValidationError when a P2002 slug race is detected on create', async () => {
      // Arrange — slug appears available but create throws P2002 (race condition)
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const p2002Error = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`slug`)',
        { code: 'P2002', clientVersion: '7.0.0', meta: { target: ['slug'] } }
      );
      txMocks.workflowCreate.mockRejectedValue(p2002Error);

      // Act
      const response = await POST(makeRequest(), makeParams());
      const body = await parseJson<ErrorBody>(response);

      // Assert — 400 with VALIDATION_ERROR, not 500
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should loop slug generation until a unique slug is found', async () => {
      // Arrange — first slug lookup returns an existing record (occupied),
      // second lookup returns null (available)
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      let slugCallCount = 0;
      vi.mocked(prisma.aiWorkflow.findUnique).mockImplementation((async (args: unknown) => {
        const { where } = args as { where: { id?: string; slug?: string } };
        if (where.id === WORKFLOW_ID) return makeWorkflow();
        if (where.slug) {
          slugCallCount++;
          // First slug attempt is occupied; second is free
          return slugCallCount === 1 ? { id: 'other-id' } : null;
        }
        return null;
      }) as never);

      // Act
      await POST(makeRequest(), makeParams());

      // Assert — create was called with the suffixed slug (e.g. "my-workflow-template-1")
      expect(txMocks.workflowCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            slug: 'my-workflow-template-1',
          }),
        })
      );
    });
  });

  // ─── Body validation ────────────────────────────────────────────────

  describe('body validation', () => {
    it('should return 400 ValidationError when name is an empty string', async () => {
      // Arrange — empty string fails z.string().min(1)
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      // Act
      const response = await POST(makeRequest(WORKFLOW_ID, { name: '' }), makeParams());
      const body = await parseJson<ErrorBody>(response);

      // Assert
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});
