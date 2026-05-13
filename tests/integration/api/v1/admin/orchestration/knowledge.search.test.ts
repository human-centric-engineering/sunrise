/**
 * Integration Test: Admin Orchestration — Knowledge Search
 *
 * POST /api/v1/admin/orchestration/knowledge/search
 *
 * @see app/api/v1/admin/orchestration/knowledge/search/route.ts
 *
 * Key security assertions:
 * - Admin auth required (401/403 otherwise)
 * - Rate limited (adminLimiter)
 * - Missing required query field returns 400
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/knowledge/search/route';
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

vi.mock('@/lib/orchestration/knowledge/search', () => ({
  searchKnowledge: vi.fn(),
}));

vi.mock('@/lib/orchestration/knowledge/resolveAgentDocumentAccess', () => ({
  resolveAgentDocumentAccess: vi.fn(),
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
import { searchKnowledge } from '@/lib/orchestration/knowledge/search';
import { resolveAgentDocumentAccess } from '@/lib/orchestration/knowledge/resolveAgentDocumentAccess';
import { adminLimiter } from '@/lib/security/rate-limit';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeResult(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cmjbv4i3x00003wsloputgwul',
    documentId: 'cmjbv4i3x00003wsloputgwu2',
    content: 'This is a knowledge chunk about agent patterns.',
    chunkType: 'pattern',
    patternNumber: 1,
    section: 'overview',
    similarity: 0.92,
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePostRequest(body: Record<string, unknown>): NextRequest {
  return {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: 'http://localhost:3000/api/v1/admin/orchestration/knowledge/search',
  } as unknown as NextRequest;
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/knowledge/search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await POST(makePostRequest({ query: 'agent patterns' }));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await POST(makePostRequest({ query: 'agent patterns' }));

      expect(response.status).toBe(403);
    });
  });

  describe('Successful search', () => {
    it('returns 200 with results array for valid query', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const results = [
        makeResult(),
        makeResult({ id: 'cmjbv4i3x00003wsloputgwu3', similarity: 0.85 }),
      ];
      vi.mocked(searchKnowledge).mockResolvedValue(results as never);

      const response = await POST(makePostRequest({ query: 'agent patterns' }));

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { results: unknown[] } }>(response);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data.results).toHaveLength(2);
    });

    it('returns 200 with empty results when no matches found', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(searchKnowledge).mockResolvedValue([] as never);

      const response = await POST(makePostRequest({ query: 'something obscure' }));

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { results: unknown[] } }>(response);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data.results).toHaveLength(0);
    });

    it('passes query and optional filters to searchKnowledge', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(searchKnowledge).mockResolvedValue([makeResult()] as never);

      await POST(
        makePostRequest({
          query: 'parallel agent patterns',
          chunkType: 'pattern_overview',
          patternNumber: 4,
          limit: 5,
        })
      );

      expect(vi.mocked(searchKnowledge)).toHaveBeenCalledWith(
        'parallel agent patterns',
        expect.objectContaining({
          chunkType: 'pattern_overview',
          patternNumber: 4,
        }),
        5
      );
    });
  });

  describe('Validation errors', () => {
    it('returns 400 when query field is missing', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest({}));

      expect(response.status).toBe(400);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when query is empty string', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest({ query: '' }));

      expect(response.status).toBe(400);
    });
  });

  describe('Rate limiting', () => {
    it('calls adminLimiter.check on POST', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(searchKnowledge).mockResolvedValue([]);

      await POST(makePostRequest({ query: 'agent patterns' }));

      expect(vi.mocked(adminLimiter.check)).toHaveBeenCalledOnce();
    });

    it('returns 429 when rate limit exceeded', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await POST(makePostRequest({ query: 'agent patterns' }));

      expect(response.status).toBe(429);
      expect(vi.mocked(searchKnowledge)).not.toHaveBeenCalled();
    });
  });

  describe('Agent-scoped search (agentId param)', () => {
    const AGENT_ID = 'cmjbv4i3x00003wsloputgwul';

    it('routes search through resolver when agentId is provided in restricted mode', async () => {
      // Arrange: agent has restricted access — only specific document IDs
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(resolveAgentDocumentAccess).mockResolvedValue({
        mode: 'restricted',
        documentIds: ['doc-1', 'doc-2'],
        includeSystemScope: false,
      } as never);
      vi.mocked(searchKnowledge).mockResolvedValue([makeResult()] as never);

      const response = await POST(makePostRequest({ query: 'agent knowledge', agentId: AGENT_ID }));

      // Assert: resolver was called with the agent id
      expect(vi.mocked(resolveAgentDocumentAccess)).toHaveBeenCalledWith(AGENT_ID);

      // Assert: searchKnowledge received the document-id filter
      expect(vi.mocked(searchKnowledge)).toHaveBeenCalledWith(
        'agent knowledge',
        expect.objectContaining({
          documentIds: ['doc-1', 'doc-2'],
          includeSystemScope: false,
        }),
        expect.anything()
      );

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: { results: unknown[]; agentScope: string };
      }>(response);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data.agentScope).toBe('restricted');
    });

    it('does not apply document filters when agent mode is full', async () => {
      // Arrange: agent has full access — no document-id restriction
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(resolveAgentDocumentAccess).mockResolvedValue({
        mode: 'full',
        documentIds: [],
        includeSystemScope: true,
      } as never);
      vi.mocked(searchKnowledge).mockResolvedValue([]);

      const response = await POST(makePostRequest({ query: 'open access', agentId: AGENT_ID }));

      expect(vi.mocked(resolveAgentDocumentAccess)).toHaveBeenCalledWith(AGENT_ID);

      // In full mode, documentIds filter should NOT be set on the filters object
      const [, filtersArg] = vi.mocked(searchKnowledge).mock.calls[0];
      expect(filtersArg).not.toHaveProperty('documentIds');

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: { agentScope: string };
      }>(response);
      expect(data.data.agentScope).toBe('full');
    });

    it('includes scope field in response reflecting restricted agentScope', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(resolveAgentDocumentAccess).mockResolvedValue({
        mode: 'restricted',
        documentIds: ['doc-3'],
        includeSystemScope: true,
      } as never);
      vi.mocked(searchKnowledge).mockResolvedValue([]);

      const response = await POST(makePostRequest({ query: 'scoped search', agentId: AGENT_ID }));

      expect(response.status).toBe(200);
      const data = await parseJson<{
        data: { results: unknown[]; agentScope: string };
      }>(response);
      expect(data.data.agentScope).toBe('restricted');
    });

    it('does not call resolveAgentDocumentAccess when agentId is not provided', async () => {
      // Arrange: no agentId — global search
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(searchKnowledge).mockResolvedValue([]);

      await POST(makePostRequest({ query: 'global search' }));

      expect(vi.mocked(resolveAgentDocumentAccess)).not.toHaveBeenCalled();
    });
  });
});
