/**
 * Tests: POST /api/v1/admin/waitlist/invite (§125 t-978)
 *
 * The route's own work: the config gate, the per-admin wave limiter, the body
 * schema, handing the chosen ids to the wave, and the audit. Choosing and
 * inviting are `lib/waitlist/invite.ts`'s.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  DEFAULT_WAITLIST_JOIN_PATH,
  DEFAULT_WAITLIST_RETENTION,
  type ResolvedWaitlistConfig,
} from '@/lib/waitlist/config';

const { mockConfig, mockSelect, mockWave, mockLimiter, mockAudit, mockLog } = vi.hoisted(() => {
  const mockConfig: { current: ResolvedWaitlistConfig | null } = { current: null };
  return {
    mockConfig,
    mockSelect: vi.fn(),
    mockWave: vi.fn(),
    mockLimiter: { check: vi.fn() },
    mockAudit: vi.fn(),
    mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));
vi.mock('@/lib/waitlist/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/waitlist/config')>()),
  getWaitlistConfig: () => mockConfig.current,
}));
vi.mock('@/lib/waitlist/invite', () => ({
  selectWaveEntries: mockSelect,
  inviteWaitlistWave: mockWave,
}));
vi.mock('@/lib/security/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/security/rate-limit')>()),
  waitlistInviteWaveLimiter: mockLimiter,
}));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.9') }));
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({ logAdminAction: mockAudit }));
vi.mock('@/lib/api/context', () => ({ getRouteLogger: vi.fn().mockResolvedValue(mockLog) }));

import { auth } from '@/lib/auth/config';
import { mockAdminUser, mockAuthenticatedUser } from '@/tests/helpers/auth';
import { POST } from '@/app/api/v1/admin/waitlist/invite/route';

const CONFIG: ResolvedWaitlistConfig = {
  consentVersion: 'v1',
  fields: [],
  lists: [{ key: 'default' }],
  screen: null,
  retention: DEFAULT_WAITLIST_RETENTION,
  joinPath: DEFAULT_WAITLIST_JOIN_PATH,
};
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';

const WAVE_RESULT = {
  selected: 3,
  invited: 2,
  refused: 1,
  failed: 0,
  emailNotSent: 1,
  rows: [
    { id: 'a', outcome: 'invited', emailStatus: 'sent' },
    { id: 'b', outcome: 'resent', emailStatus: 'failed' },
    { id: 'c', outcome: 'refused', reason: 'removed' },
  ],
};

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/admin/waitlist/invite', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}
type Body = { success: boolean; data?: unknown; error?: { code: string } };
const json = async (r: Response) => (await r.json()) as Body;

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.current = CONFIG;
  vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  mockLimiter.check.mockReturnValue({ success: true, remaining: 4, reset: 0 });
  mockSelect.mockResolvedValue(['a', 'b', 'c']);
  mockWave.mockResolvedValue(WAVE_RESULT);
});

describe('POST /api/v1/admin/waitlist/invite', () => {
  it('answers 404 while the app has no waitlist, before the limiter', async () => {
    mockConfig.current = null;

    expect((await post0()).status).toBe(404);
    expect(mockLimiter.check).not.toHaveBeenCalled();
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('answers 403 to a non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    expect((await post0()).status).toBe(403);
    expect(mockWave).not.toHaveBeenCalled();
  });

  it('limits waves per admin, and answers 429 before inviting anyone', async () => {
    mockLimiter.check.mockReturnValue({ success: false, remaining: 0, reset: 4_102_444_800 });

    const response = await POST(post({ mode: 'next', count: 5 }));

    expect(response.status).toBe(429);
    expect(mockLimiter.check).toHaveBeenCalledWith(`waitlist-wave:user:${ADMIN_ID}`);
    expect(mockWave).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('spends a wave only after choosing someone, and before inviting them', async () => {
    await POST(post({ mode: 'next', count: 5 }));

    expect(mockLimiter.check).toHaveBeenCalledTimes(1);
    expect(mockSelect.mock.invocationCallOrder[0]).toBeLessThan(
      mockLimiter.check.mock.invocationCallOrder[0]
    );
    expect(mockLimiter.check.mock.invocationCallOrder[0]).toBeLessThan(
      mockWave.mock.invocationCallOrder[0]
    );
  });

  it('does not spend a wave on one that chose nobody', async () => {
    mockSelect.mockResolvedValue([]);
    mockWave.mockResolvedValue({
      selected: 0,
      invited: 0,
      refused: 0,
      failed: 0,
      emailNotSent: 0,
      rows: [],
    });

    expect((await POST(post({ mode: 'next', count: 5 }))).status).toBe(200);
    expect(mockLimiter.check).not.toHaveBeenCalled();
  });

  it.each([
    ['a count over 50', { mode: 'next', count: 51 }],
    ['a count of 0', { mode: 'sample', count: 0 }],
    ['more than 50 ids', { mode: 'ids', ids: Array.from({ length: 51 }, (_, i) => `id-${i}`) }],
    ['no ids', { mode: 'ids', ids: [] }],
    ['an unknown mode', { mode: 'everyone', count: 5 }],
    ['an extra key', { mode: 'next', count: 5, role: 'ADMIN' }],
    ['no mode', { count: 5 }],
  ])('refuses %s with a 400 before choosing anyone, spending no wave', async (_label, body) => {
    const response = await POST(post(body));

    expect(response.status).toBe(400);
    expect((await json(response)).error?.code).toBe('VALIDATION_ERROR');
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockWave).not.toHaveBeenCalled();
    expect(mockLimiter.check).not.toHaveBeenCalled();
  });

  it('selects with the config and the parsed body, then invites the ids it chose as the admin', async () => {
    mockSelect.mockResolvedValue(['x', 'y']);

    await POST(post({ mode: 'next', count: 2, list: 'default' }));

    expect(mockSelect).toHaveBeenCalledWith(CONFIG, { mode: 'next', count: 2, list: 'default' });
    expect(mockWave).toHaveBeenCalledWith({
      ids: ['x', 'y'],
      inviter: { id: ADMIN_ID, name: 'Test User' },
      log: mockLog,
    });
  });

  it('answers 200 with the wave’s result', async () => {
    const response = await POST(post({ mode: 'ids', ids: ['a', 'b', 'c'] }));
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual(WAVE_RESULT);
  });

  it('audits the wave with its counts and the ids invited (resent included, refused not)', async () => {
    await POST(post({ mode: 'sample', count: 3, list: 'default' }));

    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: ADMIN_ID,
        action: 'waitlist.invite_wave',
        entityType: 'waitlist_entry',
        entityId: null,
        entityName: 'default',
        clientIp: '203.0.113.9',
        metadata: {
          mode: 'sample',
          selected: 3,
          invited: 2,
          refused: 1,
          failed: 0,
          emailNotSent: 1,
          invitedIds: ['a', 'b'],
        },
      })
    );
  });

  it('names no list in the audit for an ids wave', async () => {
    await POST(post({ mode: 'ids', ids: ['a'] }));

    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ entityName: null }));
  });

  it('audits nothing, and answers selected: 0, when the wave chose nobody', async () => {
    const empty = { selected: 0, invited: 0, refused: 0, failed: 0, emailNotSent: 0, rows: [] };
    mockSelect.mockResolvedValue([]);
    mockWave.mockResolvedValue(empty);

    const response = await POST(post({ mode: 'next', count: 5 }));

    expect(response.status).toBe(200);
    expect((await json(response)).data).toEqual(empty);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('logs and audits no address', async () => {
    await POST(post({ mode: 'ids', ids: ['a'] }));

    const everything = JSON.stringify([mockAudit.mock.calls, mockLog.info.mock.calls]);
    expect(everything).not.toMatch(/@/);
  });
});

function post0(): Promise<Response> {
  return POST(post({ mode: 'next', count: 1 }));
}
