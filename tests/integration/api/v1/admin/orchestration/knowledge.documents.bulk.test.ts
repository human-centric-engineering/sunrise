/**
 * Integration Test: Admin Orchestration — Bulk Document Upload
 *
 * POST /api/v1/admin/orchestration/knowledge/documents/bulk
 *
 * Key behaviours:
 * - Admin auth required (401/403)
 * - Rate limited
 * - No files → 400
 * - > 10 files → 400
 * - File too large (> 50 MB) → per-file error in results
 * - Unsupported extension → per-file error
 * - PDF file → per-file status "skipped_pdf"
 * - Valid .md file → uploadDocument called, result has documentId
 * - Mixed batch → granular results, 201
 * - logAdminAction called only when successCount > 0
 *
 * @see app/api/v1/admin/orchestration/knowledge/documents/bulk/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/knowledge/documents/bulk/route';
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

vi.mock('@/lib/orchestration/knowledge/document-manager', () => ({
  uploadDocument: vi.fn(),
  uploadDocumentFromBuffer: vi.fn(),
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

vi.mock('@/lib/orchestration/knowledge/parsers', () => ({
  requiresPreview: vi.fn((name: string) => name.toLowerCase().endsWith('.pdf')),
}));

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(() =>
    Promise.resolve({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
  ),
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { adminLimiter } from '@/lib/security/rate-limit';
import {
  uploadDocument,
  uploadDocumentFromBuffer,
} from '@/lib/orchestration/knowledge/document-manager';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { prisma } from '@/lib/db/client';
import { invalidateAllAgentAccess } from '@/lib/orchestration/knowledge/resolveAgentDocumentAccess';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';

function makeDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc-1',
    name: 'Test Doc',
    fileName: 'test.md',
    status: 'ready',
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePostRequest(formData: FormData): NextRequest {
  return {
    method: 'POST',
    headers: new Headers(),
    formData: () => Promise.resolve(formData),
    url: 'http://localhost:3000/api/v1/admin/orchestration/knowledge/documents/bulk',
  } as unknown as NextRequest;
}

function makeFormDataWithFiles(files: File[]): FormData {
  const fd = new FormData();
  files.forEach((f) => fd.append('files', f));
  return fd;
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/knowledge/documents/bulk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
    vi.mocked(uploadDocument).mockResolvedValue(makeDocument() as never);
    vi.mocked(uploadDocumentFromBuffer).mockResolvedValue(makeDocument() as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const fd = makeFormDataWithFiles([
        new File(['content'], 'doc.md', { type: 'text/markdown' }),
      ]);

      const response = await POST(makePostRequest(fd));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
      const fd = makeFormDataWithFiles([
        new File(['content'], 'doc.md', { type: 'text/markdown' }),
      ]);

      const response = await POST(makePostRequest(fd));

      expect(response.status).toBe(403);
    });
  });

  describe('Rate limiting', () => {
    it('returns 429 when rate limit exceeded', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);
      const fd = makeFormDataWithFiles([
        new File(['content'], 'doc.md', { type: 'text/markdown' }),
      ]);

      const response = await POST(makePostRequest(fd));

      expect(response.status).toBe(429);
    });
  });

  describe('Batch validation', () => {
    it('returns 400 when no files are provided', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const fd = new FormData(); // no files

      const response = await POST(makePostRequest(fd));

      expect(response.status).toBe(400);
    });

    it('returns 400 when more than 10 files are provided', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const files = Array.from({ length: 11 }, (_, i) => new File(['x'], `doc${i}.md`));
      const fd = makeFormDataWithFiles(files);

      const response = await POST(makePostRequest(fd));

      expect(response.status).toBe(400);
    });
  });

  describe('Per-file processing', () => {
    it('processes valid .md file and returns success result with documentId', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(uploadDocument).mockResolvedValue(makeDocument({ id: 'doc-42' }) as never);
      const fd = makeFormDataWithFiles([
        new File(['# Hello'], 'readme.md', { type: 'text/markdown' }),
      ]);

      const response = await POST(makePostRequest(fd));

      expect(response.status).toBe(201);
      const data = await parseJson<{
        data: { results: Array<{ status: string; documentId?: string }> };
      }>(response);
      expect(data.data.results[0].status).toBe('success');
      expect(data.data.results[0].documentId).toBe('doc-42');
    });

    it('returns per-file error for file exceeding 50 MB', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      // Create a file that reports itself as > 50MB (we override size via File constructor)
      const bigContent = new Uint8Array(51 * 1024 * 1024);
      const fd = makeFormDataWithFiles([
        new File([bigContent], 'big.md', { type: 'text/markdown' }),
      ]);

      const response = await POST(makePostRequest(fd));

      expect(response.status).toBe(201);
      const data = await parseJson<{
        data: { results: Array<{ status: string; error?: string }> };
      }>(response);
      expect(data.data.results[0].status).toBe('error');
      expect(data.data.results[0].error).toMatch(/too large/i);
    });

    it('returns per-file error for unsupported extension (.exe)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const fd = makeFormDataWithFiles([
        new File(['binary'], 'malware.exe', { type: 'application/octet-stream' }),
      ]);

      const response = await POST(makePostRequest(fd));

      expect(response.status).toBe(201);
      const data = await parseJson<{
        data: { results: Array<{ status: string; error?: string }> };
      }>(response);
      expect(data.data.results[0].status).toBe('error');
      expect(data.data.results[0].error).toMatch(/unsupported/i);
    });

    it('returns per-file status "skipped_pdf" for PDF files', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const fd = makeFormDataWithFiles([
        new File(['pdf content'], 'report.pdf', { type: 'application/pdf' }),
      ]);

      const response = await POST(makePostRequest(fd));

      expect(response.status).toBe(201);
      const data = await parseJson<{ data: { results: Array<{ status: string }> } }>(response);
      expect(data.data.results[0].status).toBe('skipped_pdf');
      expect(vi.mocked(uploadDocument)).not.toHaveBeenCalled();
    });
  });

  describe('Mixed batch', () => {
    it('returns granular results for mixed success, error, and PDF', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(uploadDocument).mockResolvedValue(makeDocument({ id: 'doc-ok' }) as never);

      const files = [
        new File(['# Good'], 'good.md', { type: 'text/markdown' }),
        new File(['binary'], 'bad.exe', { type: 'application/octet-stream' }),
        new File(['pdf'], 'report.pdf', { type: 'application/pdf' }),
      ];
      const fd = makeFormDataWithFiles(files);

      const response = await POST(makePostRequest(fd));

      expect(response.status).toBe(201);
      const data = await parseJson<{
        data: { results: Array<{ fileName: string; status: string }> };
      }>(response);
      expect(data.data.results).toHaveLength(3);

      const statuses = data.data.results.map((r) => r.status);
      expect(statuses).toContain('success');
      expect(statuses).toContain('error');
      expect(statuses).toContain('skipped_pdf');
    });

    it('calls logAdminAction when at least one file succeeds', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const fd = makeFormDataWithFiles([
        new File(['content'], 'doc.md', { type: 'text/markdown' }),
      ]);

      await POST(makePostRequest(fd));

      expect(vi.mocked(logAdminAction)).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: ADMIN_ID,
          action: 'knowledge_document.bulk_create',
          entityType: 'knowledge_document',
        })
      );
    });

    it('does NOT call logAdminAction when all files fail', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const fd = makeFormDataWithFiles([
        new File(['binary'], 'malware.exe', { type: 'application/octet-stream' }),
      ]);

      await POST(makePostRequest(fd));

      expect(vi.mocked(logAdminAction)).not.toHaveBeenCalled();
    });
  });

  describe('uploadDocument arguments', () => {
    it('passes content, fileName, and userId to uploadDocument', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const content = '# Test\n\nHello world.';
      const fd = makeFormDataWithFiles([
        new File([content], 'notes.md', { type: 'text/markdown' }),
      ]);

      await POST(makePostRequest(fd));

      expect(vi.mocked(uploadDocument)).toHaveBeenCalledWith(
        content,
        'notes.md',
        ADMIN_ID,
        undefined
      );
    });
  });

  describe('Text file line-count validation', () => {
    it('returns per-file error when file has too many lines (> 100,000)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const content = Array.from({ length: 100_001 }, (_, i) => `line ${i}`).join('\n');
      const fd = makeFormDataWithFiles([new File([content], 'big.md', { type: 'text/markdown' })]);

      const response = await POST(makePostRequest(fd));

      expect(response.status).toBe(201);
      const data = await parseJson<{
        data: { results: Array<{ status: string; error?: string }> };
      }>(response);
      expect(data.data.results[0].status).toBe('error');
      expect(data.data.results[0].error).toMatch(/too many lines/i);
    });

    it('returns per-file error when a line exceeds max length (> 10,000 chars)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const longLine = 'x'.repeat(10_001);
      const fd = makeFormDataWithFiles([
        new File([longLine], 'wide.md', { type: 'text/markdown' }),
      ]);

      const response = await POST(makePostRequest(fd));

      expect(response.status).toBe(201);
      const data = await parseJson<{
        data: { results: Array<{ status: string; error?: string }> };
      }>(response);
      expect(data.data.results[0].status).toBe('error');
      expect(data.data.results[0].error).toMatch(/max length/i);
    });
  });

  describe('Binary file (DOCX/EPUB buffer path)', () => {
    it('calls uploadDocumentFromBuffer for .docx files', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(uploadDocumentFromBuffer).mockResolvedValue(
        makeDocument({ id: 'doc-docx' }) as never
      );
      const fd = makeFormDataWithFiles([
        new File(['docx bytes'], 'guide.docx', {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }),
      ]);

      const response = await POST(makePostRequest(fd));

      expect(response.status).toBe(201);
      const data = await parseJson<{
        data: { results: Array<{ status: string; documentId?: string }> };
      }>(response);
      expect(data.data.results[0].status).toBe('success');
      expect(vi.mocked(uploadDocumentFromBuffer)).toHaveBeenCalled();
      expect(vi.mocked(uploadDocument)).not.toHaveBeenCalled();
    });

    it('calls uploadDocumentFromBuffer for .csv files', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(uploadDocumentFromBuffer).mockResolvedValue(
        makeDocument({ id: 'doc-csv', fileName: 'spending.csv' }) as never
      );
      const fd = makeFormDataWithFiles([
        new File(['name,amount\nAcme,100\n'], 'spending.csv', { type: 'text/csv' }),
      ]);

      const response = await POST(makePostRequest(fd));

      expect(response.status).toBe(201);
      const data = await parseJson<{
        data: { results: Array<{ status: string; documentId?: string }> };
      }>(response);
      expect(data.data.results[0].status).toBe('success');
      expect(vi.mocked(uploadDocumentFromBuffer)).toHaveBeenCalledWith(
        expect.any(Buffer),
        'spending.csv',
        ADMIN_ID,
        undefined
      );
      expect(vi.mocked(uploadDocument)).not.toHaveBeenCalled();
    });
  });

  describe('Legacy category form field', () => {
    // Phase 6 dropped the `category` column from `AiKnowledgeDocument` and
    // the corresponding `category` argument from `uploadDocument`. The 4th
    // positional argument is now `sourceUrl`. A stale client still sending
    // `category` in form data must be ignored — NOT silently misrouted into
    // the `sourceUrl` slot. Regression test for the dead-code defect found
    // in /code-review:code-review.
    it('ignores a legacy `category` form field instead of threading it through to uploadDocument', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const fd = makeFormDataWithFiles([
        new File(['# Hello'], 'notes.md', { type: 'text/markdown' }),
      ]);
      fd.append('category', 'guides');

      await POST(makePostRequest(fd));

      // The legacy "guides" value must NOT land in the sourceUrl slot.
      expect(vi.mocked(uploadDocument)).toHaveBeenCalledWith(
        expect.any(String),
        'notes.md',
        ADMIN_ID,
        undefined
      );
    });
  });

  describe('Upload error catch path', () => {
    it('returns per-file error when uploadDocument throws unexpectedly', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(uploadDocument).mockRejectedValue(new Error('S3 unavailable'));
      const fd = makeFormDataWithFiles([
        new File(['# Hello'], 'notes.md', { type: 'text/markdown' }),
      ]);

      const response = await POST(makePostRequest(fd));

      expect(response.status).toBe(201);
      const data = await parseJson<{
        data: { results: Array<{ status: string; error?: string }> };
      }>(response);
      expect(data.data.results[0].status).toBe('error');
      expect(data.data.results[0].error).toBe('S3 unavailable');
    });
  });

  describe('formData parse failure', () => {
    it('returns 400 when request.formData() throws', async () => {
      // Arrange: simulate a malformed multipart body
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const badRequest = {
        method: 'POST',
        headers: new Headers(),
        formData: () => Promise.reject(new Error('bad multipart')),
        url: 'http://localhost:3000/api/v1/admin/orchestration/knowledge/documents/bulk',
      } as unknown as import('next/server').NextRequest;

      const response = await POST(badRequest);

      expect(response.status).toBe(400);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('tagIds parameter (bulk tag application)', () => {
    const TAG_ID = 'cmjbv4i3x00003wsloputgwut';

    it('applies tag grants for a successfully uploaded file', async () => {
      // Arrange: valid tag ID on the form
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocumentTag.createMany).mockResolvedValue({ count: 1 } as never);

      const fd = makeFormDataWithFiles([
        new File(['# Hello'], 'notes.md', { type: 'text/markdown' }),
      ]);
      fd.append('tagIds', TAG_ID);

      const response = await POST(makePostRequest(fd));

      expect(response.status).toBe(201);
      // Tag createMany must be called for the uploaded document
      expect(vi.mocked(prisma.aiKnowledgeDocumentTag.createMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [{ documentId: 'doc-1', tagId: TAG_ID }],
          skipDuplicates: true,
        })
      );
    });

    it('invalidates agent access cache when tags are applied to successful uploads', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocumentTag.createMany).mockResolvedValue({ count: 1 } as never);

      const fd = makeFormDataWithFiles([
        new File(['# Hello'], 'notes.md', { type: 'text/markdown' }),
      ]);
      fd.append('tagIds', TAG_ID);

      await POST(makePostRequest(fd));

      // Cache must be evicted so agents pick up new tag grants immediately
      expect(vi.mocked(invalidateAllAgentAccess)).toHaveBeenCalled();
    });

    it('does NOT invalidate cache when no files succeed (even with tagIds)', async () => {
      // Arrange: only unsupported files so no success rows
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const fd = makeFormDataWithFiles([
        new File(['binary'], 'malware.exe', { type: 'application/octet-stream' }),
      ]);
      fd.append('tagIds', TAG_ID);

      await POST(makePostRequest(fd));

      // No success → cache should NOT be touched
      expect(vi.mocked(invalidateAllAgentAccess)).not.toHaveBeenCalled();
    });

    it('silently ignores invalid tag IDs (not valid CUIDs)', async () => {
      // Route strips invalid tag IDs from the list — no DB call should occur
      // for 'bad-id' since it fails cuidSchema validation.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const fd = makeFormDataWithFiles([
        new File(['# Hello'], 'notes.md', { type: 'text/markdown' }),
      ]);
      fd.append('tagIds', 'bad-id');

      const response = await POST(makePostRequest(fd));

      // Upload succeeds even with invalid tag ID stripped
      expect(response.status).toBe(201);
      // No tag writes because the invalid ID was dropped
      expect(vi.mocked(prisma.aiKnowledgeDocumentTag.createMany)).not.toHaveBeenCalled();
    });

    it('survives a non-fatal tag createMany failure', async () => {
      // Tag writes are best-effort; the upload still returns 201
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocumentTag.createMany).mockRejectedValue(
        new Error('FK violation')
      );

      const fd = makeFormDataWithFiles([
        new File(['# Hello'], 'notes.md', { type: 'text/markdown' }),
      ]);
      fd.append('tagIds', TAG_ID);

      const response = await POST(makePostRequest(fd));

      expect(response.status).toBe(201);
      const data = await parseJson<{
        data: { results: Array<{ status: string }> };
      }>(response);
      // File was still processed successfully before the tag write failed
      expect(data.data.results[0].status).toBe('success');
    });
  });
});
