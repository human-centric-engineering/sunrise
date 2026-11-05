/**
 * Unit tests: POST /api/v1/waitlist/leave (§125 t-977)
 *
 * The leave logic is mocked (tested in tests/unit/lib/waitlist/confirm.test.ts).
 * What is tested here: each outcome's answer, and that leaving works with no
 * waitlist config — no switch may stop someone leaving.
 *
 * @see app/api/v1/waitlist/leave/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { WaitlistConfig } from '@/lib/waitlist/config';

const { mockLeave } = vi.hoisted(() => ({ mockLeave: vi.fn() }));
vi.mock('@/lib/waitlist/confirm', () => ({ leaveWaitlist: mockLeave }));

async function loadRoute(config: WaitlistConfig | null) {
  vi.resetModules();
  vi.doMock('@/lib/app/waitlist-config', () => ({ waitlistConfig: config }));
  const route = await import('@/app/api/v1/waitlist/leave/route');
  const { __resetWaitlistConfigForTests } = await import('@/lib/waitlist/config');
  __resetWaitlistConfigForTests();
  return route;
}

function post(body: unknown): NextRequest {
  return new Request('http://localhost:3000/api/v1/waitlist/leave', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLeave.mockResolvedValue('left');
});

describe('POST /api/v1/waitlist/leave', () => {
  it('takes the person off the list, with the shipped (empty) config too', async () => {
    // Arrange — the config a fork that dropped its waitlist would have
    const { POST } = await loadRoute(null);

    // Act
    const res = await POST(post({ token: 'signed.token' }));

    // Assert
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { left: true } });
    expect(mockLeave).toHaveBeenCalledWith('signed.token');
  });

  it('answers 400 for a token that is not ours, and for a body with none', async () => {
    mockLeave.mockResolvedValue('invalid');
    const { POST } = await loadRoute({ consentVersion: 'v1' });

    const forged = await POST(post({ token: 'forged.token' }));
    const missing = await POST(post({}));
    const garbage = await POST(post('not json'));

    for (const res of [forged, missing, garbage]) {
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: 'INVALID_TOKEN' } });
    }
    expect(mockLeave).toHaveBeenCalledTimes(1);
  });

  it('answers 503 when the entry’s org cannot be entered, rather than claiming it left', async () => {
    mockLeave.mockResolvedValue('unavailable');
    const { POST } = await loadRoute({ consentVersion: 'v1' });

    const res = await POST(post({ token: 'signed.token' }));

    expect(res.status).toBe(503);
  });
});
