/**
 * Tests: POST /api/v1/admin/waitlist/:id/invite (§125 t-978)
 *
 * The route's own work: the config gate, the limiter before any read, the id
 * check, the refusal-to-status mapping, the response (no link), and the audit
 * action. Whether an entry may be invited is `inviteWaitlistEntry()`'s.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  DEFAULT_WAITLIST_JOIN_PATH,
  DEFAULT_WAITLIST_RETENTION,
  type ResolvedWaitlistConfig,
} from '@/lib/waitlist/config';
import type { WaitlistInviteRefusal } from '@/lib/waitlist/invite';

const { mockConfig, mockInvite, mockLimiter, mockAudit, mockLog } = vi.hoisted(() => {
  const mockConfig: { current: ResolvedWaitlistConfig | null } = { current: null };
  return {
    mockConfig,
    mockInvite: vi.fn(),
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
vi.mock('@/lib/waitlist/invite', () => ({ inviteWaitlistEntry: mockInvite }));
vi.mock('@/lib/security/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/security/rate-limit')>()),
  inviteLimiter: mockLimiter,
}));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.9') }));
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({ logAdminAction: mockAudit }));
vi.mock('@/lib/api/context', () => ({ getRouteLogger: vi.fn().mockResolvedValue(mockLog) }));

import { auth } from '@/lib/auth/config';
import { mockAdminUser, mockAuthenticatedUser } from '@/tests/helpers/auth';
import { WAITLIST_INVITE_REFUSAL_MESSAGES } from '@/lib/waitlist/invite-refusals';
import { POST } from '@/app/api/v1/admin/waitlist/[id]/invite/route';

const CONFIG: ResolvedWaitlistConfig = {
  consentVersion: 'v1',
  fields: [],
  lists: [{ key: 'default' }],
  screen: null,
  retention: DEFAULT_WAITLIST_RETENTION,
  joinPath: DEFAULT_WAITLIST_JOIN_PATH,
};
const ID = 'cmw0s7r0x000q08le5j01nd17';
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const EXPIRES = new Date('2026-11-12T10:00:00Z');
const ENTRY = { id: ID, email: 'ada@example.com', name: 'Ada', list: 'default', invitedAt: null };
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });
const post = () =>
  new NextRequest(`http://localhost:3000/api/v1/admin/waitlist/${ID}/invite`, { method: 'POST' });

type Body = {
  success: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details?: Record<string, unknown> };
};
const json = async (r: Response) => (await r.json()) as Body;

/** Everything this route wrote to the logs and the audit trail, as one string. */
function everythingLogged(): string {
  return JSON.stringify([
    mockAudit.mock.calls,
    mockLog.info.mock.calls,
    mockLog.warn.mock.calls,
    mockLog.error.mock.calls,
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.current = CONFIG;
  vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  mockLimiter.check.mockReturnValue({ success: true, remaining: 9, reset: 0 });
  mockInvite.mockResolvedValue({
    outcome: 'invited',
    entry: ENTRY,
    emailStatus: 'sent',
    expiresAt: EXPIRES,
  });
});

describe('POST /api/v1/admin/waitlist/:id/invite', () => {
  it('answers 404 while the app has no waitlist, before the limiter or any read', async () => {
    mockConfig.current = null;

    expect((await POST(post(), ctx())).status).toBe(404);
    expect(mockLimiter.check).not.toHaveBeenCalled();
    expect(mockInvite).not.toHaveBeenCalled();
  });

  it('answers 403 to a non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    expect((await POST(post(), ctx())).status).toBe(403);
    expect(mockInvite).not.toHaveBeenCalled();
  });

  it('checks inviteLimiter on the client IP before reading anything, and answers 429 when over', async () => {
    mockLimiter.check.mockReturnValue({ success: false, remaining: 0, reset: 4_102_444_800 });

    const response = await POST(post(), ctx());

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).not.toBeNull();
    expect(mockLimiter.check).toHaveBeenCalledWith('203.0.113.9');
    expect(mockInvite).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('is limited before the id is even checked', async () => {
    mockLimiter.check.mockReturnValue({ success: false, remaining: 0, reset: 4_102_444_800 });

    expect((await POST(post(), ctx('not-a-cuid'))).status).toBe(429);
  });

  it('refuses a malformed id with a 400 before inviting', async () => {
    const response = await POST(post(), ctx('not-a-cuid'));

    expect(response.status).toBe(400);
    expect((await json(response)).error?.code).toBe('VALIDATION_ERROR');
    expect(mockInvite).not.toHaveBeenCalled();
  });

  it('invites the entry as the signed-in admin', async () => {
    await POST(post(), ctx());

    expect(mockInvite).toHaveBeenCalledWith({
      entryId: ID,
      inviter: { id: ADMIN_ID, name: 'Test User' },
      log: mockLog,
    });
  });

  it('answers 201 with the entry, outcome, emailStatus and an ISO expiresAt — and no link', async () => {
    const response = await POST(post(), ctx());
    const body = await json(response);

    expect(response.status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.data).toEqual({
      entry: ENTRY,
      outcome: 'invited',
      emailStatus: 'sent',
      expiresAt: '2026-11-12T10:00:00.000Z',
    });
    expect(JSON.stringify(body)).not.toMatch(/link|token|accept-invite/i);
  });

  it('reports a failed email as 201 with emailStatus failed', async () => {
    mockInvite.mockResolvedValue({
      outcome: 'invited',
      entry: ENTRY,
      emailStatus: 'failed',
      expiresAt: EXPIRES,
    });

    const response = await POST(post(), ctx());

    expect(response.status).toBe(201);
    expect((await json(response)).data?.emailStatus).toBe('failed');
  });

  it('audits waitlist_entry.invite for a first invitation', async () => {
    await POST(post(), ctx());

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: ADMIN_ID,
        action: 'waitlist_entry.invite',
        entityType: 'waitlist_entry',
        entityId: ID,
        entityName: 'default',
        metadata: { emailStatus: 'sent' },
        clientIp: '203.0.113.9',
      })
    );
  });

  it('audits waitlist_entry.reinvite for a resend', async () => {
    mockInvite.mockResolvedValue({
      outcome: 'resent',
      entry: ENTRY,
      emailStatus: 'sent',
      expiresAt: EXPIRES,
    });

    const response = await POST(post(), ctx());

    expect((await json(response)).data?.outcome).toBe('resent');
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'waitlist_entry.reinvite' })
    );
    expect(mockAudit).toHaveBeenCalledTimes(1);
  });

  it('answers 404 for an entry this org does not have, and audits nothing', async () => {
    mockInvite.mockResolvedValue({ outcome: 'refused', reason: 'not_found' });

    const response = await POST(post(), ctx());

    expect(response.status).toBe(404);
    expect((await json(response)).error?.code).toBe('NOT_FOUND');
    expect(mockAudit).not.toHaveBeenCalled();
  });

  const REFUSALS: WaitlistInviteRefusal[] = [
    'removed',
    'joined',
    'unconfirmed',
    'flagged',
    'account_exists',
    'invitation_pending',
    'changed',
  ];

  it.each(REFUSALS)('answers 409 for %s, with the reason and its message', async (reason) => {
    mockInvite.mockResolvedValue({ outcome: 'refused', reason });

    const response = await POST(post(), ctx());
    const body = await json(response);

    expect(response.status).toBe(409);
    expect(body.success).toBe(false);
    expect(body.error?.message).toBe(WAITLIST_INVITE_REFUSAL_MESSAGES[reason]);
    expect(body.error?.details).toEqual({ reason });
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('gives each refusal its own message', () => {
    const messages = REFUSALS.map((r) => WAITLIST_INVITE_REFUSAL_MESSAGES[r]);
    expect(new Set(messages).size).toBe(REFUSALS.length);
  });

  it('logs and audits neither the address nor the name', async () => {
    await POST(post(), ctx());
    mockInvite.mockResolvedValue({ outcome: 'refused', reason: 'flagged' });
    await POST(post(), ctx());

    expect(everythingLogged()).not.toContain('ada@example.com');
    expect(everythingLogged()).not.toContain('Ada');
  });
});
