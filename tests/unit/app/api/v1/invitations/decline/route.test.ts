/**
 * Unit Tests: POST /api/v1/invitations/decline (#1199, t-1006)
 *
 * Public and token-gated. What `declineInvitation` deletes is its own test
 * file's; here, the route passes the normalised address and token, maps a
 * miss to 404, and is rate limited.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { NotFoundError } from '@/lib/api/errors';

const mockDecline = vi.hoisted(() => vi.fn());
vi.mock('@/lib/tenancy/accept-invitation', () => ({ declineInvitation: mockDecline }));

const mockLimiter = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock('@/lib/security/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/security/rate-limit')>()),
  acceptInviteLimiter: mockLimiter,
}));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/api/context', () => ({ getRouteLogger: vi.fn(async () => mockLog) }));

import { POST } from '@/app/api/v1/invitations/decline/route';

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/v1/invitations/decline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }) as unknown as NextRequest
  );
}

describe('POST /api/v1/invitations/decline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLimiter.check.mockReturnValue({ success: true, limit: 10, remaining: 9, reset: 0 });
    mockDecline.mockResolvedValue(undefined);
  });

  it('declines the invitation the token names, with no session', async () => {
    const res = await post({ token: 'tok', email: ' Pat@Example.com' });

    expect(res.status).toBe(200);
    expect(mockDecline).toHaveBeenCalledWith('pat@example.com', 'tok');
  });

  it('answers 404 when there is nothing to decline', async () => {
    mockDecline.mockRejectedValue(new NotFoundError('Invitation not found'));

    const res = await post({ token: 'tok', email: 'pat@example.com' });

    expect(res.status).toBe(404);
  });

  it('is rate limited per IP', async () => {
    mockLimiter.check.mockReturnValue({ success: false, limit: 10, remaining: 0, reset: 0 });

    const res = await post({ token: 'tok', email: 'pat@example.com' });

    expect(res.status).toBe(429);
    expect(mockDecline).not.toHaveBeenCalled();
  });

  it('rejects a body without a token', async () => {
    const res = await post({ email: 'pat@example.com' });

    expect(res.status).toBe(400);
    expect(mockDecline).not.toHaveBeenCalled();
  });
});
