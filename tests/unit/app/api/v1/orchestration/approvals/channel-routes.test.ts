/**
 * Unit Tests: Channel-specific approval sub-routes
 *
 * /api/v1/orchestration/approvals/:id/{approve,reject}/{chat,embed}
 *
 * Covers the CORS enforcement and `actorLabel` pinning for the four
 * new sub-routes added in Phase 5 of consumer-chat-approvals. The
 * shared helper covers the rest of the request lifecycle (rate limit,
 * token verify, body parse, action) — see the existing
 * `approvals.id.{approve,reject}.test.ts` integration tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mirrors the setup.ts test env (APP_URL must match what env.NEXT_PUBLIC_APP_URL
// resolved to at module load time in the test runtime).
const APP_URL = 'http://localhost:3000';

vi.mock('@/lib/security/rate-limit', () => ({
  apiLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

const mockVerify = vi.fn();
vi.mock('@/lib/orchestration/approval-tokens', () => ({
  verifyApprovalToken: (token: string): unknown => mockVerify(token),
}));

const mockExecuteApproval = vi.fn();
const mockExecuteRejection = vi.fn();
vi.mock('@/lib/orchestration/approval-actions', () => ({
  executeApproval: (id: string, opts: unknown): unknown => mockExecuteApproval(id, opts),
  executeRejection: (id: string, opts: unknown): unknown => mockExecuteRejection(id, opts),
}));

const mockGetSettings = vi.fn();
vi.mock('@/lib/orchestration/settings', () => ({
  getOrchestrationSettings: (): unknown => mockGetSettings(),
}));

const mockResumeApprovedExecution = vi.fn();
vi.mock('@/lib/orchestration/scheduling', () => ({
  resumeApprovedExecution: (id: string): unknown => mockResumeApprovedExecution(id),
}));

const VALID_ID = 'cmexec99validid01234567890';

const legacyApproveModule = await import('@/app/api/v1/orchestration/approvals/[id]/approve/route');
const chatApproveModule =
  await import('@/app/api/v1/orchestration/approvals/[id]/approve/chat/route');
const chatRejectModule =
  await import('@/app/api/v1/orchestration/approvals/[id]/reject/chat/route');
const embedApproveModule =
  await import('@/app/api/v1/orchestration/approvals/[id]/approve/embed/route');
const embedRejectModule =
  await import('@/app/api/v1/orchestration/approvals/[id]/reject/embed/route');

/**
 * Build a NextRequest-shaped fake. We can't use the real NextRequest
 * constructor here because `Origin` is a forbidden request header in
 * the Fetch spec — both `new Request(url, { headers: { Origin: ... } })`
 * and `new Headers().set('Origin', ...)` silently drop the value. The
 * route handlers only touch `.headers.get`, `.text`, `.json`, and
 * `.nextUrl.searchParams`, so a partial stub is sufficient.
 */
function makeRequest(
  url: string,
  init: { method: string; origin?: string | null; body?: unknown } = { method: 'POST' }
): NextRequest {
  const u = new URL(url);
  const headers = new Map<string, string>([['content-type', 'application/json']]);
  if (init.origin === null) headers.set('origin', 'null');
  else if (init.origin) headers.set('origin', init.origin);
  const bodyStr = init.body ? JSON.stringify(init.body) : '';
  return {
    method: init.method,
    nextUrl: u,
    headers: { get: (name: string): string | null => headers.get(name.toLowerCase()) ?? null },
    text: (): Promise<string> => Promise.resolve(bodyStr),
    json: (): Promise<unknown> =>
      bodyStr ? Promise.resolve(JSON.parse(bodyStr)) : Promise.reject(new Error('no body')),
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerify.mockReturnValue({
    executionId: VALID_ID,
    action: 'approve',
    expiresAt: new Date('2030-01-01').toISOString(),
  });
  mockExecuteApproval.mockResolvedValue({
    success: true,
    executionId: VALID_ID,
    resumeStepId: null,
    workflowId: 'wf-1',
  });
  mockExecuteRejection.mockResolvedValue({ success: true, executionId: VALID_ID });
  mockGetSettings.mockResolvedValue({ embedAllowedOrigins: ['https://partner.com'] });
  mockResumeApprovedExecution.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('chat sub-routes (same-origin CORS)', () => {
  it('OPTIONS returns 204 with CORS headers when origin matches NEXT_PUBLIC_APP_URL', () => {
    const res = chatApproveModule.OPTIONS(
      makeRequest(`${APP_URL}/api/v1/orchestration/approvals/${VALID_ID}/approve/chat`, {
        method: 'OPTIONS',
        origin: APP_URL,
      })
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(APP_URL);
  });

  it('OPTIONS returns 403 when origin is null', () => {
    const res = chatApproveModule.OPTIONS(
      makeRequest(`${APP_URL}/api/v1/orchestration/approvals/${VALID_ID}/approve/chat`, {
        method: 'OPTIONS',
        origin: null,
      })
    );
    expect(res.status).toBe(403);
  });

  it('OPTIONS returns 403 when no origin header is present', () => {
    const res = chatApproveModule.OPTIONS(
      makeRequest(`${APP_URL}/api/v1/orchestration/approvals/${VALID_ID}/approve/chat`, {
        method: 'OPTIONS',
      })
    );
    expect(res.status).toBe(403);
  });

  it('OPTIONS returns 403 when origin is a foreign site', () => {
    const res = chatApproveModule.OPTIONS(
      makeRequest(`${APP_URL}/api/v1/orchestration/approvals/${VALID_ID}/approve/chat`, {
        method: 'OPTIONS',
        origin: 'https://attacker.com',
      })
    );
    expect(res.status).toBe(403);
  });

  it('POST /approve/chat passes actorLabel "token:chat" when origin matches', async () => {
    const res = await chatApproveModule.POST(
      makeRequest(`${APP_URL}/api/v1/orchestration/approvals/${VALID_ID}/approve/chat?token=t`, {
        method: 'POST',
        origin: APP_URL,
        body: {},
      }),
      { params: Promise.resolve({ id: VALID_ID }) }
    );
    expect(res.status).toBe(200);
    expect(mockExecuteApproval).toHaveBeenCalledWith(
      VALID_ID,
      expect.objectContaining({ actorLabel: 'token:chat' })
    );
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(APP_URL);
  });

  it('POST /approve/chat returns 403 from a foreign origin', async () => {
    const res = await chatApproveModule.POST(
      makeRequest(`${APP_URL}/api/v1/orchestration/approvals/${VALID_ID}/approve/chat?token=t`, {
        method: 'POST',
        origin: 'https://attacker.com',
        body: {},
      }),
      { params: Promise.resolve({ id: VALID_ID }) }
    );
    expect(res.status).toBe(403);
    expect(mockExecuteApproval).not.toHaveBeenCalled();
  });

  it('POST /approve/chat fire-and-forget triggers engine resumption', async () => {
    const res = await chatApproveModule.POST(
      makeRequest(`${APP_URL}/api/v1/orchestration/approvals/${VALID_ID}/approve/chat?token=t`, {
        method: 'POST',
        origin: APP_URL,
        body: {},
      }),
      { params: Promise.resolve({ id: VALID_ID }) }
    );
    expect(res.status).toBe(200);
    // Microtask may not have fired yet — flush.
    await Promise.resolve();
    expect(mockResumeApprovedExecution).toHaveBeenCalledWith(VALID_ID);
  });

  it('POST /reject/chat does NOT trigger resumption (rejection cancels, no engine work)', async () => {
    mockVerify.mockReturnValue({
      executionId: VALID_ID,
      action: 'reject',
      expiresAt: new Date('2030-01-01').toISOString(),
    });
    await chatRejectModule.POST(
      makeRequest(`${APP_URL}/api/v1/orchestration/approvals/${VALID_ID}/reject/chat?token=t`, {
        method: 'POST',
        origin: APP_URL,
        body: { reason: 'no' },
      }),
      { params: Promise.resolve({ id: VALID_ID }) }
    );
    await Promise.resolve();
    expect(mockResumeApprovedExecution).not.toHaveBeenCalled();
  });

  it('legacy /approve route does NOT trigger resumption (preserves email/Slack behaviour)', async () => {
    const res = await legacyApproveModule.POST(
      makeRequest(`${APP_URL}/api/v1/orchestration/approvals/${VALID_ID}/approve?token=t`, {
        method: 'POST',
        body: {},
      }),
      { params: Promise.resolve({ id: VALID_ID }) }
    );
    expect(res.status).toBe(200);
    await Promise.resolve();
    expect(mockResumeApprovedExecution).not.toHaveBeenCalled();
    expect(mockExecuteApproval).toHaveBeenCalledWith(
      VALID_ID,
      expect.objectContaining({ actorLabel: 'token:external' })
    );
  });

  it('POST /reject/chat passes actorLabel "token:chat"', async () => {
    mockVerify.mockReturnValue({
      executionId: VALID_ID,
      action: 'reject',
      expiresAt: new Date('2030-01-01').toISOString(),
    });
    const res = await chatRejectModule.POST(
      makeRequest(`${APP_URL}/api/v1/orchestration/approvals/${VALID_ID}/reject/chat?token=t`, {
        method: 'POST',
        origin: APP_URL,
        body: { reason: 'no' },
      }),
      { params: Promise.resolve({ id: VALID_ID }) }
    );
    expect(res.status).toBe(200);
    expect(mockExecuteRejection).toHaveBeenCalledWith(
      VALID_ID,
      expect.objectContaining({ actorLabel: 'token:chat' })
    );
  });
});

describe('embed sub-routes (allowlist CORS)', () => {
  it('OPTIONS returns 204 when origin is in embedAllowedOrigins', async () => {
    const res = await embedApproveModule.OPTIONS(
      makeRequest(`${APP_URL}/api/v1/orchestration/approvals/${VALID_ID}/approve/embed`, {
        method: 'OPTIONS',
        origin: 'https://partner.com',
      })
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://partner.com');
  });

  it('OPTIONS returns 403 when origin is not in embedAllowedOrigins', async () => {
    const res = await embedApproveModule.OPTIONS(
      makeRequest(`${APP_URL}/api/v1/orchestration/approvals/${VALID_ID}/approve/embed`, {
        method: 'OPTIONS',
        origin: 'https://nopartner.com',
      })
    );
    expect(res.status).toBe(403);
  });

  it('OPTIONS returns 403 when embedAllowedOrigins is the default empty array', async () => {
    mockGetSettings.mockResolvedValueOnce({ embedAllowedOrigins: [] });
    const res = await embedApproveModule.OPTIONS(
      makeRequest(`${APP_URL}/api/v1/orchestration/approvals/${VALID_ID}/approve/embed`, {
        method: 'OPTIONS',
        origin: 'https://anywhere.com',
      })
    );
    expect(res.status).toBe(403);
  });

  it('POST /approve/embed fire-and-forget triggers engine resumption', async () => {
    const res = await embedApproveModule.POST(
      makeRequest(`${APP_URL}/api/v1/orchestration/approvals/${VALID_ID}/approve/embed?token=t`, {
        method: 'POST',
        origin: 'https://partner.com',
        body: {},
      }),
      { params: Promise.resolve({ id: VALID_ID }) }
    );
    expect(res.status).toBe(200);
    await Promise.resolve();
    expect(mockResumeApprovedExecution).toHaveBeenCalledWith(VALID_ID);
  });

  it('POST /approve/embed pins actorLabel "token:embed" when origin is allowlisted', async () => {
    const res = await embedApproveModule.POST(
      makeRequest(`${APP_URL}/api/v1/orchestration/approvals/${VALID_ID}/approve/embed?token=t`, {
        method: 'POST',
        origin: 'https://partner.com',
        body: {},
      }),
      { params: Promise.resolve({ id: VALID_ID }) }
    );
    expect(res.status).toBe(200);
    expect(mockExecuteApproval).toHaveBeenCalledWith(
      VALID_ID,
      expect.objectContaining({ actorLabel: 'token:embed' })
    );
  });

  it('POST /approve/embed returns 403 when origin is null', async () => {
    const res = await embedApproveModule.POST(
      makeRequest(`${APP_URL}/api/v1/orchestration/approvals/${VALID_ID}/approve/embed?token=t`, {
        method: 'POST',
        origin: null,
        body: {},
      }),
      { params: Promise.resolve({ id: VALID_ID }) }
    );
    expect(res.status).toBe(403);
    expect(mockExecuteApproval).not.toHaveBeenCalled();
  });

  it('POST /reject/embed pins actorLabel "token:embed" when allowlisted', async () => {
    mockVerify.mockReturnValue({
      executionId: VALID_ID,
      action: 'reject',
      expiresAt: new Date('2030-01-01').toISOString(),
    });
    const res = await embedRejectModule.POST(
      makeRequest(`${APP_URL}/api/v1/orchestration/approvals/${VALID_ID}/reject/embed?token=t`, {
        method: 'POST',
        origin: 'https://partner.com',
        body: { reason: 'no' },
      }),
      { params: Promise.resolve({ id: VALID_ID }) }
    );
    expect(res.status).toBe(200);
    expect(mockExecuteRejection).toHaveBeenCalledWith(
      VALID_ID,
      expect.objectContaining({ actorLabel: 'token:embed' })
    );
  });
});
