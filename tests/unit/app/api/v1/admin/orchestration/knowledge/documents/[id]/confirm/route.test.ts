// @vitest-environment happy-dom

/**
 * Unit Tests: POST /api/v1/admin/orchestration/knowledge/documents/:id/confirm
 *
 * Tests the confirm-preview endpoint that accepts a reviewed document
 * (uploaded as PDF) and proceeds with chunking + embedding.
 *
 * Test Coverage:
 * - Happy path: valid CUID + matching documentId → 200 with document
 * - Document ID in URL does not match body documentId → 400 VALIDATION_ERROR
 * - Invalid CUID in URL param → 400 VALIDATION_ERROR
 * - Rate limited request → 429 RATE_LIMIT_EXCEEDED
 * - Unauthenticated request → 401 UNAUTHORIZED
 * - Non-admin user → 403 FORBIDDEN
 * - confirmPreview propagates errors as 500 INTERNAL_ERROR
 *
 * Key Behaviors:
 * - withAdminAuth wraps the handler; auth is mocked via auth.api.getSession
 * - Rate limiting enforced by proxy.ts (orchestration tier)
 * - cuidSchema validates the URL :id param before confirmPreview is called
 * - body.documentId must equal the URL :id param
 * - confirmPreview receives (id, session.user.id, correctedContent, category)
 *
 * @see app/api/v1/admin/orchestration/knowledge/documents/[id]/confirm/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/knowledge/documents/[id]/confirm/route';
import {
  mockAdminUser,
  mockUnauthenticatedUser,
  mockAuthenticatedUser,
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
  confirmPreview: vi.fn(),
  transitionToCleanup: vi.fn(),
  parseDocumentMetadata: vi.fn(() => null),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiKnowledgeDocument: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import {
  confirmPreview,
  transitionToCleanup,
  parseDocumentMetadata,
} from '@/lib/orchestration/knowledge/document-manager';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * A valid CUID-style ID used across tests.
 * Must satisfy cuidSchema: starts with 'c', alphanumeric, 25 chars total.
 */
const VALID_DOC_ID = 'cma1b2c3d4e5f6g7h8i9j0k1l';

/**
 * Build a POST request to the confirm endpoint for a given document ID.
 */
function makeRequest(urlId: string, body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/knowledge/documents/${urlId}/confirm`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}

/**
 * Build the route context with a dynamic param promise (Next.js 16 pattern).
 */
function makeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

/**
 * A realistic mock document returned by confirmPreview.
 */
function makeMockDocument(id = VALID_DOC_ID) {
  return {
    id,
    name: 'Test PDF Document',
    status: 'ready',
    chunkCount: 12,
    uploadedBy: 'cmjbv4i3x00003wsloputgwul',
    createdAt: new Date('2026-04-01T00:00:00.000Z'),
    updatedAt: new Date('2026-04-01T00:01:00.000Z'),
  };
}

/**
 * Parse JSON from a Response.
 */
async function parseResponse<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T;
}

interface SuccessBody {
  success: true;
  data: { document: ReturnType<typeof makeMockDocument> };
}

interface ErrorBody {
  success: false;
  error: { code: string; message: string; details?: unknown };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/knowledge/documents/:id/confirm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(confirmPreview).mockResolvedValue(makeMockDocument() as never);
  });

  // ---------------------------------------------------------------------------
  // Happy path
  // ---------------------------------------------------------------------------

  describe('Happy path', () => {
    it('should return 200 with the confirmed document when the request is valid', async () => {
      const body = { documentId: VALID_DOC_ID };
      const request = makeRequest(VALID_DOC_ID, body);
      const context = makeContext(VALID_DOC_ID);

      const response = await POST(request, context);
      const data = await parseResponse<SuccessBody>(response);

      expect(response.status).toBe(200);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data.document.id).toBe(VALID_DOC_ID);
    });

    it('should call confirmPreview with (id, userId, correctedContent)', async () => {
      const admin = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(admin);

      const body = {
        documentId: VALID_DOC_ID,
        correctedContent: 'Corrected text here.',
      };

      const request = makeRequest(VALID_DOC_ID, body);
      const context = makeContext(VALID_DOC_ID);

      await POST(request, context);

      expect(confirmPreview).toHaveBeenCalledWith(
        VALID_DOC_ID,
        admin.user.id,
        'Corrected text here.'
      );
    });

    it('should call confirmPreview with undefined correctedContent when not supplied', async () => {
      const body = { documentId: VALID_DOC_ID };

      await POST(makeRequest(VALID_DOC_ID, body), makeContext(VALID_DOC_ID));

      expect(confirmPreview).toHaveBeenCalledWith(VALID_DOC_ID, expect.any(String), undefined);
    });
  });

  // ---------------------------------------------------------------------------
  // Document ID mismatch
  // ---------------------------------------------------------------------------

  describe('Document ID mismatch', () => {
    it('should return 400 when body.documentId does not match the URL :id', async () => {
      // Use a different valid CUID in the body
      const differentId = 'cmz9z9z9z9z9z9z9z9z9z9z9z';
      const body = { documentId: differentId };

      const response = await POST(makeRequest(VALID_DOC_ID, body), makeContext(VALID_DOC_ID));
      const data = await parseResponse<ErrorBody>(response);

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('should not call confirmPreview when IDs do not match', async () => {
      const differentId = 'cmz9z9z9z9z9z9z9z9z9z9z9z';
      const body = { documentId: differentId };

      await POST(makeRequest(VALID_DOC_ID, body), makeContext(VALID_DOC_ID));

      expect(confirmPreview).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Invalid CUID in URL
  // ---------------------------------------------------------------------------

  describe('Invalid URL param', () => {
    it('should return 400 when the :id param is not a valid CUID', async () => {
      const invalidId = 'not-a-cuid';
      const body = { documentId: invalidId };

      const response = await POST(makeRequest(invalidId, body), makeContext(invalidId));
      const data = await parseResponse<ErrorBody>(response);

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('should not call confirmPreview for an invalid :id param', async () => {
      const invalidId = 'not-a-cuid';
      const body = { documentId: invalidId };

      await POST(makeRequest(invalidId, body), makeContext(invalidId));

      expect(confirmPreview).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Rate limiting
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  describe('Authentication', () => {
    it('should return 401 when the request is unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const body = { documentId: VALID_DOC_ID };
      const response = await POST(makeRequest(VALID_DOC_ID, body), makeContext(VALID_DOC_ID));
      const data = await parseResponse<ErrorBody>(response);

      expect(response.status).toBe(401);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('UNAUTHORIZED');
    });

    it('should return 403 when the user is not an admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const body = { documentId: VALID_DOC_ID };
      const response = await POST(makeRequest(VALID_DOC_ID, body), makeContext(VALID_DOC_ID));
      const data = await parseResponse<ErrorBody>(response);

      expect(response.status).toBe(403);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('FORBIDDEN');
    });
  });

  // ---------------------------------------------------------------------------
  // confirmPreview errors
  // ---------------------------------------------------------------------------

  describe('confirmPreview errors', () => {
    it('should return 500 when confirmPreview throws an unexpected error', async () => {
      vi.mocked(confirmPreview).mockRejectedValue(new Error('Database connection lost'));

      const body = { documentId: VALID_DOC_ID };
      const response = await POST(makeRequest(VALID_DOC_ID, body), makeContext(VALID_DOC_ID));
      const data = await parseResponse<ErrorBody>(response);

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ---------------------------------------------------------------------------
  // runCleanup branches
  // ---------------------------------------------------------------------------

  describe('runCleanup branches', () => {
    it('calls transitionToCleanup and returns { document, redirectTo } when metadata.runCleanup is true', async () => {
      // Arrange — metadata indicates the upload was flagged for cleanup
      vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue({
        metadata: { runCleanup: true, extractedText: 'Extracted PDF text' },
        fileName: 'report.pdf',
      } as never);
      vi.mocked(parseDocumentMetadata).mockReturnValue({
        runCleanup: true,
        extractedText: 'Extracted PDF text',
      });
      const admin = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(admin);

      const cleanupDoc = { id: VALID_DOC_ID, fileName: 'report.pdf', chunkCount: 0 };
      const redirectTo = `/admin/orchestration/knowledge/${VALID_DOC_ID}/cleanup`;
      vi.mocked(transitionToCleanup).mockResolvedValue({
        document: cleanupDoc as never,
        conversationId: 'conv-123',
        redirectTo,
      });

      // Act — provide corrected content so it takes priority over extractedText
      const body = { documentId: VALID_DOC_ID, correctedContent: 'Corrected PDF text' };
      const response = await POST(makeRequest(VALID_DOC_ID, body), makeContext(VALID_DOC_ID));

      interface CleanupSuccessBody {
        success: true;
        data: { document: { id: string }; redirectTo: string };
      }
      const data = await parseResponse<CleanupSuccessBody>(response);

      // Assert — route branched into cleanup, returned redirectTo in envelope
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.document.id).toBe(VALID_DOC_ID);
      expect(data.data.redirectTo).toBe(redirectTo);
      expect(transitionToCleanup).toHaveBeenCalledWith(
        VALID_DOC_ID,
        'Corrected PDF text',
        admin.user.id
      );
      expect(confirmPreview).not.toHaveBeenCalled();
    });

    it('returns 400 when runCleanup is true but content is empty', async () => {
      // Arrange — no correctedContent and no extractedText in metadata
      vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue({
        metadata: { runCleanup: true },
        fileName: 'empty.pdf',
      } as never);
      vi.mocked(parseDocumentMetadata).mockReturnValue({ runCleanup: true });

      // Act — body has no correctedContent, and metadata has no extractedText fallback
      const body = { documentId: VALID_DOC_ID };
      const response = await POST(makeRequest(VALID_DOC_ID, body), makeContext(VALID_DOC_ID));
      const data = await parseResponse<ErrorBody>(response);

      // Assert — validation error; cleanup helper never reached
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(transitionToCleanup).not.toHaveBeenCalled();
    });

    it('calls confirmPreview (not transitionToCleanup) when runCleanup is NOT set and response has no redirectTo', async () => {
      // Arrange — no runCleanup flag in metadata
      vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue({
        metadata: {},
        fileName: 'report.pdf',
      } as never);
      vi.mocked(parseDocumentMetadata).mockReturnValue(null);
      vi.mocked(confirmPreview).mockResolvedValue(makeMockDocument() as never);

      // Act
      const body = { documentId: VALID_DOC_ID };
      const response = await POST(makeRequest(VALID_DOC_ID, body), makeContext(VALID_DOC_ID));
      const data = await parseResponse<SuccessBody>(response);

      // Assert — existing non-cleanup path; no redirectTo in response
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.document.id).toBe(VALID_DOC_ID);
      expect('redirectTo' in data.data).toBe(false);
      expect(confirmPreview).toHaveBeenCalledOnce();
      expect(transitionToCleanup).not.toHaveBeenCalled();
    });
  });
});
