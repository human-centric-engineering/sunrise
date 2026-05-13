/**
 * Integration Test: Admin Knowledge Document tag mutation
 *
 * GET    /api/v1/admin/orchestration/knowledge/documents/:id     → returns tagIds[]
 * PATCH  /api/v1/admin/orchestration/knowledge/documents/:id     → replaces tag join rows
 *
 * @see app/api/v1/admin/orchestration/knowledge/documents/[id]/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, PATCH } from '@/app/api/v1/admin/orchestration/knowledge/documents/[id]/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

const mockTx = {
  aiKnowledgeDocumentTag: { deleteMany: vi.fn(), createMany: vi.fn() },
};

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiKnowledgeDocument: { findUnique: vi.fn() },
    $transaction: vi.fn((fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
}));

vi.mock('@/lib/orchestration/knowledge/document-manager', () => ({
  deleteDocument: vi.fn(),
}));

vi.mock('@/lib/orchestration/knowledge/resolveAgentDocumentAccess', () => ({
  invalidateAllAgentAccess: vi.fn(),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { invalidateAllAgentAccess } from '@/lib/orchestration/knowledge/resolveAgentDocumentAccess';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const DOC_ID = 'cmjbv4i3x00003wsloputgwul';
const TAG_ID_A = 'cmjbv4i3x00003wsloputaaaa';
const TAG_ID_B = 'cmjbv4i3x00003wsloputbbbb';

function makeDoc(tagIds: string[] = []) {
  return {
    id: DOC_ID,
    name: 'Test Doc',
    fileName: 'test.md',
    fileHash: 'abc',
    status: 'ready',
    scope: 'app',
    category: null,
    sourceUrl: null,
    errorMessage: null,
    metadata: null,
    uploadedBy: 'user-1',
    chunkCount: 1,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    _count: { chunks: 1 },
    tags: tagIds.map((tagId) => ({ tagId })),
  };
}

function makeReq(method: string, body?: Record<string, unknown>): NextRequest {
  return {
    method,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body ?? {}),
    url: `http://localhost:3000/api/v1/admin/orchestration/knowledge/documents/${DOC_ID}`,
  } as unknown as NextRequest;
}

function makeParams() {
  return { params: Promise.resolve({ id: DOC_ID }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/knowledge/documents/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('flattens the tags relation into a tagIds array', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue(
      makeDoc([TAG_ID_A, TAG_ID_B]) as never
    );

    const response = await GET(makeReq('GET'), makeParams());

    expect(response.status).toBe(200);
    const body = await parseJson<{ success: boolean; data: { document: { tagIds: string[] } } }>(
      response
    );
    expect(body.data.document.tagIds).toEqual([TAG_ID_A, TAG_ID_B]);
  });
});

describe('PATCH /api/v1/admin/orchestration/knowledge/documents/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTx.aiKnowledgeDocumentTag.deleteMany.mockReset();
    mockTx.aiKnowledgeDocumentTag.createMany.mockReset();
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await PATCH(makeReq('PATCH', { tagIds: [TAG_ID_A] }), makeParams());

    expect(response.status).toBe(401);
  });

  it('returns 403 for non-admin users', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const response = await PATCH(makeReq('PATCH', { tagIds: [TAG_ID_A] }), makeParams());

    expect(response.status).toBe(403);
  });

  it('returns 404 when the document does not exist', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue(null);

    const response = await PATCH(makeReq('PATCH', { tagIds: [TAG_ID_A] }), makeParams());

    expect(response.status).toBe(404);
  });

  it('replaces the doc-tag join rows when tagIds is supplied', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiKnowledgeDocument.findUnique)
      .mockResolvedValueOnce({ id: DOC_ID, name: 'Test Doc' } as never)
      .mockResolvedValueOnce(makeDoc([TAG_ID_A, TAG_ID_B]) as never);

    const response = await PATCH(makeReq('PATCH', { tagIds: [TAG_ID_A, TAG_ID_B] }), makeParams());

    expect(response.status).toBe(200);
    expect(mockTx.aiKnowledgeDocumentTag.deleteMany).toHaveBeenCalledWith({
      where: { documentId: DOC_ID },
    });
    expect(mockTx.aiKnowledgeDocumentTag.createMany).toHaveBeenCalledWith({
      data: [
        { documentId: DOC_ID, tagId: TAG_ID_A },
        { documentId: DOC_ID, tagId: TAG_ID_B },
      ],
      skipDuplicates: true,
    });
    expect(invalidateAllAgentAccess).toHaveBeenCalled();
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'knowledge_document.update' })
    );

    const body = await parseJson<{ data: { document: { tagIds: string[] } } }>(response);
    expect(body.data.document.tagIds).toEqual([TAG_ID_A, TAG_ID_B]);
  });

  it('clears all tags when tagIds is the empty array', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiKnowledgeDocument.findUnique)
      .mockResolvedValueOnce({ id: DOC_ID, name: 'Test Doc' } as never)
      .mockResolvedValueOnce(makeDoc([]) as never);

    const response = await PATCH(makeReq('PATCH', { tagIds: [] }), makeParams());

    expect(response.status).toBe(200);
    expect(mockTx.aiKnowledgeDocumentTag.deleteMany).toHaveBeenCalledWith({
      where: { documentId: DOC_ID },
    });
    expect(mockTx.aiKnowledgeDocumentTag.createMany).not.toHaveBeenCalled();
  });

  it('returns 400 when the body is empty (no fields to update)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue({
      id: DOC_ID,
      name: 'Test Doc',
    } as never);

    const response = await PATCH(makeReq('PATCH', {}), makeParams());

    expect(response.status).toBe(400);
  });

  it('rejects invalid tag CUIDs with 400', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue({
      id: DOC_ID,
      name: 'Test Doc',
    } as never);

    const response = await PATCH(makeReq('PATCH', { tagIds: ['not-a-cuid'] }), makeParams());

    expect(response.status).toBe(400);
  });
});
