/**
 * Guard Test: what getRouteLogger binds to every log line (#685)
 *
 * The logger redacts by key name only, so whatever lands in the bound context
 * is logged verbatim. These tests run the real `getRouteLogger` →
 * `getFullContext` → `getEndpointPath` chain (only `next/headers` and the
 * session are stubbed) and assert on the object handed to `withContext` — not
 * on the log fields, which is the assertion that passed while a route path
 * token was leaking through the context.
 *
 * @see lib/api/context.ts
 * @see lib/logging/context.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// tests/setup.ts mocks this module globally; exercise the real one.
vi.unmock('@/lib/api/context');

vi.mock('next/headers', () => ({
  headers: vi.fn(),
}));

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

import { headers } from 'next/headers';
import { auth } from '@/lib/auth/config';
import { getRouteLogger } from '@/lib/api/context';
import { logger } from '@/lib/logging';

const TOKEN = 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z'; // 32-char base64url
const EMAIL = 'ada@example.com';

function leakyRequest(): Request {
  return new Request(
    `http://localhost:3000/api/v1/share/public/${TOKEN}?token=${TOKEN}&email=${encodeURIComponent(EMAIL)}`,
    { method: 'GET' }
  );
}

describe('getRouteLogger bound context (#685)', () => {
  beforeEach(() => {
    vi.mocked(headers).mockResolvedValue(new Headers({ 'x-request-id': 'req-guard' }));
    vi.mocked(auth.api.getSession).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('binds no url, no token and no email, and collapses the endpoint', async () => {
    const withContext = vi.spyOn(logger, 'withContext');

    await getRouteLogger(leakyRequest());

    expect(withContext).toHaveBeenCalledTimes(1);
    const bound = withContext.mock.calls[0][0];
    expect(bound).not.toHaveProperty('url');
    expect(bound.endpoint).toBe('/api/v1/share/public/[param]');
    expect(bound.method).toBe('GET');
    expect(bound.requestId).toBe('req-guard');
    const serialised = JSON.stringify(bound);
    expect(serialised).not.toContain(TOKEN);
    expect(serialised).not.toContain(EMAIL);
    expect(serialised).not.toContain(encodeURIComponent(EMAIL));
  });

  it('uses a pinned endpoint pattern verbatim', async () => {
    const withContext = vi.spyOn(logger, 'withContext');

    await getRouteLogger(leakyRequest(), { endpoint: '/api/v1/share/public/[token]' });

    const bound = withContext.mock.calls[0][0];
    expect(bound.endpoint).toBe('/api/v1/share/public/[token]');
    expect(bound).not.toHaveProperty('url');
    expect(JSON.stringify(bound)).not.toContain(TOKEN);
  });
});
