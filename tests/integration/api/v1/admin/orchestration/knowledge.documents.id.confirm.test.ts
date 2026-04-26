/**
 * Integration Test: Admin Orchestration — Confirm Document Preview
 *
 * POST /api/v1/admin/orchestration/knowledge/documents/:id/confirm
 *
 * @see app/api/v1/admin/orchestration/knowledge/documents/[id]/confirm/route.ts
 *
 * Key security assertions:
 * - Admin auth required (401/403 otherwise)
 * - Invalid CUID returns 400
 * - Body validated with confirmDocumentPreviewSchema
 * - Document ID in body must match URL param
 * - Rate limited
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/knowledge/documents/[id]/confirm/route';
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

vi.mock('@/lib/orchestration/knowledge/document-manager', () => ({
  confirmPreview: vi.fn(),
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
import { confirmPreview } from '@/lib/orchestration/knowledge/document-manager';
import { adminLimiter } from '@/lib/security/rate-limit';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const DOC_ID = 'cmjbv4i3x00003wsloputgwul';
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwu2';
const INVALID_ID = 'not-a-cuid';

function makeConfirmedDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: DOC_ID,
    name: 'Uploaded PDF',
    fileName: 'guide.pdf',
    fileHash: 'a'.repeat(64),
    chunkCount: 12,
    status: 'ready',
    scope: 'app',
    category: null,
    sourceUrl: null,
    errorMessage: null,
    uploadedBy: ADMIN_ID,
    sizeBytes: 4096,
    mimeType: 'application/pdf',
    metadata: { format: '.pdf', corrected: false },
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(id: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/knowledge/documents/${id}/confirm`,
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

// ��── Tests ───────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/knowledge/documents/:id/confirm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await POST(makeRequest(DOC_ID, { documentId: DOC_ID }), makeParams(DOC_ID));
      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await POST(makeRequest(DOC_ID, { documentId: DOC_ID }), makeParams(DOC_ID));
      expect(response.status).toBe(403);
    });
  });

  describe('Successful confirmation', () => {
    it('returns 200 with confirmed document', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(confirmPreview).mockResolvedValue(makeConfirmedDoc() as never);

      const response = await POST(makeRequest(DOC_ID, { documentId: DOC_ID }), makeParams(DOC_ID));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.data.document.id).toBe(DOC_ID);
      expect(body.data.document.chunkCount).toBe(12);
    });

    it('passes correctedContent and category to confirmPreview', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(confirmPreview).mockResolvedValue(makeConfirmedDoc() as never);

      await POST(
        makeRequest(DOC_ID, {
          documentId: DOC_ID,
          correctedContent: 'Fixed text',
          category: 'sales',
        }),
        makeParams(DOC_ID)
      );

      expect(vi.mocked(confirmPreview)).toHaveBeenCalledWith(
        DOC_ID,
        expect.any(String),
        'Fixed text',
        'sales'
      );
    });
  });

  describe('Validation errors', () => {
    it('returns 400 when id is not a valid CUID', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(
        makeRequest(INVALID_ID, { documentId: INVALID_ID }),
        makeParams(INVALID_ID)
      );
      expect(response.status).toBe(400);
    });

    it('returns 400 when documentId in body does not match URL param', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const otherId = 'cmjbv4i3x00003wsloputgwu9';

      const response = await POST(makeRequest(DOC_ID, { documentId: otherId }), makeParams(DOC_ID));
      expect(response.status).toBe(400);
    });

    it('returns 400 when body is missing documentId', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makeRequest(DOC_ID, {}), makeParams(DOC_ID));
      expect(response.status).toBe(400);
    });
  });

  describe('Rate limiting', () => {
    it('returns 429 when rate limited', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({
        success: false,
        limit: 100,
        remaining: 0,
        reset: Date.now() + 60_000,
      });

      const response = await POST(makeRequest(DOC_ID, { documentId: DOC_ID }), makeParams(DOC_ID));
      expect(response.status).toBe(429);
    });
  });
});
