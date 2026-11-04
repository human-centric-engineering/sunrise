/**
 * Unit tests: POST /api/v1/waitlist/confirm (§125 t-977)
 *
 * The confirm logic is mocked (tested in tests/unit/lib/waitlist/confirm.test.ts);
 * what is tested here is the one answer every unusable link gets, compared
 * byte for byte, and that the route does not exist without a waitlist.
 *
 * @see app/api/v1/waitlist/confirm/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { WaitlistConfig } from '@/lib/waitlist/config';

const { mockConfirm } = vi.hoisted(() => ({ mockConfirm: vi.fn() }));
vi.mock('@/lib/waitlist/confirm', () => ({ confirmWaitlistEntry: mockConfirm }));

const CONFIG: WaitlistConfig = { consentVersion: 'v1' };
const TOKEN = 'b'.repeat(64);

async function loadRoute(config: WaitlistConfig | null) {
  vi.resetModules();
  vi.doMock('@/lib/app/waitlist-config', () => ({ waitlistConfig: config }));
  const route = await import('@/app/api/v1/waitlist/confirm/route');
  const { __resetWaitlistConfigForTests } = await import('@/lib/waitlist/config');
  __resetWaitlistConfigForTests();
  return route;
}

function post(body: unknown): NextRequest {
  return new Request('http://localhost:3000/api/v1/waitlist/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }) as unknown as NextRequest;
}

async function snapshot(res: Response) {
  return { status: res.status, body: await res.text(), headers: [...res.headers.entries()].sort() };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfirm.mockResolvedValue('confirmed');
});

describe('POST /api/v1/waitlist/confirm', () => {
  it('confirms with the entry and token from the body', async () => {
    const { POST } = await loadRoute(CONFIG);

    const res = await POST(post({ entry: 'entry-1', token: TOKEN }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { confirmed: true } });
    expect(mockConfirm).toHaveBeenCalledWith('entry-1', TOKEN);
  });

  it('gives an expired, used, unknown or malformed link one answer', async () => {
    // Arrange — the confirm logic answers `invalid` for expired, used and unknown alike
    mockConfirm.mockResolvedValue('invalid');
    const { POST } = await loadRoute(CONFIG);

    // Act
    const answers = [
      await snapshot(await POST(post({ entry: 'entry-1', token: TOKEN }))),
      await snapshot(await POST(post({ entry: 'entry-1', token: 'short' }))),
      await snapshot(await POST(post({ token: TOKEN }))),
      await snapshot(await POST(post('not json'))),
    ];

    // Assert
    expect(answers[0].status).toBe(400);
    expect(JSON.parse(answers[0].body)).toMatchObject({ error: { code: 'INVALID_TOKEN' } });
    for (const a of answers) expect(a).toEqual(answers[0]);
    // Malformed links never reach the lookup
    expect(mockConfirm).toHaveBeenCalledTimes(1);
  });

  it('answers 404 when the app has no waitlist, and confirms nothing', async () => {
    const { POST } = await loadRoute(null);

    const res = await POST(post({ entry: 'entry-1', token: TOKEN }));

    expect(res.status).toBe(404);
    expect(mockConfirm).not.toHaveBeenCalled();
  });
});
