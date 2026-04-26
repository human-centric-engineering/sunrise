/**
 * Integration Test: Admin Orchestration — Knowledge Document Chunks
 *
 * GET /api/v1/admin/orchestration/knowledge/documents/:id/chunks
 *
 * @see app/api/v1/admin/orchestration/knowledge/documents/[id]/chunks/route.ts
 *
 * Key security assertions:
 * - Admin auth required (401/403 otherwise)
 * - Invalid CUID returns 400
 * - Missing document returns 404
 * - Rate limited
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/knowledge/documents/[id]/chunks/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

// ─── Mock dependencies ────────────��──────────────────────────────────────────

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

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

// ─── Imports after mocks ───────��─────────────────────��───────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';

// ─── Fixtures ────��───────────────────────────────────────────────────────────

const DOC_ID = 'cmjbv4i3x00003wsloputgwul';
const INVALID_ID = 'not-a-cuid';

const MOCK_CHUNKS = [
  {
    id: 'chunk-1',
    content: 'First chunk content',
    chunkType: 'pattern_overview',
    patternNumber: 1,
    patternName: 'Chain of Thought',
    section: 'overview',
    category: 'Reasoning',
    keywords: 'cot,reasoning',
    estimatedTokens: 25,
  },
  {
    id: 'chunk-2',
    content: 'Second chunk content',
    chunkType: 'pattern_section',
    patternNumber: 1,
    patternName: 'Chain of Thought',
    section: 'examples',
    category: 'Reasoning',
    keywords: null,
    estimatedTokens: 30,
  },
];

// ─── Helpers ─���──────────────────────────────────���────────────────────────────

function makeRequest(id: string): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/knowledge/documents/${id}/chunks`
  );
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

// ─── Tests ──────────────────��─────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/knowledge/documents/:id/chunks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await GET(makeRequest(DOC_ID), makeParams(DOC_ID));
      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await GET(makeRequest(DOC_ID), makeParams(DOC_ID));
      expect(response.status).toBe(403);
    });
  });

  describe('Successful retrieval', () => {
    it('returns 200 with chunks for a valid document', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue({ id: DOC_ID } as never);
      vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue(MOCK_CHUNKS as never);

      const response = await GET(makeRequest(DOC_ID), makeParams(DOC_ID));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.data.chunks).toHaveLength(2);
      expect(body.data.chunks[0].chunkType).toBe('pattern_overview');
    });

    it('returns empty chunks array for a document with no chunks', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue({ id: DOC_ID } as never);
      vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([]);

      const response = await GET(makeRequest(DOC_ID), makeParams(DOC_ID));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.chunks).toHaveLength(0);
    });
  });

  describe('Error cases', () => {
    it('returns 404 when document does not exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue(null);

      const response = await GET(makeRequest(DOC_ID), makeParams(DOC_ID));
      expect(response.status).toBe(404);
    });

    it('returns 400 when id is not a valid CUID', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await GET(makeRequest(INVALID_ID), makeParams(INVALID_ID));
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

      const response = await GET(makeRequest(DOC_ID), makeParams(DOC_ID));
      expect(response.status).toBe(429);
    });
  });
});
