/**
 * Integration Test: Admin Orchestration — Enrich Knowledge Document Keywords
 *
 * POST /api/v1/admin/orchestration/knowledge/documents/:id/enrich-keywords
 *
 * @see app/api/v1/admin/orchestration/knowledge/documents/[id]/enrich-keywords/route.ts
 *
 * Key security assertions:
 * - Admin auth required (401/403 otherwise)
 * - Rate limited (adminLimiter)
 * - Bad CUID returns 400
 * - Missing document returns 404
 * - Document with status=processing returns 409 (race condition guard)
 * - Document with chunkCount=0 returns 409
 * - Missing default chat model returns 503
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/knowledge/documents/[id]/enrich-keywords/route';
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
    aiKnowledgeDocument: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/lib/orchestration/knowledge/keyword-enricher', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/orchestration/knowledge/keyword-enricher')
  >('@/lib/orchestration/knowledge/keyword-enricher');
  return {
    ...actual,
    enrichDocumentKeywords: vi.fn(),
  };
});

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { enrichDocumentKeywords } from '@/lib/orchestration/knowledge/keyword-enricher';
import { NoDefaultModelConfiguredError } from '@/lib/orchestration/llm/settings-resolver';
import { adminLimiter } from '@/lib/security/rate-limit';

const DOC_ID = 'cmjbv4i3x00003wsloputgwul';
const INVALID_ID = 'not-a-cuid';

function makeDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: DOC_ID,
    name: 'Hybrid search guide',
    fileName: 'hybrid-search.md',
    fileHash: 'a'.repeat(64),
    status: 'ready',
    chunkCount: 4,
    uploadedBy: 'cmjbv4i3x00003wsloputgwul',
    sizeBytes: 2048,
    mimeType: 'text/markdown',
    metadata: null,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

function makeRequest(): NextRequest {
  return {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    url: `http://localhost:3000/api/v1/admin/orchestration/knowledge/documents/${DOC_ID}/enrich-keywords`,
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

describe('POST /api/v1/admin/orchestration/knowledge/documents/:id/enrich-keywords', () => {
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

  describe('Successful enrichment', () => {
    it('returns 200 and result payload when enrichment succeeds', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue(makeDocument() as never);
      vi.mocked(enrichDocumentKeywords).mockResolvedValue({
        chunksProcessed: 4,
        chunksSkipped: 0,
        chunksFailed: 0,
        tokensUsed: 480,
        costUsd: 0.0012,
        model: 'gpt-4o-mini',
      });

      const response = await POST(makeRequest(), makeParams(DOC_ID));
      expect(response.status).toBe(200);

      const data = await parseJson<{
        success: boolean;
        data: { chunksProcessed: number; costUsd: number; model: string };
      }>(response);
      expect(data.success).toBe(true);
      expect(data.data.chunksProcessed).toBe(4);
      expect(data.data.costUsd).toBeCloseTo(0.0012, 6);
      expect(data.data.model).toBe('gpt-4o-mini');
    });

    it('calls enrichDocumentKeywords with the document id', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue(makeDocument() as never);
      vi.mocked(enrichDocumentKeywords).mockResolvedValue({
        chunksProcessed: 1,
        chunksSkipped: 0,
        chunksFailed: 0,
        tokensUsed: 60,
        costUsd: 0,
        model: 'local',
      });

      await POST(makeRequest(), makeParams(DOC_ID));

      expect(vi.mocked(enrichDocumentKeywords)).toHaveBeenCalledWith(DOC_ID);
    });
  });

  describe('Error cases', () => {
    it('returns 404 when document does not exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue(null);

      const response = await POST(makeRequest(), makeParams(DOC_ID));
      expect(response.status).toBe(404);
    });

    it('returns 409 when document status is processing', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue(
        makeDocument({ status: 'processing' }) as never
      );

      const response = await POST(makeRequest(), makeParams(DOC_ID));
      expect(response.status).toBe(409);
    });

    it('returns 409 when document has no chunks', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue(
        makeDocument({ chunkCount: 0 }) as never
      );

      const response = await POST(makeRequest(), makeParams(DOC_ID));
      expect(response.status).toBe(409);
    });

    it('returns 503 when no default chat model is configured', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue(makeDocument() as never);
      vi.mocked(enrichDocumentKeywords).mockRejectedValue(
        new NoDefaultModelConfiguredError('chat')
      );

      const response = await POST(makeRequest(), makeParams(DOC_ID));
      expect(response.status).toBe(503);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('no_default_model');
    });

    it('returns 400 when id is not a valid CUID', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makeRequest(), makeParams(INVALID_ID));
      expect(response.status).toBe(400);
    });
  });

  describe('Rate limiting', () => {
    it('calls adminLimiter.check on POST', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue(makeDocument() as never);
      vi.mocked(enrichDocumentKeywords).mockResolvedValue({
        chunksProcessed: 1,
        chunksSkipped: 0,
        chunksFailed: 0,
        tokensUsed: 10,
        costUsd: 0,
        model: 'local',
      });

      await POST(makeRequest(), makeParams(DOC_ID));
      expect(vi.mocked(adminLimiter.check)).toHaveBeenCalledOnce();
    });
  });
});
