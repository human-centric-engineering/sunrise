/**
 * Integration Test: Admin Orchestration — Fetch Document from URL
 *
 * POST /api/v1/admin/orchestration/knowledge/documents/fetch-url
 *
 * Key behaviours:
 * - Admin auth required (401/403)
 * - Rate limited
 * - Missing url → 400
 * - URL > 2000 chars → 400
 * - Successful text fetch → uploadDocument called, 201 returned
 * - fetchDocumentFromUrl throws → propagates error
 * - logAdminAction called with sourceUrl in details
 *
 * @see app/api/v1/admin/orchestration/knowledge/documents/fetch-url/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/knowledge/documents/fetch-url/route';
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

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
}));

vi.mock('@/lib/orchestration/knowledge/url-fetcher', () => ({
  fetchDocumentFromUrl: vi.fn(),
}));

vi.mock('@/lib/orchestration/knowledge/document-manager', () => ({
  uploadDocument: vi.fn(),
  uploadDocumentFromBuffer: vi.fn(),
}));

vi.mock('@/lib/orchestration/knowledge/parsers', () => ({
  requiresPreview: vi.fn((name: string) => name.toLowerCase().endsWith('.pdf')),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiKnowledgeDocumentTag: {
      createMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/orchestration/knowledge/resolveAgentDocumentAccess', () => ({
  invalidateAllAgentAccess: vi.fn(),
}));

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(() =>
    Promise.resolve({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
  ),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { adminLimiter } from '@/lib/security/rate-limit';
import { fetchDocumentFromUrl } from '@/lib/orchestration/knowledge/url-fetcher';
import {
  uploadDocument,
  uploadDocumentFromBuffer,
} from '@/lib/orchestration/knowledge/document-manager';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { prisma } from '@/lib/db/client';
import { invalidateAllAgentAccess } from '@/lib/orchestration/knowledge/resolveAgentDocumentAccess';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const VALID_URL = 'https://example.com/docs/guide.md';

function makeFetchedDocument(overrides: Record<string, unknown> = {}) {
  return {
    content: Buffer.from('# Guide\n\nHello world.'),
    fileName: 'guide.md',
    mimeType: 'text/markdown',
    ...overrides,
  };
}

function makeDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc-1',
    name: 'Guide',
    fileName: 'guide.md',
    status: 'ready',
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePostRequest(body: Record<string, unknown>): NextRequest {
  return {
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: 'http://localhost:3000/api/v1/admin/orchestration/knowledge/documents/fetch-url',
  } as unknown as NextRequest;
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/knowledge/documents/fetch-url', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
    vi.mocked(fetchDocumentFromUrl).mockResolvedValue(makeFetchedDocument() as never);
    vi.mocked(uploadDocument).mockResolvedValue(makeDocument() as never);
    vi.mocked(uploadDocumentFromBuffer).mockResolvedValue(makeDocument() as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await POST(makePostRequest({ url: VALID_URL }));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await POST(makePostRequest({ url: VALID_URL }));

      expect(response.status).toBe(403);
    });
  });

  describe('Rate limiting', () => {
    it('returns 429 when rate limit exceeded', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await POST(makePostRequest({ url: VALID_URL }));

      expect(response.status).toBe(429);
    });
  });

  describe('Validation errors', () => {
    it('returns 400 when url field is missing', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest({}));

      expect(response.status).toBe(400);
    });

    it('returns 400 when url is not a valid URL', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest({ url: 'not-a-url' }));

      expect(response.status).toBe(400);
    });

    it('returns 400 when url exceeds 2000 characters', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const longUrl = `https://example.com/${'a'.repeat(2000)}`;

      const response = await POST(makePostRequest({ url: longUrl }));

      expect(response.status).toBe(400);
    });
  });

  describe('Successful fetch', () => {
    it('returns 201 with document data', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest({ url: VALID_URL }));

      expect(response.status).toBe(201);
      const data = await parseJson<{ success: boolean; data: { id: string } }>(response);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data.id).toBe('doc-1');
    });

    it('calls fetchDocumentFromUrl with the provided URL', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      await POST(makePostRequest({ url: VALID_URL }));

      expect(vi.mocked(fetchDocumentFromUrl)).toHaveBeenCalledWith(VALID_URL);
    });

    it('calls uploadDocument for text files with content and sourceUrl', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      await POST(makePostRequest({ url: VALID_URL }));

      expect(vi.mocked(uploadDocument)).toHaveBeenCalledWith(
        expect.any(String),
        'guide.md',
        ADMIN_ID,
        undefined,
        VALID_URL
      );
    });

    it('calls logAdminAction with sourceUrl in metadata', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      await POST(makePostRequest({ url: VALID_URL }));

      expect(vi.mocked(logAdminAction)).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: ADMIN_ID,
          action: 'knowledge_document.create',
          metadata: expect.objectContaining({ sourceUrl: VALID_URL }),
        })
      );
    });
  });

  describe('PDF file (requiresPreview path)', () => {
    it('returns 422 with PREVIEW_REQUIRED for PDF files', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(fetchDocumentFromUrl).mockResolvedValue(
        makeFetchedDocument({ fileName: 'report.pdf', mimeType: 'application/pdf' }) as never
      );

      const response = await POST(makePostRequest({ url: VALID_URL }));
      const body = (await response.json()) as { success: boolean; error?: { code?: string } };

      expect(response.status).toBe(422);
      expect(body.success).toBe(false);
      expect(body.error?.code).toBe('PREVIEW_REQUIRED');
      expect(vi.mocked(uploadDocumentFromBuffer)).not.toHaveBeenCalled();
      expect(vi.mocked(uploadDocument)).not.toHaveBeenCalled();
    });
  });

  describe('Binary file (buffer path for non-text, non-PDF)', () => {
    it('calls uploadDocumentFromBuffer for .docx files', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(fetchDocumentFromUrl).mockResolvedValue(
        makeFetchedDocument({
          fileName: 'guide.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }) as never
      );
      vi.mocked(uploadDocumentFromBuffer).mockResolvedValue(makeDocument() as never);

      const response = await POST(makePostRequest({ url: VALID_URL }));

      expect(response.status).toBe(201);
      expect(vi.mocked(uploadDocumentFromBuffer)).toHaveBeenCalled();
      expect(vi.mocked(uploadDocument)).not.toHaveBeenCalled();
    });
  });

  describe('Category parameter', () => {
    it('passes category to uploadDocument when provided', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      await POST(makePostRequest({ url: VALID_URL, category: 'guides' }));

      expect(vi.mocked(uploadDocument)).toHaveBeenCalledWith(
        expect.any(String),
        'guide.md',
        ADMIN_ID,
        'guides',
        VALID_URL
      );
    });
  });

  describe('Error propagation', () => {
    it('returns 500 when fetchDocumentFromUrl throws an unexpected error', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(fetchDocumentFromUrl).mockRejectedValue(new Error('SSRF blocked'));

      // withAdminAuth catches unhandled errors and returns a 500 response
      const response = await POST(makePostRequest({ url: VALID_URL }));
      expect(response.status).toBe(500);
    });
  });

  describe('Tag application (tagIds param)', () => {
    const TAG_ID = 'cmjbv4i3x00003wsloputgwut';

    it('applies tag grants when tagIds are provided', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocumentTag.createMany).mockResolvedValue({ count: 1 } as never);

      const response = await POST(makePostRequest({ url: VALID_URL, tagIds: [TAG_ID] }));

      // Assert: tag join row was created
      expect(vi.mocked(prisma.aiKnowledgeDocumentTag.createMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [{ documentId: 'doc-1', tagId: TAG_ID }],
          skipDuplicates: true,
        })
      );
      expect(response.status).toBe(201);
    });

    it('invalidates agent access cache after tagging', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocumentTag.createMany).mockResolvedValue({ count: 1 } as never);

      await POST(makePostRequest({ url: VALID_URL, tagIds: [TAG_ID] }));

      // Resolver cache must be evicted so agents pick up new tag grants immediately
      expect(vi.mocked(invalidateAllAgentAccess)).toHaveBeenCalled();
    });

    it('does not apply tags when tagIds array is empty', async () => {
      // Arrange: no tagIds
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      await POST(makePostRequest({ url: VALID_URL }));

      // No tag join rows should be written
      expect(vi.mocked(prisma.aiKnowledgeDocumentTag.createMany)).not.toHaveBeenCalled();
      expect(vi.mocked(invalidateAllAgentAccess)).not.toHaveBeenCalled();
    });

    it('succeeds even when tag createMany throws (best-effort non-fatal)', async () => {
      // Arrange: tag write fails but the document upload already succeeded
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocumentTag.createMany).mockRejectedValue(
        new Error('FK violation')
      );

      const response = await POST(makePostRequest({ url: VALID_URL, tagIds: [TAG_ID] }));

      // Upload still returns 201 — tag failure is non-fatal
      expect(response.status).toBe(201);
    });

    it('includes tagsApplied count in logAdminAction metadata', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocumentTag.createMany).mockResolvedValue({ count: 2 } as never);

      await POST(
        makePostRequest({ url: VALID_URL, tagIds: [TAG_ID, 'cmjbv4i3x00003wsloputgwu2'] })
      );

      expect(vi.mocked(logAdminAction)).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ tagsApplied: 2 }),
        })
      );
    });
  });
});
