/**
 * Unit Tests: Knowledge Document List + Upload Endpoints
 *
 * GET  /api/v1/admin/orchestration/knowledge/documents
 * POST /api/v1/admin/orchestration/knowledge/documents
 *
 * Test Coverage:
 * - GET: pagination, status filter, scope filter, category filter, q filter
 * - GET: authentication, rate limiting (GET has no rate limit — only POST does)
 * - POST: text upload (md/txt), binary upload (epub/docx), PDF preview path
 * - POST: validation errors — no file, file too large, unsupported extension
 * - POST: line count and line length guards for text files
 * - POST: category field from form data
 * - POST: rate limiting and authentication
 *
 * @see app/api/v1/admin/orchestration/knowledge/documents/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiKnowledgeDocument: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
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

vi.mock('@/lib/orchestration/knowledge/document-manager', () => ({
  uploadDocument: vi.fn(),
  uploadDocumentFromBuffer: vi.fn(),
  previewDocument: vi.fn(),
}));

vi.mock('@/lib/orchestration/knowledge/parsers', () => ({
  requiresPreview: vi.fn(() => false),
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import { GET, POST } from '@/app/api/v1/admin/orchestration/knowledge/documents/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';
import {
  uploadDocument,
  uploadDocumentFromBuffer,
  previewDocument,
} from '@/lib/orchestration/knowledge/document-manager';
import { requiresPreview } from '@/lib/orchestration/knowledge/parsers';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';

// ─── Helpers ────────────────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';

function makeGetRequest(queryString = ''): NextRequest {
  return {
    method: 'GET',
    headers: new Headers(),
    url: `http://localhost:3000/api/v1/admin/orchestration/knowledge/documents${queryString}`,
  } as unknown as NextRequest;
}

/**
 * Creates a mock FormData with a synthetic File object.
 */
function makeFileRequest(
  fileName: string,
  content: string | ArrayBuffer,
  mimeType = 'text/plain',
  extraFields: Record<string, string> = {}
): NextRequest {
  const blobContent: BlobPart = typeof content === 'string' ? content : content;
  const file = new File([blobContent], fileName, { type: mimeType });
  const formData = new FormData();
  formData.set('file', file);
  for (const [key, value] of Object.entries(extraFields)) {
    formData.set(key, value);
  }

  return {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'multipart/form-data' }),
    url: 'http://localhost:3000/api/v1/admin/orchestration/knowledge/documents',
    formData: async () => formData,
  } as unknown as NextRequest;
}

function makeInvalidFormRequest(): NextRequest {
  return {
    method: 'POST',
    headers: new Headers(),
    url: 'http://localhost:3000/api/v1/admin/orchestration/knowledge/documents',
    formData: async () => {
      throw new Error('Invalid multipart body');
    },
  } as unknown as NextRequest;
}

const mockDocument = {
  id: 'doc-001',
  name: 'Test Doc',
  fileName: 'test.md',
  status: 'ready',
  scope: null,
  category: null,
  createdAt: new Date(),
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Knowledge Documents API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  // ── GET — List documents ────────────────────────────────────────────────

  describe('GET /knowledge/documents', () => {
    it('returns paginated documents', async () => {
      // Arrange
      vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([
        { ...mockDocument, _count: { chunks: 5 } },
      ] as never);
      vi.mocked(prisma.aiKnowledgeDocument.count).mockResolvedValue(1);

      // Act
      const res = await GET(makeGetRequest());
      const json = JSON.parse(await res.text());

      // Assert
      expect(res.status).toBe(200);
      expect(json.data).toHaveLength(1);
      expect(json.meta.total).toBe(1);
    });

    it('filters by status', async () => {
      // Arrange
      vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiKnowledgeDocument.count).mockResolvedValue(0);

      // Act
      await GET(makeGetRequest('?status=ready'));

      // Assert: where clause includes status
      expect(prisma.aiKnowledgeDocument.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'ready' }),
        })
      );
    });

    it('filters by scope', async () => {
      // Arrange
      vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiKnowledgeDocument.count).mockResolvedValue(0);

      // Act: 'app' is a valid scope value (enum: 'system' | 'app')
      await GET(makeGetRequest('?scope=app'));

      // Assert: where clause includes scope
      expect(prisma.aiKnowledgeDocument.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ scope: 'app' }),
        })
      );
    });

    it('filters by category', async () => {
      // Arrange
      vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiKnowledgeDocument.count).mockResolvedValue(0);

      // Act
      await GET(makeGetRequest('?category=product'));

      // Assert: where clause includes category
      expect(prisma.aiKnowledgeDocument.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ category: 'product' }),
        })
      );
    });

    it('applies text search (q param) using OR on name and fileName', async () => {
      // Arrange
      vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiKnowledgeDocument.count).mockResolvedValue(0);

      // Act
      await GET(makeGetRequest('?q=pricing'));

      // Assert: where clause includes OR search
      expect(prisma.aiKnowledgeDocument.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({ name: { contains: 'pricing', mode: 'insensitive' } }),
            ]),
          }),
        })
      );
    });

    it('applies pagination (page + limit)', async () => {
      // Arrange
      vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiKnowledgeDocument.count).mockResolvedValue(0);

      // Act
      await GET(makeGetRequest('?page=2&limit=5'));

      // Assert: skip = (2-1)*5 = 5
      expect(prisma.aiKnowledgeDocument.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 5, take: 5 })
      );
    });

    it('rejects unauthenticated requests', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      // Act
      const res = await GET(makeGetRequest());

      // Assert
      expect(res.status).toBe(401);
    });
  });

  // ── POST — Upload text document ─────────────────────────────────────────

  describe('POST /knowledge/documents — text files', () => {
    it('uploads a markdown document successfully', async () => {
      // Arrange
      vi.mocked(uploadDocument).mockResolvedValue({ ...mockDocument, id: 'doc-md-001' } as never);

      // Act
      const res = await POST(makeFileRequest('guide.md', '# Hello\nContent here', 'text/markdown'));
      const json = JSON.parse(await res.text());

      // Assert
      expect(res.status).toBe(201);
      expect(json.data.document.id).toBe('doc-md-001');
      expect(uploadDocument).toHaveBeenCalledOnce();
    });

    it('uploads a txt document successfully', async () => {
      // Arrange
      vi.mocked(uploadDocument).mockResolvedValue({ ...mockDocument, id: 'doc-txt-001' } as never);

      // Act
      const res = await POST(makeFileRequest('notes.txt', 'Plain text content', 'text/plain'));
      const json = JSON.parse(await res.text());

      // Assert
      expect(res.status).toBe(201);
      expect(json.data.document.id).toBe('doc-txt-001');
    });

    it('passes category to uploadDocument when category form field is provided', async () => {
      // Arrange
      vi.mocked(uploadDocument).mockResolvedValue({ ...mockDocument, category: 'faq' } as never);

      // Act
      await POST(makeFileRequest('faq.md', '# FAQ', 'text/markdown', { category: 'faq' }));

      // Assert: category passed to service
      expect(uploadDocument).toHaveBeenCalledWith(expect.any(String), 'faq.md', ADMIN_ID, 'faq');
    });

    it('uploads without category when category field is empty', async () => {
      // Arrange
      vi.mocked(uploadDocument).mockResolvedValue(mockDocument as never);

      // Act
      await POST(makeFileRequest('guide.md', '# Hello', 'text/markdown', { category: '  ' }));

      // Assert: category is undefined (whitespace trimmed to nothing)
      expect(uploadDocument).toHaveBeenCalledWith(
        expect.any(String),
        'guide.md',
        ADMIN_ID,
        undefined
      );
    });

    it('returns 413 FILE_TOO_LARGE when file exceeds the maximum size (post-parse)', async () => {
      // The pre-parse `Content-Length` guard catches well-formed clients;
      // this exercises the post-parse path (chunked encoding or a lying
      // header). Both paths must return the same code + status so
      // client error mapping is uniform.
      const largeContent = 'x'.repeat(50 * 1024 * 1024 + 1);
      const file = new File([largeContent], 'huge.txt', { type: 'text/plain' });
      const formData = new FormData();
      formData.set('file', file);

      const req: NextRequest = {
        method: 'POST',
        headers: new Headers(),
        url: 'http://localhost:3000/test',
        formData: async () => formData,
      } as unknown as NextRequest;

      const res = await POST(req);

      expect(res.status).toBe(413);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('FILE_TOO_LARGE');
      expect(uploadDocument).not.toHaveBeenCalled();
    });

    it('returns 400 INVALID_FILE_TYPE for unsupported file extension', async () => {
      const res = await POST(makeFileRequest('malware.exe', 'binary', 'application/octet-stream'));

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('INVALID_FILE_TYPE');
      expect(uploadDocument).not.toHaveBeenCalled();
    });

    it('returns 400 when the file field is missing', async () => {
      // Arrange: formData has no file
      const formData = new FormData();
      formData.set('category', 'test');
      const req: NextRequest = {
        method: 'POST',
        headers: new Headers(),
        url: 'http://localhost:3000/test',
        formData: async () => formData,
      } as unknown as NextRequest;

      // Act
      const res = await POST(req);

      // Assert
      expect(res.status).toBe(400);
    });

    it('returns 400 when the request body is not multipart/form-data', async () => {
      // Arrange: formData() throws
      const res = await POST(makeInvalidFormRequest());

      // Assert
      expect(res.status).toBe(400);
    });

    it('returns 400 when document has too many lines', async () => {
      // Arrange: 100,001 lines (exceeds MAX_LINE_COUNT of 100,000)
      const manyLines = Array(100_001).fill('line').join('\n');
      const res = await POST(makeFileRequest('big.md', manyLines));

      // Assert
      expect(res.status).toBe(400);
      expect(uploadDocument).not.toHaveBeenCalled();
    });

    it('returns 400 when document contains excessively long lines', async () => {
      // Arrange: one line that exceeds 10,000 chars
      const longLine = 'x'.repeat(10_001);
      const res = await POST(makeFileRequest('long-line.md', longLine));

      // Assert
      expect(res.status).toBe(400);
      expect(uploadDocument).not.toHaveBeenCalled();
    });
  });

  // ── POST — Upload binary document (EPUB, DOCX) ──────────────────────────

  describe('POST /knowledge/documents — binary files', () => {
    it('uploads an EPUB document via buffer path', async () => {
      // Arrange: requiresPreview returns false for EPUB
      vi.mocked(requiresPreview).mockReturnValue(false);
      vi.mocked(uploadDocumentFromBuffer).mockResolvedValue({
        ...mockDocument,
        id: 'doc-epub-001',
        fileName: 'book.epub',
      } as never);

      // Act
      const res = await POST(
        makeFileRequest('book.epub', new Uint8Array([0, 1, 2, 3]).buffer, 'application/epub+zip')
      );
      const json = JSON.parse(await res.text());

      // Assert
      expect(res.status).toBe(201);
      expect(json.data.document.id).toBe('doc-epub-001');
      expect(uploadDocumentFromBuffer).toHaveBeenCalledOnce();
    });

    it('creates a preview for PDF documents', async () => {
      // Arrange: requiresPreview returns true for PDF
      vi.mocked(requiresPreview).mockReturnValue(true);
      vi.mocked(previewDocument).mockResolvedValue({
        document: { ...mockDocument, id: 'doc-pdf-001', fileName: 'report.pdf' },
        extractedText: 'PDF content here',
        title: 'Annual Report',
        author: 'Acme Corp',
        sectionCount: 5,
        warnings: [],
      } as never);

      // Act
      const res = await POST(
        makeFileRequest('report.pdf', new Uint8Array([0, 1, 2, 3]).buffer, 'application/pdf')
      );
      const json = JSON.parse(await res.text());

      // Assert
      expect(res.status).toBe(201);
      expect(json.data.document.id).toBe('doc-pdf-001');
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(json.data.preview.requiresConfirmation).toBe(true);
      expect(json.data.preview.title).toBe('Annual Report');
      expect(previewDocument).toHaveBeenCalledOnce();
      expect(uploadDocumentFromBuffer).not.toHaveBeenCalled();
    });
  });

  // ── POST — Rate limiting and auth ────────────────────────────────────────

  describe('POST — auth and rate limiting', () => {
    it('rejects unauthenticated requests', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      // Act
      const res = await POST(makeFileRequest('test.md', '# Hello'));

      // Assert
      expect(res.status).toBe(401);
    });

    it('returns 429 when rate limited', async () => {
      // Arrange — fixed reset value avoids wall-clock coupling. The route
      // doesn't compare reset against `Date.now()` today, but a deterministic
      // value also keeps any future reset-driven assertions stable across CI
      // hosts where elapsed time would drift.
      vi.mocked(adminLimiter.check).mockReturnValue({
        success: false,
        limit: 10,
        remaining: 0,
        reset: 1_700_000_000 + 60,
      } as never);

      // Act
      const res = await POST(makeFileRequest('test.md', '# Hello'));

      // Assert
      expect(res.status).toBe(429);
      expect(uploadDocument).not.toHaveBeenCalled();
    });
  });
});
