/**
 * Integration Test: Admin Orchestration — Workflow Definition History
 *
 * GET /api/v1/admin/orchestration/workflows/:id/definition-history
 *
 * @see app/api/v1/admin/orchestration/workflows/[id]/definition-history/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/workflows/[id]/definition-history/route';
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
    aiWorkflow: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    withContext: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    })),
  },
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const WORKFLOW_ID = 'cmjbv4i3x00003wsloputgwu2';
const USER_ID = 'cmjbv4i3x00003wsloputgwul';
const INVALID_ID = 'not-a-cuid';
const BASE_URL = `http://localhost:3000/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}/definition-history`;

function makeHistoryEntry(
  overrides: { definition?: Record<string, unknown>; changedAt?: string; changedBy?: string } = {}
) {
  return {
    definition: { steps: [], name: 'Old version' },
    changedAt: '2024-01-01T00:00:00.000Z',
    changedBy: USER_ID,
    ...overrides,
  };
}

function makeWorkflowRow(
  overrides: {
    workflowDefinition?: Record<string, unknown>;
    workflowDefinitionHistory?: unknown;
  } = {}
) {
  return {
    id: WORKFLOW_ID,
    slug: 'test-workflow',
    workflowDefinition: { steps: [], name: 'Current version' },
    workflowDefinitionHistory: [makeHistoryEntry()],
    ...overrides,
  };
}

function makeRequest(): NextRequest {
  return {
    method: 'GET',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    url: BASE_URL,
  } as unknown as NextRequest;
}

function makeParams(id: string = WORKFLOW_ID) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/workflows/:id/definition-history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await GET(makeRequest(), makeParams());

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await GET(makeRequest(), makeParams());

      expect(response.status).toBe(403);
    });
  });

  describe('Validation', () => {
    it('returns 400 when id is not a valid CUID', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await GET(makeRequest(), makeParams(INVALID_ID));

      expect(response.status).toBe(400);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Not found', () => {
    it('returns 404 when workflow does not exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(null);

      const response = await GET(makeRequest(), makeParams());

      expect(response.status).toBe(404);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.error.code).toBe('NOT_FOUND');
    });
  });

  describe('Successful retrieval', () => {
    it('returns 200 with workflowId, slug, current definition, and history', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflowRow() as never);

      const response = await GET(makeRequest(), makeParams());

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: {
          workflowId: string;
          slug: string;
          current: Record<string, unknown>;
          history: unknown[];
        };
      }>(response);

      expect(data.success).toBe(true);
      expect(data.data.workflowId).toBe(WORKFLOW_ID);
      expect(data.data.slug).toBe('test-workflow');
      expect(data.data.current).toBeDefined();
      expect(Array.isArray(data.data.history)).toBe(true);
    });

    it('returns history in reverse order (newest first) with versionIndex', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const historyEntries = [
        makeHistoryEntry({
          changedAt: '2024-01-01T00:00:00.000Z',
          definition: { steps: [], name: 'v0' },
        }),
        makeHistoryEntry({
          changedAt: '2024-06-01T00:00:00.000Z',
          definition: { steps: [], name: 'v1' },
        }),
        makeHistoryEntry({
          changedAt: '2024-12-01T00:00:00.000Z',
          definition: { steps: [], name: 'v2' },
        }),
      ];

      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
        makeWorkflowRow({ workflowDefinitionHistory: historyEntries }) as never
      );

      const response = await GET(makeRequest(), makeParams());

      expect(response.status).toBe(200);
      const data = await parseJson<{
        data: { history: Array<{ versionIndex: number; definition: { name: string } }> };
      }>(response);

      // History is reversed — newest (versionIndex=2) is first
      expect(data.data.history).toHaveLength(3);
      expect(data.data.history[0].versionIndex).toBe(2);
      expect(data.data.history[1].versionIndex).toBe(1);
      expect(data.data.history[2].versionIndex).toBe(0);
    });

    it('returns empty history array when workflowDefinitionHistory is empty', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
        makeWorkflowRow({ workflowDefinitionHistory: [] }) as never
      );

      const response = await GET(makeRequest(), makeParams());

      expect(response.status).toBe(200);
      const data = await parseJson<{ data: { history: unknown[] } }>(response);
      expect(data.data.history).toHaveLength(0);
    });

    it('returns empty history when workflowDefinitionHistory is malformed JSON', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
        makeWorkflowRow({ workflowDefinitionHistory: 'not-valid-json-array' }) as never
      );

      const response = await GET(makeRequest(), makeParams());

      // Route degrades gracefully — returns 200 with empty history
      expect(response.status).toBe(200);
      const data = await parseJson<{ data: { history: unknown[] } }>(response);
      expect(data.data.history).toHaveLength(0);
    });
  });
});
