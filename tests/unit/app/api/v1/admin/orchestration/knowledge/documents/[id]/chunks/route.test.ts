/**
 * Unit Tests: GET /api/v1/admin/orchestration/knowledge/documents/:id/chunks
 *
 * Tests the chunks endpoint that returns all chunks for a document.
 *
 * Test Coverage:
 * - Happy path: valid CUID → 200 with chunks array
 * - Document not found → 404
 * - Invalid CUID → 400 VALIDATION_ERROR
 * - Unauthenticated request → 401
 * - Non-admin user → 403
 * - Empty chunks array → 200
 *
 * @see app/api/v1/admin/orchestration/knowledge/documents/[id]/chunks/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiKnowledgeDocument: { findUnique: vi.fn() },
    aiKnowledgeChunk: { findMany: vi.fn() },
  },
}));

// ─── Imports after mocks ────────────────────────────────────────────────────

import { GET } from '@/app/api/v1/admin/orchestration/knowledge/documents/[id]/chunks/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import {
  mockAdminUser,
  mockUnauthenticatedUser,
  mockAuthenticatedUser,
} from '@/tests/helpers/auth';

// ─── Helpers ────────────────────────────────────────────────────────────────

const VALID_CUID = 'cmjbv4i3x00003wsloputgwul';

function makeRequest(id: string): NextRequest {
  return new NextRequest(
    new URL(`http://localhost/api/v1/admin/orchestration/knowledge/documents/${id}/chunks`)
  );
}

function callGET(id: string) {
  return (GET as (...args: unknown[]) => Promise<Response>)(makeRequest(id), {
    params: Promise.resolve({ id }),
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('GET /knowledge/documents/:id/chunks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser() as never);
  });

  it('returns chunks for a valid document', async () => {
    const mockChunks = [
      {
        id: 'chunk-1',
        content: 'First chunk content',
        chunkType: 'pattern_overview',
        patternNumber: 1,
        patternName: 'Chain of Thought',
        section: 'Overview',
        category: 'patterns',
        keywords: 'reasoning,logic',
        estimatedTokens: 50,
      },
      {
        id: 'chunk-2',
        content: 'Second chunk content',
        chunkType: 'pattern_section',
        patternNumber: 1,
        patternName: 'Chain of Thought',
        section: 'Implementation',
        category: 'patterns',
        keywords: 'code,example',
        estimatedTokens: 120,
      },
    ];

    vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue({
      id: VALID_CUID,
    } as never);
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue(mockChunks as never);

    const response = await callGET(VALID_CUID);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.data.chunks).toHaveLength(2);
    expect(body.data.chunks[0].content).toBe('First chunk content');
    expect(body.data.chunks[1].chunkType).toBe('pattern_section');
  });

  it('returns 404 when document does not exist', async () => {
    vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue(null);

    const response = await callGET(VALID_CUID);
    expect(response.status).toBe(404);
  });

  it('returns 400 for invalid CUID', async () => {
    const response = await callGET('not-a-valid-cuid');
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.success).toBe(false);
  });

  it('returns 401 for unauthenticated requests', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser() as never);
    const response = await callGET(VALID_CUID);
    expect(response.status).toBe(401);
  });

  it('returns 403 for non-admin users', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser() as never);
    const response = await callGET(VALID_CUID);
    expect(response.status).toBe(403);
  });

  it('returns empty array when document has no chunks', async () => {
    vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue({
      id: VALID_CUID,
    } as never);
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([] as never);

    const response = await callGET(VALID_CUID);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.data.chunks).toHaveLength(0);
  });
});
