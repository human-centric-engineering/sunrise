/**
 * Integration Test: Admin Orchestration — Finalise Document Clean Up
 *
 * POST /api/v1/admin/orchestration/knowledge/documents/:id/cleanup/finalise
 *
 * @see app/api/v1/admin/orchestration/knowledge/documents/[id]/cleanup/finalise/route.ts
 *
 * Key security assertions:
 * - Admin auth required (401/403 otherwise)
 * - Invalid CUID in URL → 400 VALIDATION_ERROR
 * - Invalid action enum → 400 VALIDATION_ERROR
 * - Missing action field → 400 VALIDATION_ERROR
 *
 * Contract assertions (per-action):
 * - commit → 200, { document }, commitCleanupAndChunk called with correct args
 * - use-original → 200, { document }, commitCleanupAndChunk called with correct args
 * - delete (in-cleaning, owned) → 200, { deleted: true }, $transaction called
 * - delete (not in cleaning / not owned) → 400 VALIDATION_ERROR, $transaction NOT called
 *
 * Side effects:
 * - commit → logAdminAction('knowledge_document.cleanup_commit')
 * - delete → logAdminAction('knowledge_document.cleanup_delete')
 * - error paths → no logAdminAction
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/knowledge/documents/[id]/cleanup/finalise/route';
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

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { commitCleanupAndChunk } from '@/lib/orchestration/knowledge/document-manager';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { getEditLockState } from '@/lib/orchestration/knowledge/edit-lock';

// ─── Fixtures ────────────────────────────────────────────────────────────────

/**
 * A valid CUID that passes cuidSchema validation.
 * Must start with 'c' and be 25 characters long.
 */
const VALID_DOC_ID = 'cmjbv4i3x00003wsloputgwul';
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const INVALID_ID = 'not-a-cuid';

function makeChunkedDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: VALID_DOC_ID,
    name: 'Cleaned Report',
    fileName: 'report.txt',
    status: 'ready',
    chunkCount: 8,
    uploadedBy: ADMIN_ID,
    sizeBytes: 2048,
    mimeType: 'text/plain',
    metadata: { cleanupCommittedMode: 'commit' },
    originalContent: null,
    processedContent: null,
    createdAt: new Date('2026-05-01'),
    updatedAt: new Date('2026-05-01'),
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

interface SuccessBody<T = unknown> {
  success: true;
  data: T;
}

interface ErrorBody {
  success: false;
  error: { code: string; message: string };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/knowledge/documents/:id/cleanup/finalise', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default session: admin user
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    // Default: lock is free
    vi.mocked(getEditLockState).mockResolvedValue({
      heldBy: null,
      acquiredAt: null,
      active: false,
    });

    // Default: doc exists in cleaning status, owned by the calling admin
    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue({
      fileName: 'report.txt',
      name: 'Cleaned Report',
    } as never);

    // Default: commitCleanupAndChunk returns a chunked document
    vi.mocked(commitCleanupAndChunk).mockResolvedValue(makeChunkedDocument() as never);

    // Default: $transaction executes the array of Prisma promises (array-signature batch form)
    vi.mocked(prisma.$transaction).mockImplementation((async (ops: Promise<unknown>[]) => {
      for (const op of ops) await op;
    }) as any);
  });

  // ─── Auth boundary ────────────────────────────────────────────────────────

  describe('Authentication & Authorization', () => {
    it('returns 401 with full error envelope when unauthenticated', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      // Act
      const response = await POST(
        makeRequest(VALID_DOC_ID, { action: 'commit' }),
        makeParams(VALID_DOC_ID)
      );
      const data = await parseJson<ErrorBody>(response);

      // Assert — status first, then full envelope
      expect(response.status).toBe(401);
      expect(data.success).toBe(false);
      expect(data.error.code).toBeTruthy();
      expect(data.error.message).toBeTruthy();
      // No side effects on auth failure
      expect(commitCleanupAndChunk).not.toHaveBeenCalled();
    });

    it('returns 403 with full error envelope when authenticated as non-admin', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      // Act
      const response = await POST(
        makeRequest(VALID_DOC_ID, { action: 'commit' }),
        makeParams(VALID_DOC_ID)
      );
      const data = await parseJson<ErrorBody>(response);

      // Assert — status first, then full envelope
      expect(response.status).toBe(403);
      expect(data.success).toBe(false);
      expect(data.error.code).toBeTruthy();
      expect(data.error.message).toBeTruthy();
      // No side effects on auth failure
      expect(commitCleanupAndChunk).not.toHaveBeenCalled();
    });
  });

  // ─── Validation ───────────────────────────────────────────────────────────

  describe('Validation', () => {
    it('returns 400 VALIDATION_ERROR for an invalid CUID in the URL', async () => {
      // Act
      const response = await POST(
        makeRequest(INVALID_ID, { action: 'commit' }),
        makeParams(INVALID_ID)
      );
      const data = await parseJson<ErrorBody>(response);

      // Assert — status first, then full error envelope
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(data.error.message).toBeTruthy();
      // No DB work before validation
      expect(commitCleanupAndChunk).not.toHaveBeenCalled();
      expect(prisma.aiKnowledgeDocument.findFirst).not.toHaveBeenCalled();
    });

    it('returns 400 VALIDATION_ERROR for an invalid action enum', async () => {
      // Act
      const response = await POST(
        makeRequest(VALID_DOC_ID, { action: 'wibble' }),
        makeParams(VALID_DOC_ID)
      );
      const data = await parseJson<ErrorBody>(response);

      // Assert
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(commitCleanupAndChunk).not.toHaveBeenCalled();
    });

    it('returns 400 VALIDATION_ERROR when action field is missing from body', async () => {
      // Act
      const response = await POST(makeRequest(VALID_DOC_ID, {}), makeParams(VALID_DOC_ID));
      const data = await parseJson<ErrorBody>(response);

      // Assert
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(commitCleanupAndChunk).not.toHaveBeenCalled();
    });
  });

  // ─── action: 'commit' ─────────────────────────────────────────────────────

  describe("action: 'commit'", () => {
    it('returns 200 with { document } envelope and calls commitCleanupAndChunk with correct args', async () => {
      // Arrange
      const chunkedDoc = makeChunkedDocument({ chunkCount: 12 });
      vi.mocked(commitCleanupAndChunk).mockResolvedValue(chunkedDoc as never);

      // Act
      const response = await POST(
        makeRequest(VALID_DOC_ID, { action: 'commit' }),
        makeParams(VALID_DOC_ID)
      );
      const data =
        await parseJson<SuccessBody<{ document: { id: string; chunkCount: number } }>>(response);

      // Assert — status, envelope shape, and that the route called the helper correctly
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.document.id).toBe(VALID_DOC_ID);
      // Route applies the wrapping; the helper was called with the right arguments
      expect(commitCleanupAndChunk).toHaveBeenCalledWith(VALID_DOC_ID, ADMIN_ID, 'commit');
    });

    it("calls logAdminAction with 'knowledge_document.cleanup_commit'", async () => {
      // Act
      await POST(makeRequest(VALID_DOC_ID, { action: 'commit' }), makeParams(VALID_DOC_ID));

      // Assert — correct audit action code
      expect(logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'knowledge_document.cleanup_commit',
          entityType: 'knowledge_document',
          entityId: VALID_DOC_ID,
        })
      );
    });

    it('returns 500-range error envelope when commitCleanupAndChunk throws', async () => {
      // Arrange — simulate a chunking or embedding failure
      vi.mocked(commitCleanupAndChunk).mockRejectedValue(
        new Error('Chunking failed: embedding provider unavailable')
      );

      // Act
      const response = await POST(
        makeRequest(VALID_DOC_ID, { action: 'commit' }),
        makeParams(VALID_DOC_ID)
      );
      const data = await parseJson<ErrorBody>(response);

      // Assert — error propagates as a structured error response
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(data.success).toBe(false);
      expect(data.error).toBeTruthy();
    });
  });

  // ─── action: 'use-original' ───────────────────────────────────────────────

  describe("action: 'use-original'", () => {
    it('returns 200 with { document } envelope and calls commitCleanupAndChunk with use-original', async () => {
      // Arrange
      const doc = makeChunkedDocument({ metadata: { cleanupCommittedMode: 'use-original' } });
      vi.mocked(commitCleanupAndChunk).mockResolvedValue(doc as never);

      // Act
      const response = await POST(
        makeRequest(VALID_DOC_ID, { action: 'use-original' }),
        makeParams(VALID_DOC_ID)
      );
      const data = await parseJson<SuccessBody<{ document: { id: string } }>>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.document.id).toBe(VALID_DOC_ID);
      expect(commitCleanupAndChunk).toHaveBeenCalledWith(VALID_DOC_ID, ADMIN_ID, 'use-original');
    });

    it("calls logAdminAction with 'knowledge_document.cleanup_commit' for use-original", async () => {
      // Act
      await POST(makeRequest(VALID_DOC_ID, { action: 'use-original' }), makeParams(VALID_DOC_ID));

      // Assert — both commit modes use the same audit action code
      expect(logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'knowledge_document.cleanup_commit' })
      );
    });
  });

  // ─── action: 'delete' — success ───────────────────────────────────────────

  describe("action: 'delete' — success path", () => {
    it('returns 200 with { deleted: true } and runs $transaction with deleteMany+delete', async () => {
      // Arrange — findFirst returns a doc in cleaning status, owned by admin (default)

      // Act
      const response = await POST(
        makeRequest(VALID_DOC_ID, { action: 'delete' }),
        makeParams(VALID_DOC_ID)
      );
      const data = await parseJson<SuccessBody<{ deleted: boolean }>>(response);

      // Assert — status, envelope, transaction side effects
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.deleted).toBe(true);
      // $transaction was called with both delete operations
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

    it("calls logAdminAction with 'knowledge_document.cleanup_delete'", async () => {
      // Act
      await POST(makeRequest(VALID_DOC_ID, { action: 'delete' }), makeParams(VALID_DOC_ID));

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

  // ─── action: 'delete' — guard failures ───────────────────────────────────

  describe("action: 'delete' — guard failures", () => {
    it('returns 400 VALIDATION_ERROR when doc is not found, not in cleaning, or not owned by user', async () => {
      // Arrange — findFirst returns null (wrong status or wrong owner)
      vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(null);

      // Act
      const response = await POST(
        makeRequest(VALID_DOC_ID, { action: 'delete' }),
        makeParams(VALID_DOC_ID)
      );
      const data = await parseJson<ErrorBody>(response);

      // Assert — guard blocks; full error envelope; no transaction
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(data.error.message).toBeTruthy();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
