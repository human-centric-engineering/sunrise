/**
 * Unit tests for GET /api/v1/admin/orchestration/executions/live.
 *
 * The route is a thin auth + rate-limit + envelope wrapper around
 * `getLiveEngineSnapshot()`. Tests cover:
 *   - 401 for unauthenticated requests
 *   - 403 for authenticated non-admin requests
 *   - 429 when the rate limiter rejects the request
 *   - 200 with snapshot pass-through, verifying getLiveEngineSnapshot is called once
 *   - structural shape of the snapshot (four cards + generatedAt)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Mocks (declared before imports) ────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/orchestration/admin/live-engine-snapshot', () => ({
  getLiveEngineSnapshot: vi.fn(),
}));

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { GET } from '@/app/api/v1/admin/orchestration/executions/live/route';
import { auth } from '@/lib/auth/config';
import { getLiveEngineSnapshot } from '@/lib/orchestration/admin/live-engine-snapshot';
import {
  mockAdminUser,
  mockUnauthenticatedUser,
  mockAuthenticatedUser,
} from '@/tests/helpers/auth';
import type { LiveEngineSnapshot } from '@/lib/orchestration/admin/live-engine-snapshot';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeSnapshot(overrides: Partial<LiveEngineSnapshot> = {}): LiveEngineSnapshot {
  return {
    running: {
      count: 3,
      p95AgeMs: 12000,
      maxAgeMs: 18500,
    },
    queued: {
      count: 7,
      maxWaitMs: 45000,
    },
    orphaned: {
      count: 1,
    },
    providers: [
      { provider: 'openai', inFlight: 2 },
      { provider: 'anthropic', inFlight: 1 },
    ],
    generatedAt: '2026-05-20T10:00:00.000Z',
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/admin/orchestration/executions/live');
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/executions/live', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset rate limiter to allow-by-default so individual tests only need
    // to override when testing the 429 path.
    vi.mocked(getLiveEngineSnapshot).mockResolvedValue(makeSnapshot());
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
  });

  it('returns 403 when authenticated as a non-admin user', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const response = await GET(makeRequest());

    expect(response.status).toBe(403);
  });

  it('returns 200 with the snapshot wrapped in the success envelope', async () => {
    const snapshot = makeSnapshot();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(getLiveEngineSnapshot).mockResolvedValue(snapshot);

    const response = await GET(makeRequest());
    const body = await parseJson<{ success: boolean; data: LiveEngineSnapshot }>(response);

    expect(response.status).toBe(200);
    // The route wraps getLiveEngineSnapshot's return value in { success: true, data: ... }.
    // Asserting the envelope structure verifies the route did the wrapping — not just that
    // the mock returned a value.
    expect(body.success).toBe(true);
    expect(body.data).toEqual(snapshot);
  });

  it('calls getLiveEngineSnapshot exactly once per request', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    await GET(makeRequest());

    expect(getLiveEngineSnapshot).toHaveBeenCalledTimes(1);
    // The route scopes the snapshot to the authenticated admin so the counts
    // match what they can see on the executions list. The whole session goes
    // over, not a user id: the visibility clause needs the policy's answer to
    // "may this caller see runs nobody started", which the guard resolved onto
    // `unattributedReads`. Asserting both halves guards against a regression
    // that drops the scope and silently returns a global count to a partner
    // admin, and against one that hands over a reshaped session the answer did
    // not survive.
    const [options] = vi.mocked(getLiveEngineSnapshot).mock.calls[0];
    expect(options?.session?.user.id).toBe(mockAdminUser().user.id);
    expect(options?.session?.unattributedReads).toEqual({
      conversation: true,
      dataset: true,
      execution: true,
      experiment: true,
    });
  });

  it('passes through all four cards and generatedAt from the snapshot', async () => {
    const snapshot = makeSnapshot({
      running: { count: 5, p95AgeMs: 8000, maxAgeMs: 20000 },
      queued: { count: 2, maxWaitMs: 90000 },
      orphaned: { count: 3 },
      providers: [
        { provider: 'openai', inFlight: 4 },
        { provider: 'mistral', inFlight: 1 },
        { provider: 'anthropic', inFlight: 0 },
      ],
      generatedAt: '2026-05-20T12:34:56.789Z',
    });
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(getLiveEngineSnapshot).mockResolvedValue(snapshot);

    const response = await GET(makeRequest());
    const body = await parseJson<{ success: boolean; data: LiveEngineSnapshot }>(response);

    // Each assertion targets a field the route must forward; if the route
    // dropped any card the assertion on that specific field fails.
    expect(body.data.running.count).toBe(5);
    expect(body.data.queued.maxWaitMs).toBe(90000);
    expect(body.data.orphaned.count).toBe(3);
    expect(body.data.providers).toHaveLength(3);
    expect(body.data.generatedAt).toBe('2026-05-20T12:34:56.789Z');
  });
});
