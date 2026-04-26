/**
 * Integration Test: Admin Orchestration — Retry Failed Knowledge Document
 *
 * POST /api/v1/admin/orchestration/knowledge/documents/:id/retry
 *
 * @see app/api/v1/admin/orchestration/knowledge/documents/[id]/retry/route.ts
 *
 * Key security assertions:
 * - Admin auth required (401/403 otherwise)
 * - Rate limited (adminLimiter)
 * - Bad CUID returns 400
 * - Missing document returns 404
 * - Document not in "failed" state returns 409 (ConflictError)
 * - 200 on success: resets to pending, calls rechunkDocument, returns document
 * - CRITICAL: 500 responses do NOT leak raw error messages
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/knowledge/documents/[id]/retry/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

// ─── Mock dependencies ───────────────────────────────────────────────────────

vi.mock('@/lib/env', () => ({
  env: {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    BETTER_AUTH_SECRET: 'test-secret',
    BETTER_AUTH_URL: 'http://localhost:3000',
  },
}));

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
      update: vi.fn(),
    },
  },
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
}));

vi.mock('@/lib/orchestration/knowledge/document-manager', () => ({
  rechunkDocument: vi.fn(),
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    withContext: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    })),
  },
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { rechunkDocument } from '@/lib/orchestration/knowledge/document-manager';
import { adminLimiter } from '@/lib/security/rate-limit';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const DOC_ID = 'cmjbv4i3x00003wsloputgwu3';
const INVALID_ID = 'not-a-cuid';
const BASE_URL = `http://localhost:3000/api/v1/admin/orchestration/knowledge/documents/${DOC_ID}/retry`;

function makeDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: DOC_ID,
    name: 'Chunking Patterns Guide',
    fileName: 'patterns.md',
    fileHash: 'a'.repeat(64),
    status: 'failed',
    errorMessage: 'Chunking pipeline timed out',
    uploadedBy: 'cmjbv4i3x00003wsloputgwul',
    sizeBytes: 4096,
    mimeType: 'text/markdown',
    metadata: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(): NextRequest {
  return {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    url: BASE_URL,
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/knowledge/documents/:id/retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await POST(makeRequest(), makeParams(DOC_ID));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await POST(makeRequest(), makeParams(DOC_ID));

      expect(response.status).toBe(403);
    });
  });

  describe('Rate limiting', () => {
    it('returns 429 when rate limit is exceeded', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await POST(makeRequest(), makeParams(DOC_ID));

      expect(response.status).toBe(429);
    });
  });

  describe('Successful retry', () => {
    it('returns 200 with the reprocessed document', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue(
        makeDocument({ status: 'failed' }) as never
      );
      vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(
        makeDocument({ status: 'pending', errorMessage: null }) as never
      );
      const retried = makeDocument({ status: 'ready', errorMessage: null });
      vi.mocked(rechunkDocument).mockResolvedValue(retried as never);

      const response = await POST(makeRequest(), makeParams(DOC_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { document: { id: string } } }>(
        response
      );
      expect(data.success).toBe(true);
      expect(data.data.document.id).toBe(DOC_ID);
    });

    it('resets status to pending and clears errorMessage before rechunking', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue(
        makeDocument({ status: 'failed', errorMessage: 'previous error' }) as never
      );
      vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(
        makeDocument({ status: 'pending', errorMessage: null }) as never
      );
      vi.mocked(rechunkDocument).mockResolvedValue(makeDocument({ status: 'ready' }) as never);

      await POST(makeRequest(), makeParams(DOC_ID));

      expect(vi.mocked(prisma.aiKnowledgeDocument.update)).toHaveBeenCalledWith({
        where: { id: DOC_ID },
        data: { status: 'pending', errorMessage: null },
      });
    });

    it('calls rechunkDocument with the correct document id', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue(
        makeDocument({ status: 'failed' }) as never
      );
      vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(makeDocument() as never);
      vi.mocked(rechunkDocument).mockResolvedValue(makeDocument({ status: 'ready' }) as never);

      await POST(makeRequest(), makeParams(DOC_ID));

      expect(vi.mocked(rechunkDocument)).toHaveBeenCalledWith(DOC_ID);
    });
  });

  describe('Error cases', () => {
    it('returns 400 when id is not a valid CUID', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makeRequest(), makeParams(INVALID_ID));

      expect(response.status).toBe(400);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 404 when document does not exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue(null);

      const response = await POST(makeRequest(), makeParams(DOC_ID));

      expect(response.status).toBe(404);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.error.code).toBe('NOT_FOUND');
    });

    it('returns 409 when document status is not "failed" (status: pending)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue(
        makeDocument({ status: 'pending' }) as never
      );

      const response = await POST(makeRequest(), makeParams(DOC_ID));

      expect(response.status).toBe(409);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('CONFLICT');
    });

    it('returns 409 when document status is not "failed" (status: ready)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue(
        makeDocument({ status: 'ready' }) as never
      );

      const response = await POST(makeRequest(), makeParams(DOC_ID));

      expect(response.status).toBe(409);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.error.code).toBe('CONFLICT');
    });

    it('returns 409 when document status is not "failed" (status: processing)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue(
        makeDocument({ status: 'processing' }) as never
      );

      const response = await POST(makeRequest(), makeParams(DOC_ID));

      expect(response.status).toBe(409);
    });

    it('CRITICAL: returns 500 on plain Error but does NOT leak raw error message', async () => {
      const INTERNAL_MSG = 'rechunk-pipeline-exploded';
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue(
        makeDocument({ status: 'failed' }) as never
      );
      vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(makeDocument() as never);
      vi.mocked(rechunkDocument).mockRejectedValue(new Error(INTERNAL_MSG));

      const response = await POST(makeRequest(), makeParams(DOC_ID));

      expect(response.status).toBe(500);
      const raw = await response.text();
      expect(raw).not.toContain(INTERNAL_MSG);
    });
  });
});
