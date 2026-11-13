/**
 * Tests: GET /api/v1/admin/config-health
 *
 * Admin-only report of missing critical configuration. Presence booleans only — never values.
 *
 * @see app/api/v1/admin/config-health/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// The route logs via a route-scoped logger from getRouteLogger(request), not the module logger.
const routeLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/api/context', () => ({ getRouteLogger: vi.fn(async () => routeLog) }));
vi.mock('@/lib/config-health/run', () => ({ runConfigHealthChecks: vi.fn() }));

import { auth } from '@/lib/auth/config';
import { runConfigHealthChecks } from '@/lib/config-health/run';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';
import { GET } from '@/app/api/v1/admin/config-health/route';

type Mock = ReturnType<typeof vi.fn>;

const REPORT = {
  environment: 'production' as const,
  platform: 'vercel' as const,
  checks: [
    {
      key: 'CRON_SECRET',
      label: 'Maintenance cron secret',
      severity: 'critical' as const,
      description: 'x',
      remediation: 'y',
      present: false,
      applicable: true,
    },
  ],
  summary: { critical: 1, warning: 0, info: 0, ok: 2 },
};

function req(): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/admin/config-health', { method: 'GET' });
}
async function parse<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  (runConfigHealthChecks as Mock).mockResolvedValue(REPORT);
});

describe('GET /api/v1/admin/config-health', () => {
  it('returns 401 when unauthenticated and does not run the checks', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(runConfigHealthChecks).not.toHaveBeenCalled();
  });

  it('returns 403 for an authenticated non-admin and does not run the checks', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(runConfigHealthChecks).not.toHaveBeenCalled();
  });

  it('returns the report for an admin', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await parse<{ success: boolean; data: typeof REPORT }>(res);
    expect(body.success).toBe(true);
    expect(body.data.summary.critical).toBe(1);
    expect(body.data.checks[0].key).toBe('CRON_SECRET');
  });

  it('logs counts only, never a value', async () => {
    await GET(req());
    expect(routeLog.info).toHaveBeenCalledWith(
      'Config health checked',
      expect.objectContaining({ environment: 'production', platform: 'vercel', critical: 1 })
    );
    // The log payload must not carry the raw checks array (which could grow to hold values).
    const payload = (routeLog.info as Mock).mock.calls.find(
      (c) => c[0] === 'Config health checked'
    )![1];
    expect(payload).not.toHaveProperty('checks');
  });
});
