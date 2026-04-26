/**
 * Integration Test: Admin Orchestration — Rechunk Knowledge Document
 *
 * POST /api/v1/admin/orchestration/knowledge/documents/:id/rechunk
 *
 * @see app/api/v1/admin/orchestration/knowledge/documents/[id]/rechunk/route.ts
 *
 * Key security assertions:
 * - Admin auth required (401/403 otherwise)
 * - Rate limited (adminLimiter)
 * - Bad CUID returns 400
 * - Missing document returns 404
 * - Document with status=processing returns 409 (race condition guard)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/knowledge/documents/[id]/rechunk/route';
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
  rechunkDocument: vi.fn(),
}));

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

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { rechunkDocument } from '@/lib/orchestration/knowledge/document-manager';
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
    status: 'ready',
    uploadedBy: ADMIN_ID,
    sizeBytes: 2048,
    mimeType: 'text/markdown',
    metadata: null,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(): NextRequest {
  return {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    url: `http://localhost:3000/api/v1/admin/orchestration/knowledge/documents/${DOC_ID}/rechunk`,
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/knowledge/documents/:id/rechunk', () => {
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

  describe('Successful rechunking', () => {
    it('returns 200 with rechunked document when document is ready', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue(
        makeDocument({ status: 'ready' }) as never
      );
      const rechunked = makeDocument({ status: 'ready', updatedAt: new Date('2025-06-01') });
      vi.mocked(rechunkDocument).mockResolvedValue(rechunked as never);

      const response = await POST(makeRequest(), makeParams(DOC_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { document: { id: string } } }>(
        response
      );
      expect(data.success).toBe(true);
      expect(data.data.document.id).toBe(DOC_ID);
    });

    it('also accepts document with status=failed for rechunking', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue(
        makeDocument({ status: 'failed' }) as never
      );
      vi.mocked(rechunkDocument).mockResolvedValue(makeDocument() as never);

      const response = await POST(makeRequest(), makeParams(DOC_ID));

      expect(response.status).toBe(200);
    });

    it('calls rechunkDocument with the correct document id', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue(
        makeDocument({ status: 'ready' }) as never
      );
      vi.mocked(rechunkDocument).mockResolvedValue(makeDocument() as never);

      await POST(makeRequest(), makeParams(DOC_ID));

      expect(vi.mocked(rechunkDocument)).toHaveBeenCalledWith(DOC_ID);
    });
  });

  describe('Error cases', () => {
    it('returns 404 when document does not exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue(null);

      const response = await POST(makeRequest(), makeParams(DOC_ID));

      expect(response.status).toBe(404);
    });

    it('returns 409 when document status is processing (concurrent rechunk guard)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue(
        makeDocument({ status: 'processing' }) as never
      );

      const response = await POST(makeRequest(), makeParams(DOC_ID));

      expect(response.status).toBe(409);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.success).toBe(false);
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
      vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue(
        makeDocument({ status: 'ready' }) as never
      );
      vi.mocked(rechunkDocument).mockResolvedValue(makeDocument() as never);

      await POST(makeRequest(), makeParams(DOC_ID));

      expect(vi.mocked(adminLimiter.check)).toHaveBeenCalledOnce();
    });
  });
});
