/**
 * Integration Test: Admin Orchestration — Knowledge Documents (list + upload)
 *
 * GET  /api/v1/admin/orchestration/knowledge/documents
 * POST /api/v1/admin/orchestration/knowledge/documents
 *
 * @see app/api/v1/admin/orchestration/knowledge/documents/route.ts
 *
 * Key security assertions:
 * - Admin auth required (401/403 otherwise)
 * - Rate limited on POST (adminLimiter)
 * - File size limit enforced (50 MB; 413 FILE_TOO_LARGE)
 * - Extension whitelist enforced via `ALLOWED_EXTENSIONS` (400 INVALID_FILE_TYPE)
 * - Pre-parse Content-Length guard rejects oversize bodies before allocation
 * - Missing file field returns 400
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/v1/admin/orchestration/knowledge/documents/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

// ─── Mock dependencies ───────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
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
    // The list endpoint runs a tagged-template raw query to compute the
    // distinct BM25 keyword count per doc. Default to "no keywords yet"
    // so existing tests don't need to opt in.
    $queryRaw: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@/lib/orchestration/knowledge/document-manager', () => ({
  uploadDocument: vi.fn(),
  uploadDocumentFromBuffer: vi.fn(),
  previewDocument: vi.fn(),
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
import {
  previewDocument,
  uploadDocument,
  uploadDocumentFromBuffer,
} from '@/lib/orchestration/knowledge/document-manager';
import { adminLimiter } from '@/lib/security/rate-limit';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const DOC_ID = 'cmjbv4i3x00003wsloputgwul';
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';

function makeDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: DOC_ID,
    name: 'Agentic Design Patterns',
    fileName: 'patterns.md',
    fileHash: 'a'.repeat(64),
    sourceUrl: null,
    status: 'ready',
    uploadedBy: ADMIN_ID,
    sizeBytes: 1024,
    mimeType: 'text/markdown',
    metadata: null,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    _count: { chunks: 12 },
    // GET now returns inline tags joined through `AiKnowledgeDocumentTag`.
    // Tests pass `tags: [...]` via overrides when they want chip rendering.
    tags: [] as Array<{ tag: { id: string; slug: string; name: string } }>,
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGetRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/admin/orchestration/knowledge/documents');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

function makePostRequestWithFormData(formData: FormData): NextRequest {
  return {
    method: 'POST',
    headers: new Headers(),
    formData: () => Promise.resolve(formData),
    url: 'http://localhost:3000/api/v1/admin/orchestration/knowledge/documents',
  } as unknown as NextRequest;
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/knowledge/documents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(403);
    });
  });

  describe('Successful listing', () => {
    it('returns paginated documents list', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([makeDocument()] as never);
      vi.mocked(prisma.aiKnowledgeDocument.count).mockResolvedValue(1);

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: unknown[];
        meta: { page: number; limit: number; total: number; totalPages: number };
      }>(response);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data).toHaveLength(1);
      expect(data.meta).toMatchObject({
        page: expect.any(Number),
        limit: expect.any(Number),
        total: 1,
      });
    });

    it('passes status filter to Prisma WHERE clause', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiKnowledgeDocument.count).mockResolvedValue(0);

      await GET(makeGetRequest({ status: 'ready' }));

      expect(vi.mocked(prisma.aiKnowledgeDocument.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: 'ready' }) })
      );
    });

    it('passes text search q as OR filter to Prisma WHERE clause', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiKnowledgeDocument.count).mockResolvedValue(0);

      await GET(makeGetRequest({ q: 'patterns' }));

      expect(vi.mocked(prisma.aiKnowledgeDocument.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ OR: expect.any(Array) }),
        })
      );
    });
  });
});

describe('POST /api/v1/admin/orchestration/knowledge/documents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const formData = new FormData();
      formData.append('file', new File(['# Hello'], 'hello.md', { type: 'text/markdown' }));

      const response = await POST(makePostRequestWithFormData(formData));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
      const formData = new FormData();
      formData.append('file', new File(['# Hello'], 'hello.md', { type: 'text/markdown' }));

      const response = await POST(makePostRequestWithFormData(formData));

      expect(response.status).toBe(403);
    });
  });

  describe('Successful upload', () => {
    it('uploads markdown file and returns 201 with document', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const uploaded = makeDocument();
      vi.mocked(uploadDocument).mockResolvedValue(uploaded as never);

      const formData = new FormData();
      formData.append(
        'file',
        new File(['# Agentic Design Patterns\n\nContent here.'], 'patterns.md', {
          type: 'text/markdown',
        })
      );

      const response = await POST(makePostRequestWithFormData(formData));

      expect(response.status).toBe(201);
      const data = await parseJson<{ success: boolean; data: { document: { id: string } } }>(
        response
      );
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data.document.id).toBe(DOC_ID);
    });

    it('accepts .txt extension', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(uploadDocument).mockResolvedValue(makeDocument({ fileName: 'notes.txt' }) as never);

      const formData = new FormData();
      formData.append(
        'file',
        new File(['plain text content'], 'notes.txt', { type: 'text/plain' })
      );

      const response = await POST(makePostRequestWithFormData(formData));

      expect(response.status).toBe(201);
    });

    it('accepts .markdown extension', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(uploadDocument).mockResolvedValue(
        makeDocument({ fileName: 'guide.markdown' }) as never
      );

      const formData = new FormData();
      formData.append('file', new File(['# Guide'], 'guide.markdown', { type: 'text/markdown' }));

      const response = await POST(makePostRequestWithFormData(formData));

      expect(response.status).toBe(201);
    });

    it('passes file content, name, and userId to uploadDocument', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(uploadDocument).mockResolvedValue(makeDocument() as never);
      const content = '# Pattern\n\nSome content.';

      const formData = new FormData();
      formData.append('file', new File([content], 'patterns.md', { type: 'text/markdown' }));

      await POST(makePostRequestWithFormData(formData));

      // Signature: (content, fileName, userId, sourceUrl, displayName)
      expect(vi.mocked(uploadDocument)).toHaveBeenCalledWith(
        content,
        'patterns.md',
        ADMIN_ID,
        undefined,
        undefined
      );
    });

    it('routes .csv uploads through uploadDocumentFromBuffer', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(uploadDocumentFromBuffer).mockResolvedValue(
        makeDocument({ fileName: 'spending.csv' }) as never
      );

      const formData = new FormData();
      formData.append(
        'file',
        new File(['name,amount\nAcme,100\n'], 'spending.csv', { type: 'text/csv' })
      );

      const response = await POST(makePostRequestWithFormData(formData));

      expect(response.status).toBe(201);
      // Signature: (buffer, fileName, userId, sourceUrl, displayName)
      expect(vi.mocked(uploadDocumentFromBuffer)).toHaveBeenCalledWith(
        expect.any(Buffer),
        'spending.csv',
        ADMIN_ID,
        undefined,
        undefined
      );
      expect(vi.mocked(uploadDocument)).not.toHaveBeenCalled();
    });

    it('forwards extractTables=true to previewDocument when the form field is set on a PDF', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(previewDocument).mockResolvedValue({
        document: makeDocument({ fileName: 'tables.pdf', status: 'pending_review' }),
        extractedText: 'page 1',
        title: 'Tables',
        author: undefined,
        sectionCount: 1,
        warnings: [],
      } as never);

      const formData = new FormData();
      formData.append('file', new File(['fake-pdf'], 'tables.pdf', { type: 'application/pdf' }));
      formData.append('extractTables', 'true');

      await POST(makePostRequestWithFormData(formData));

      expect(vi.mocked(previewDocument)).toHaveBeenCalledWith(
        expect.any(Buffer),
        'tables.pdf',
        ADMIN_ID,
        { extractTables: true }
      );
    });

    it('defaults extractTables to false when the form field is omitted', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(previewDocument).mockResolvedValue({
        document: makeDocument({ fileName: 'plain.pdf', status: 'pending_review' }),
        extractedText: 'page 1',
        title: 'Plain',
        author: undefined,
        sectionCount: 1,
        warnings: [],
      } as never);

      const formData = new FormData();
      formData.append('file', new File(['fake-pdf'], 'plain.pdf', { type: 'application/pdf' }));

      await POST(makePostRequestWithFormData(formData));

      expect(vi.mocked(previewDocument)).toHaveBeenCalledWith(
        expect.any(Buffer),
        'plain.pdf',
        ADMIN_ID,
        { extractTables: false }
      );
    });
  });

  describe('Validation errors', () => {
    it('returns 400 when file field is missing from form data', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const formData = new FormData();
      // No file field appended

      const response = await POST(makePostRequestWithFormData(formData));

      expect(response.status).toBe(400);
    });

    // Size-limit coverage lives in the "Pre-parse body-size guard" describe
    // block below (Content-Length-driven 413) and the post-parse test "returns
    // 413 FILE_TOO_LARGE when file exceeds MAX_UPLOAD_BYTES (post-parse)".

    it('returns 400 INVALID_FILE_TYPE when file has unsupported extension (.exe)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const formData = new FormData();
      formData.append(
        'file',
        new File(['binary content'], 'malware.exe', { type: 'application/octet-stream' })
      );

      const response = await POST(makePostRequestWithFormData(formData));

      expect(response.status).toBe(400);
      const data = await parseJson<{ error: { code: string } }>(response);
      expect(data.error.code).toBe('INVALID_FILE_TYPE');
    });

    it('returns 400 INVALID_FILE_TYPE when file has unsupported extension (.xls)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const formData = new FormData();
      formData.append(
        'file',
        new File(['data'], 'report.xls', { type: 'application/vnd.ms-excel' })
      );

      const response = await POST(makePostRequestWithFormData(formData));

      expect(response.status).toBe(400);
      const data = await parseJson<{ error: { code: string } }>(response);
      expect(data.error.code).toBe('INVALID_FILE_TYPE');
    });

    it('returns 413 FILE_TOO_LARGE when file exceeds MAX_UPLOAD_BYTES (post-parse)', async () => {
      // The pre-parse `Content-Length` guard catches well-formed clients;
      // this test covers the post-parse path — a client that sends a
      // chunked body (no usable Content-Length) but turns out to be
      // oversize once parsed. The route must return the same code and
      // status as the pre-parse path so client error mapping is uniform.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const oversize = new File([new Uint8Array(51 * 1024 * 1024)], 'huge.md', {
        type: 'text/markdown',
      });
      const formData = new FormData();
      formData.append('file', oversize);

      const response = await POST(makePostRequestWithFormData(formData));

      expect(response.status).toBe(413);
      const data = await parseJson<{ error: { code: string } }>(response);
      expect(data.error.code).toBe('FILE_TOO_LARGE');
    });
  });

  describe('Rate limiting', () => {
    it('calls adminLimiter.check on POST', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(uploadDocument).mockResolvedValue(makeDocument() as never);
      const formData = new FormData();
      formData.append('file', new File(['# Hello'], 'hello.md', { type: 'text/markdown' }));

      await POST(makePostRequestWithFormData(formData));

      expect(vi.mocked(adminLimiter.check)).toHaveBeenCalledOnce();
    });

    it('returns 429 when adminLimiter rejects the POST', async () => {
      // Verifies the 429 response shape end-to-end. The unit-level test
      // covers the same case (route.test.ts) — this integration variant
      // pins the contract through the wider auth + handler wiring.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);
      const formData = new FormData();
      formData.append('file', new File(['# Hello'], 'hello.md', { type: 'text/markdown' }));

      const response = await POST(makePostRequestWithFormData(formData));

      expect(response.status).toBe(429);
    });
  });

  describe('Pre-parse body-size guard', () => {
    function makePostRequestWithContentLength(
      contentLength: string | null,
      formDataSpy?: () => Promise<FormData>
    ): NextRequest {
      const headers = new Headers();
      if (contentLength !== null) headers.set('content-length', contentLength);
      const fd = new FormData();
      fd.append('file', new File(['# Hello'], 'hello.md', { type: 'text/markdown' }));
      return {
        method: 'POST',
        headers,
        formData: formDataSpy ?? (() => Promise.resolve(fd)),
        url: 'http://localhost:3000/api/v1/admin/orchestration/knowledge/documents',
      } as unknown as NextRequest;
    }

    beforeEach(() => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    });

    it('returns 413 FILE_TOO_LARGE when Content-Length declares an oversized body', async () => {
      // 1 GB body — what an attacker would set in a heap-exhaustion attempt.
      const response = await POST(makePostRequestWithContentLength('1073741824'));

      expect(response.status).toBe(413);
      const body = await parseJson<{ error: { code: string } }>(response);
      expect(body.error.code).toBe('FILE_TOO_LARGE');
    });

    it('does NOT call request.formData() when the guard rejects (heap protection)', async () => {
      const formDataSpy = vi.fn(() => Promise.resolve(new FormData()));

      await POST(makePostRequestWithContentLength('1073741824', formDataSpy));

      expect(formDataSpy).not.toHaveBeenCalled();
    });

    it('passes through when Content-Length is absent (chunked encoding fallback)', async () => {
      vi.mocked(uploadDocument).mockResolvedValue(makeDocument() as never);

      const response = await POST(makePostRequestWithContentLength(null));

      // Falls through to the post-parse path; the file in the helper's
      // default FormData passes the post-parse size check. Successful
      // upload returns 201, not 200.
      expect(response.status).toBe(201);
    });

    it('passes through when Content-Length is non-numeric', async () => {
      vi.mocked(uploadDocument).mockResolvedValue(makeDocument() as never);

      const response = await POST(makePostRequestWithContentLength('abc'));

      expect(response.status).toBe(201);
    });

    it('still consumes the rate limit budget on oversized rejections', async () => {
      // Auth + rate-limit run before the body cap so an authenticated
      // attacker still pays for their oversize attempts.
      await POST(makePostRequestWithContentLength('1073741824'));

      expect(adminLimiter.check).toHaveBeenCalled();
    });
  });
});
