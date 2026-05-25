/**
 * Integration Test: Bulk provider connection test
 *
 * POST /api/v1/admin/orchestration/providers/test-bulk
 *
 * Replaces the previous client-side N+1 fan-out (one POST per provider id
 * on the providers list mount) with a single batched HTTP roundtrip.
 *
 * Key behaviours:
 *   - Authentication: 401/403 gates.
 *   - Validation: 400 on missing/invalid body, empty array, oversized
 *     batch, non-cuid ids.
 *   - Happy path: returns one row per existing provider with
 *     `{ id, ok, models }`.
 *   - Mixed result: ok=true for one, ok=false for another — the response
 *     contains both rows.
 *   - Missing provider id: silently dropped (the response just doesn't
 *     include a row), mirroring how a single-id endpoint would 404.
 *   - testProvider throws: the row carries `ok: false, error:
 *     'connection_failed'` (the same sanitised error contract as the
 *     single-id endpoint — raw SDK errors stay server-side).
 *
 * @see app/api/v1/admin/orchestration/providers/test-bulk/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/providers/test-bulk/route';
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
    aiProviderConfig: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  testProvider: vi.fn(),
}));

// Stub the route logger so we can force log.warn to throw in the defensive
// branch test without any real I/O side-effects in other tests.
const mockLogWarn = vi.fn();
const mockLogInfo = vi.fn();

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn().mockResolvedValue({
    warn: (...args: unknown[]) => mockLogWarn(...args),
    info: (...args: unknown[]) => mockLogInfo(...args),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { testProvider } from '@/lib/orchestration/llm/provider-manager';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const PROVIDER_A = 'cmjbv4i3x00003wsloputgwul';
const PROVIDER_B = 'cmjbv4i3x00103wsloputgwul';
const PROVIDER_MISSING = 'cmjbv4i3x00203wsloputgwul';
const INVALID_ID = 'not-a-cuid';

interface ProviderRow {
  id: string;
  slug: string;
}

const PROVIDER_ROW_A: ProviderRow = { id: PROVIDER_A, slug: 'anthropic' };
const PROVIDER_ROW_B: ProviderRow = { id: PROVIDER_B, slug: 'openai' };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePostRequest(body: unknown): NextRequest {
  return {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: 'http://localhost:3000/api/v1/admin/orchestration/providers/test-bulk',
  } as unknown as NextRequest;
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

interface SuccessBody {
  success: true;
  data: {
    results: Array<{ id: string; ok: boolean; models: string[]; error?: string }>;
  };
}

interface ErrorBody {
  success: false;
  error: { code: string; message: string };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/providers/test-bulk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await POST(makePostRequest({ providerIds: [PROVIDER_A] }));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated but not admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());

      const response = await POST(makePostRequest({ providerIds: [PROVIDER_A] }));

      expect(response.status).toBe(403);
    });
  });

  describe('Validation', () => {
    beforeEach(() => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    });

    it('returns 400 when providerIds is missing', async () => {
      const response = await POST(makePostRequest({}));

      expect(response.status).toBe(400);
      const body = await parseJson<ErrorBody>(response);
      expect(body.success).toBe(false);
    });

    it('returns 400 when providerIds is empty', async () => {
      const response = await POST(makePostRequest({ providerIds: [] }));

      expect(response.status).toBe(400);
    });

    it('returns 400 when providerIds contains a non-cuid value', async () => {
      const response = await POST(makePostRequest({ providerIds: [INVALID_ID] }));

      expect(response.status).toBe(400);
    });

    it('returns 400 when providerIds exceeds the 50-row cap', async () => {
      const tooMany = Array.from({ length: 51 }, () => PROVIDER_A);

      const response = await POST(makePostRequest({ providerIds: tooMany }));

      expect(response.status).toBe(400);
    });
  });

  describe('Happy path', () => {
    beforeEach(() => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    });

    it('returns one row per existing provider with ok=true and the reported models', async () => {
      vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValueOnce([
        PROVIDER_ROW_A,
        PROVIDER_ROW_B,
      ] as never);
      vi.mocked(testProvider).mockImplementation(async (slug: string) => {
        if (slug === 'anthropic') {
          return { ok: true, models: ['claude-sonnet-4-6', 'claude-opus-4-6'] };
        }
        return { ok: true, models: ['gpt-4o-mini', 'gpt-4o'] };
      });

      const response = await POST(makePostRequest({ providerIds: [PROVIDER_A, PROVIDER_B] }));

      expect(response.status).toBe(200);
      const body = await parseJson<SuccessBody>(response);
      expect(body.success).toBe(true);
      expect(body.data.results).toHaveLength(2);

      const byId = new Map(body.data.results.map((r) => [r.id, r]));
      expect(byId.get(PROVIDER_A)).toEqual({
        id: PROVIDER_A,
        ok: true,
        models: ['claude-sonnet-4-6', 'claude-opus-4-6'],
      });
      expect(byId.get(PROVIDER_B)).toEqual({
        id: PROVIDER_B,
        ok: true,
        models: ['gpt-4o-mini', 'gpt-4o'],
      });
    });

    it('runs the upstream tests concurrently — each gets exactly one call', async () => {
      vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValueOnce([
        PROVIDER_ROW_A,
        PROVIDER_ROW_B,
      ] as never);
      vi.mocked(testProvider).mockResolvedValue({ ok: true, models: [] });

      await POST(makePostRequest({ providerIds: [PROVIDER_A, PROVIDER_B] }));

      expect(testProvider).toHaveBeenCalledTimes(2);
      const calledSlugs = vi.mocked(testProvider).mock.calls.map((c) => c[0]);
      expect(calledSlugs).toEqual(expect.arrayContaining(['anthropic', 'openai']));
    });

    it('mixes ok=true and ok=false results in a single response', async () => {
      vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValueOnce([
        PROVIDER_ROW_A,
        PROVIDER_ROW_B,
      ] as never);
      vi.mocked(testProvider).mockImplementation(async (slug: string) => {
        if (slug === 'anthropic') return { ok: true, models: ['m1'] };
        return { ok: false, models: [] };
      });

      const response = await POST(makePostRequest({ providerIds: [PROVIDER_A, PROVIDER_B] }));

      const body = await parseJson<SuccessBody>(response);
      const byId = new Map(body.data.results.map((r) => [r.id, r]));
      expect(byId.get(PROVIDER_A)?.ok).toBe(true);
      expect(byId.get(PROVIDER_B)?.ok).toBe(false);
    });
  });

  describe('Edge cases', () => {
    beforeEach(() => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    });

    it('drops missing provider ids — only existing rows make it into the response', async () => {
      // Ask for A + a missing id; DB returns just A.
      vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValueOnce([PROVIDER_ROW_A] as never);
      vi.mocked(testProvider).mockResolvedValueOnce({ ok: true, models: [] });

      const response = await POST(makePostRequest({ providerIds: [PROVIDER_A, PROVIDER_MISSING] }));

      expect(response.status).toBe(200);
      const body = await parseJson<SuccessBody>(response);
      expect(body.data.results).toHaveLength(1);
      expect(body.data.results[0].id).toBe(PROVIDER_A);
    });

    it('returns connection_failed without leaking the raw SDK error when testProvider throws', async () => {
      const SECRET_LEAK = 'fetch failed: 192.168.0.1:8080 ECONNREFUSED';
      vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValueOnce([PROVIDER_ROW_A] as never);
      vi.mocked(testProvider).mockRejectedValueOnce(new Error(SECRET_LEAK));

      const response = await POST(makePostRequest({ providerIds: [PROVIDER_A] }));

      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain(SECRET_LEAK);
      expect(text).not.toContain('192.168');
      const body = JSON.parse(text) as SuccessBody;
      expect(body.data.results[0]).toEqual({
        id: PROVIDER_A,
        ok: false,
        models: [],
        error: 'connection_failed',
      });
    });

    it('isolates failures — one provider throwing does not poison the rest', async () => {
      vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValueOnce([
        PROVIDER_ROW_A,
        PROVIDER_ROW_B,
      ] as never);
      vi.mocked(testProvider).mockImplementation(async (slug: string) => {
        if (slug === 'anthropic') return { ok: true, models: ['m1'] };
        throw new Error('boom');
      });

      const response = await POST(makePostRequest({ providerIds: [PROVIDER_A, PROVIDER_B] }));

      const body = await parseJson<SuccessBody>(response);
      const byId = new Map(body.data.results.map((r) => [r.id, r]));
      expect(byId.get(PROVIDER_A)?.ok).toBe(true);
      expect(byId.get(PROVIDER_B)?.ok).toBe(false);
      expect(byId.get(PROVIDER_B)?.error).toBe('connection_failed');
    });

    it('handles non-Error throwables without leaking the value', async () => {
      // Some SDKs throw plain strings or POJOs. The route stringifies
      // those for the server log but only ever returns
      // 'connection_failed' to the caller.
      vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValueOnce([PROVIDER_ROW_A] as never);
      vi.mocked(testProvider).mockRejectedValueOnce('string-thrown-error');

      const response = await POST(makePostRequest({ providerIds: [PROVIDER_A] }));

      expect(response.status).toBe(200);
      const body = await parseJson<SuccessBody>(response);
      expect(body.data.results[0]).toEqual({
        id: PROVIDER_A,
        ok: false,
        models: [],
        error: 'connection_failed',
      });
    });

    it('returns an empty results array when no requested providers exist', async () => {
      // findMany returns []; the response collapses to no rows. Exercises
      // the early-out path where Promise.allSettled has nothing to do.
      vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValueOnce([] as never);

      const response = await POST(makePostRequest({ providerIds: [PROVIDER_MISSING] }));

      expect(response.status).toBe(200);
      const body = await parseJson<SuccessBody>(response);
      expect(body.data.results).toEqual([]);
      expect(testProvider).not.toHaveBeenCalled();
    });

    it('sanitises the row when log.warn itself throws — defensive branch (line 77)', async () => {
      // Scenario: testProvider throws so the inner catch runs. Inside the
      // catch, log.warn is called to record the error. If log.warn itself
      // throws (e.g. a broken Pino transport, a crashing Sentry adapter),
      // that secondary throw escapes the try/catch and causes
      // Promise.allSettled to yield { status: 'rejected' } for that slot.
      // The outer .map() defensive branch (line 77) must sanitise that
      // rejected slot into the same uniform shape as any other failure row.
      //
      // Anti-green-bar: if the defensive branch were replaced with
      // `return r.value` (trusting allSettled never rejects), `r.value`
      // would be `undefined` for a rejected promise, breaking the
      // BulkTestResult[] contract — and this test would fail because
      // body.data.results[0] would be undefined, not the sanitised shape.

      const LOGGER_THROW_MESSAGE = 'pino-transport-broken-error';

      // Step 1: testProvider rejects — the inner catch fires.
      vi.mocked(testProvider).mockRejectedValueOnce(new Error('upstream broken'));

      // Step 2: inside the inner catch, log.warn is called. Make it throw,
      // so the async function itself rejects (escaping the try/catch).
      mockLogWarn.mockImplementationOnce(() => {
        throw new Error(LOGGER_THROW_MESSAGE);
      });

      vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValueOnce([PROVIDER_ROW_A] as never);

      const response = await POST(makePostRequest({ providerIds: [PROVIDER_A] }));

      // The defensive branch must keep the response well-formed.
      expect(response.status).toBe(200);
      const body = await parseJson<SuccessBody>(response);
      expect(body.success).toBe(true);

      // Exactly one sanitised row — the same contract as a normal failure row.
      expect(body.data.results).toHaveLength(1);
      expect(body.data.results[0]).toEqual({
        id: PROVIDER_A,
        ok: false,
        models: [],
        error: 'connection_failed',
      });

      // Security-critical: neither the original upstream error nor the
      // logger throw must appear in the response body.
      const rawText = JSON.stringify(body);
      expect(rawText).not.toContain('upstream broken');
      expect(rawText).not.toContain(LOGGER_THROW_MESSAGE);
    });
  });
});
