/**
 * Unit Tests: POST /api/v1/admin/orchestration/knowledge/documents/:id/cleanup/finalise
 *
 * Test Coverage:
 * - Invalid CUID in URL → 400 (ValidationError before any DB work)
 * - Invalid action enum → 400 (Zod failure)
 * - action: 'commit' → calls commitCleanupAndChunk, returns { document }
 * - action: 'use-original' → calls commitCleanupAndChunk with 'use-original'
 * - action: 'delete' → deletes conversation + document in a transaction when doc is owned + in cleaning
 * - action: 'delete' when doc not in cleaning or not owned → 400 (ValidationError)
 * - Each action logs an admin-audit entry with the right action code
 *
 * @see app/api/v1/admin/orchestration/knowledge/documents/[id]/cleanup/finalise/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Mocks (must be declared before imports) ────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/orchestration/knowledge/document-manager', () => ({
  commitCleanupAndChunk: vi.fn(),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiKnowledgeDocument: {
      findFirst: vi.fn(),
      delete: vi.fn(),
    },
    aiConversation: {
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
}));

vi.mock('@/lib/orchestration/knowledge/edit-lock', async () => {
  const actual = await vi.importActual<typeof import('@/lib/orchestration/knowledge/edit-lock')>(
    '@/lib/orchestration/knowledge/edit-lock'
  );
  return { ...actual, getEditLockState: vi.fn() };
});

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { POST } from '@/app/api/v1/admin/orchestration/knowledge/documents/[id]/cleanup/finalise/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { commitCleanupAndChunk } from '@/lib/orchestration/knowledge/document-manager';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { getEditLockState } from '@/lib/orchestration/knowledge/edit-lock';
import {
  mockAdminUser,
  mockUnauthenticatedUser,
  mockAuthenticatedUser,
} from '@/tests/helpers/auth';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * A valid CUID that passes cuidSchema validation.
 */
const VALID_DOC_ID = 'cma1b2c3d4e5f6g7h8i9j0k1l';

const ADMIN_USER_ID = 'cmjbv4i3x00003wsloputgwul';

function makeRequest(urlId: string, body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/knowledge/documents/${urlId}/cleanup/finalise`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}

function makeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeMockDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: VALID_DOC_ID,
    name: 'Cleaned Report',
    fileName: 'report.txt',
    status: 'ready',
    chunkCount: 5,
    uploadedBy: ADMIN_USER_ID,
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:01:00.000Z'),
    ...overrides,
  };
}

async function parseResponse<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T;
}

interface SuccessBody<T = unknown> {
  success: true;
  data: T;
}

interface ErrorBody {
  success: false;
  error: { code: string; message: string; details?: unknown };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/knowledge/documents/:id/cleanup/finalise', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    // Default: lock is free
    vi.mocked(getEditLockState).mockResolvedValue({
      heldBy: null,
      acquiredAt: null,
      active: false,
    });
    // Default: doc exists in cleaning status, owned by the admin
    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue({
      fileName: 'report.txt',
      name: 'Cleaned Report',
    } as never);
    // Default: transaction executes all ops (array-signature batch form).
    // Cast to never because Prisma's $transaction overloads don't overlap cleanly in test context.
    vi.mocked(prisma.$transaction).mockImplementation((async (ops: any[]) => {
      for (const op of ops) {
        await op;
      }
    }) as any);
    vi.mocked(commitCleanupAndChunk).mockResolvedValue(makeMockDocument() as never);
  });

  // ---------------------------------------------------------------------------
  // Validation — URL param
  // ---------------------------------------------------------------------------

  describe('URL validation', () => {
    it('returns 400 with VALIDATION_ERROR for an invalid CUID in the URL', async () => {
      // Arrange
      const invalidId = 'not-a-cuid';

      // Act
      const response = await POST(
        makeRequest(invalidId, { action: 'commit' }),
        makeContext(invalidId)
      );
      const data = await parseResponse<ErrorBody>(response);

      // Assert — validation fires before any DB work
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(commitCleanupAndChunk).not.toHaveBeenCalled();
      expect(prisma.aiKnowledgeDocument.findFirst).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Validation — body action enum
  // ---------------------------------------------------------------------------

  describe('Body validation', () => {
    it('returns 400 when action is not a valid enum value', async () => {
      // Arrange
      const invalidBody = { action: 'invalid-action' };

      // Act
      const response = await POST(
        makeRequest(VALID_DOC_ID, invalidBody),
        makeContext(VALID_DOC_ID)
      );
      const data = await parseResponse<ErrorBody>(response);

      // Assert — Zod schema rejects unknown enum value
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(commitCleanupAndChunk).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Lock check
  // ---------------------------------------------------------------------------

  describe('lock check', () => {
    it('returns 423 LOCK_HELD when another admin owns the lock, for every action', async () => {
      vi.mocked(getEditLockState).mockResolvedValue({
        heldBy: 'other-admin',
        acquiredAt: new Date(),
        active: true,
      });

      const response = await POST(
        makeRequest(VALID_DOC_ID, { action: 'commit' }),
        makeContext(VALID_DOC_ID)
      );
      const data = await parseResponse<ErrorBody>(response);

      expect(response.status).toBe(423);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('LOCK_HELD');
      expect(commitCleanupAndChunk).not.toHaveBeenCalled();
      expect(prisma.aiKnowledgeDocument.findFirst).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // action: 'commit'
  // ---------------------------------------------------------------------------

  describe("action: 'commit'", () => {
    it("calls commitCleanupAndChunk(id, userId, 'commit') and returns { document }", async () => {
      // Arrange
      const chunkedDoc = makeMockDocument({ chunkCount: 10 });
      vi.mocked(commitCleanupAndChunk).mockResolvedValue(chunkedDoc as never);

      // Act
      const response = await POST(
        makeRequest(VALID_DOC_ID, { action: 'commit' }),
        makeContext(VALID_DOC_ID)
      );
      const data =
        await parseResponse<SuccessBody<{ document: ReturnType<typeof makeMockDocument> }>>(
          response
        );

      // Assert — route calls the right helper with correct args and wraps in envelope
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.document.id).toBe(VALID_DOC_ID);
      expect(commitCleanupAndChunk).toHaveBeenCalledWith(VALID_DOC_ID, ADMIN_USER_ID, 'commit');
    });

    it("logs an admin-audit entry with action 'knowledge_document.cleanup_commit'", async () => {
      // Act
      await POST(makeRequest(VALID_DOC_ID, { action: 'commit' }), makeContext(VALID_DOC_ID));

      // Assert — audit entry uses the correct action code
      expect(logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'knowledge_document.cleanup_commit',
          entityType: 'knowledge_document',
          entityId: VALID_DOC_ID,
        })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // action: 'use-original'
  // ---------------------------------------------------------------------------

  describe("action: 'use-original'", () => {
    it("calls commitCleanupAndChunk(id, userId, 'use-original') and returns { document }", async () => {
      // Arrange
      const doc = makeMockDocument({ chunkCount: 8 });
      vi.mocked(commitCleanupAndChunk).mockResolvedValue(doc as never);

      // Act
      const response = await POST(
        makeRequest(VALID_DOC_ID, { action: 'use-original' }),
        makeContext(VALID_DOC_ID)
      );
      const data =
        await parseResponse<SuccessBody<{ document: ReturnType<typeof makeMockDocument> }>>(
          response
        );

      // Assert
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(commitCleanupAndChunk).toHaveBeenCalledWith(
        VALID_DOC_ID,
        ADMIN_USER_ID,
        'use-original'
      );
    });

    it("logs an admin-audit entry with action 'knowledge_document.cleanup_commit' for use-original", async () => {
      // Act
      await POST(makeRequest(VALID_DOC_ID, { action: 'use-original' }), makeContext(VALID_DOC_ID));

      // Assert — same action code for both commit modes (commit vs use-original)
      expect(logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'knowledge_document.cleanup_commit' })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // action: 'delete' — success path
  // ---------------------------------------------------------------------------

  describe("action: 'delete' — success", () => {
    it('deletes the conversation and document in a transaction and returns { deleted: true }', async () => {
      // Arrange — doc exists in cleaning status, owned by admin (default beforeEach setup)

      // Act
      const response = await POST(
        makeRequest(VALID_DOC_ID, { action: 'delete' }),
        makeContext(VALID_DOC_ID)
      );
      const data = await parseResponse<SuccessBody<{ deleted: boolean }>>(response);

      // Assert — both conversation and document were queued for deletion via $transaction
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.deleted).toBe(true);
      expect(prisma.$transaction).toHaveBeenCalledOnce();
      expect(prisma.aiConversation.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            contextType: 'knowledge_document',
            contextId: VALID_DOC_ID,
          }),
        })
      );
      expect(prisma.aiKnowledgeDocument.delete).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: VALID_DOC_ID } })
      );
    });

    it("logs an admin-audit entry with action 'knowledge_document.cleanup_delete'", async () => {
      // Act
      await POST(makeRequest(VALID_DOC_ID, { action: 'delete' }), makeContext(VALID_DOC_ID));

      // Assert
      expect(logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'knowledge_document.cleanup_delete',
          entityType: 'knowledge_document',
          entityId: VALID_DOC_ID,
        })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // action: 'delete' — guard failures
  // ---------------------------------------------------------------------------

  describe("action: 'delete' — guard failures", () => {
    it('returns 400 VALIDATION_ERROR when the doc is not in cleaning status or not owned by user', async () => {
      // Arrange — findFirst returns null (not found, wrong status, or wrong owner)
      vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(null);

      // Act
      const response = await POST(
        makeRequest(VALID_DOC_ID, { action: 'delete' }),
        makeContext(VALID_DOC_ID)
      );
      const data = await parseResponse<ErrorBody>(response);

      // Assert — guard blocks deletion; no transaction occurs
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  describe('Authentication', () => {
    it('returns 401 when the request is unauthenticated', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      // Act
      const response = await POST(
        makeRequest(VALID_DOC_ID, { action: 'commit' }),
        makeContext(VALID_DOC_ID)
      );
      const data = await parseResponse<ErrorBody>(response);

      // Assert
      expect(response.status).toBe(401);
      expect(data.error.code).toBe('UNAUTHORIZED');
    });

    it('returns 403 when the user is not an admin', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      // Act
      const response = await POST(
        makeRequest(VALID_DOC_ID, { action: 'commit' }),
        makeContext(VALID_DOC_ID)
      );
      const data = await parseResponse<ErrorBody>(response);

      // Assert
      expect(response.status).toBe(403);
      expect(data.error.code).toBe('FORBIDDEN');
    });
  });
});
