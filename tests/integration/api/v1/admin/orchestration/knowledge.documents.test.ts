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
 * - File size limit enforced (10 MB)
 * - Extension whitelist enforced (.md, .markdown, .txt only)
 * - Non-text MIME types rejected
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

vi.mock('@/lib/orchestration/knowledge/document-manager', () => ({
  uploadDocument: vi.fn(),
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
import { uploadDocument } from '@/lib/orchestration/knowledge/document-manager';
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
    status: 'ready',
    uploadedBy: ADMIN_ID,
    sizeBytes: 1024,
    mimeType: 'text/markdown',
    metadata: null,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    _count: { chunks: 12 },
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
      const data = await parseJson<{ success: boolean; data: unknown[]; meta: unknown }>(response);
      expect(data.success).toBe(true);
      expect(data.data).toHaveLength(1);
      expect(data.meta).toBeDefined();
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

      expect(vi.mocked(uploadDocument)).toHaveBeenCalledWith(
        content,
        'patterns.md',
        ADMIN_ID,
        undefined
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

    it('returns 400 when file exceeds 10 MB size limit', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      // 11 MB file
      const bigContent = new Uint8Array(11 * 1024 * 1024);
      const formData = new FormData();
      formData.append('file', new File([bigContent], 'big.md', { type: 'text/markdown' }));

      const response = await POST(makePostRequestWithFormData(formData));

      expect(response.status).toBe(400);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.success).toBe(false);
    });

    it('returns 400 when file has unsupported extension (.exe)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const formData = new FormData();
      formData.append(
        'file',
        new File(['binary content'], 'malware.exe', { type: 'application/octet-stream' })
      );

      const response = await POST(makePostRequestWithFormData(formData));

      expect(response.status).toBe(400);
    });

    it('returns 400 when file has unsupported extension (.exe)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const formData = new FormData();
      formData.append(
        'file',
        new File(['binary'], 'malware.exe', { type: 'application/octet-stream' })
      );

      const response = await POST(makePostRequestWithFormData(formData));

      expect(response.status).toBe(400);
    });

    it('returns 400 when file has unsupported extension (.xls)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const formData = new FormData();
      formData.append(
        'file',
        new File(['data'], 'report.xls', { type: 'application/vnd.ms-excel' })
      );

      const response = await POST(makePostRequestWithFormData(formData));

      expect(response.status).toBe(400);
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
  });
});
