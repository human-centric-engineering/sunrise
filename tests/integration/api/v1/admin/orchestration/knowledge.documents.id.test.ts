/**
 * Integration Test: Admin Orchestration — Single Knowledge Document (GET + DELETE)
 *
 * GET    /api/v1/admin/orchestration/knowledge/documents/:id
 * DELETE /api/v1/admin/orchestration/knowledge/documents/:id
 *
 * @see app/api/v1/admin/orchestration/knowledge/documents/[id]/route.ts
 *
 * Key security assertions:
 * - Admin auth required (401/403 otherwise)
 * - Rate limited on DELETE (adminLimiter)
 * - Bad CUID returns 400
 * - Missing document returns 404
 *
 * NOTE: Knowledge documents are NOT per-user scoped — the knowledge base
 * is a global admin asset. There is no ownership test by design.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, DELETE } from '@/app/api/v1/admin/orchestration/knowledge/documents/[id]/route';
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
    aiKnowledgeDocument: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/lib/orchestration/knowledge/document-manager', () => ({
  deleteDocument: vi.fn(),
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { deleteDocument } from '@/lib/orchestration/knowledge/document-manager';
import { adminLimiter } from '@/lib/security/rate-limit';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const DOC_ID = 'cmjbv4i3x00003wsloputgwul';
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const INVALID_ID = 'not-a-cuid';

function makeDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: DOC_ID,
    name: 'Agentic Design Patterns',
    fileName: 'patterns.md',
    fileHash: 'a'.repeat(64),
    sourceUrl: null,
    status: 'ready',
    uploadedBy: ADMIN_ID,
    sizeBytes: 2048,
    mimeType: 'text/markdown',
    metadata: null,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    _count: { chunks: 8 },
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(method = 'GET'): NextRequest {
  return {
    method,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    url: `http://localhost:3000/api/v1/admin/orchestration/knowledge/documents/${DOC_ID}`,
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/knowledge/documents/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await GET(makeRequest(), makeParams(DOC_ID));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await GET(makeRequest(), makeParams(DOC_ID));

      expect(response.status).toBe(403);
    });
  });

  describe('Successful retrieval', () => {
    it('returns 200 with document data and chunk count', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue(makeDocument() as never);

      const response = await GET(makeRequest(), makeParams(DOC_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: { document: { id: string; _count: { chunks: number } } };
      }>(response);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data.document.id).toBe(DOC_ID);
      expect(data.data.document._count.chunks).toBe(8);
    });
  });

  describe('Error cases', () => {
    it('returns 404 when document does not exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue(null);

      const response = await GET(makeRequest(), makeParams(DOC_ID));

      expect(response.status).toBe(404);
    });

    it('returns 400 when id is not a valid CUID', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await GET(makeRequest(), makeParams(INVALID_ID));

      expect(response.status).toBe(400);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.success).toBe(false);
    });
  });
});

describe('DELETE /api/v1/admin/orchestration/knowledge/documents/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await DELETE(makeRequest('DELETE'), makeParams(DOC_ID));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await DELETE(makeRequest('DELETE'), makeParams(DOC_ID));

      expect(response.status).toBe(403);
    });
  });

  describe('Successful deletion', () => {
    it('deletes document and returns 200 with deleted: true', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue(makeDocument() as never);
      vi.mocked(deleteDocument).mockResolvedValue(undefined);

      const response = await DELETE(makeRequest('DELETE'), makeParams(DOC_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { deleted: boolean } }>(response);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.data.deleted).toBe(true);
    });

    it('calls deleteDocument with the correct document id', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue(makeDocument() as never);
      vi.mocked(deleteDocument).mockResolvedValue(undefined);

      await DELETE(makeRequest('DELETE'), makeParams(DOC_ID));

      expect(vi.mocked(deleteDocument)).toHaveBeenCalledWith(DOC_ID);
    });
  });

  describe('Error cases', () => {
    it('returns 404 when document does not exist (findUnique returns null)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue(null);

      const response = await DELETE(makeRequest('DELETE'), makeParams(DOC_ID));

      expect(response.status).toBe(404);
    });

    it('returns 400 when id is not a valid CUID', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await DELETE(makeRequest('DELETE'), makeParams(INVALID_ID));

      expect(response.status).toBe(400);
    });
  });

  describe('Rate limiting', () => {
    it('calls adminLimiter.check on DELETE', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue(makeDocument() as never);
      vi.mocked(deleteDocument).mockResolvedValue(undefined);

      await DELETE(makeRequest('DELETE'), makeParams(DOC_ID));

      expect(vi.mocked(adminLimiter.check)).toHaveBeenCalledOnce();
    });
  });
});
