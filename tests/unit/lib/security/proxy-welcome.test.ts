/**
 * Unit Test: the proxy's welcome redirect (§134 t-1063)
 *
 * With a welcome route set in `lib/app/welcome.ts`, a signed-in request is
 * handed to `welcomeRedirectFor()` and redirected where it says. With none
 * set, the proxy never asks, which is what keeps the seam behaviour-neutral at
 * rest. The decision itself (landing route only, members of unfinished orgs
 * only) is tested in tests/unit/lib/tenancy/onboarding.test.ts; here it is
 * mocked, and these cases are the wiring.
 *
 * Separate from proxy.test.ts because `AUTH_WELCOME_ROUTE` is resolved at
 * module load, so the seam value has to be mocked before `@/proxy` loads.
 *
 * @see proxy.ts · lib/tenancy/onboarding.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/logging/context', () => ({
  generateRequestId: vi.fn(() => 'test-request-id-123'),
}));
vi.mock('@/lib/security/headers', () => ({ setSecurityHeaders: vi.fn() }));
vi.mock('@/lib/security/rate-limit-middleware', () => ({
  applyRateLimit: vi.fn(async () => null),
}));
vi.mock('@/lib/app/welcome', () => ({ appWelcomeRoute: '/welcome' }));

const mockWelcomeRedirectFor = vi.hoisted(() => vi.fn());
vi.mock('@/lib/tenancy/onboarding', () => ({ welcomeRedirectFor: mockWelcomeRedirectFor }));

import { proxy } from '@/proxy';
import { __resetTenantResolverForTests, registerTenantResolver } from '@/lib/tenancy/resolver';

const SESSION_COOKIE = { 'better-auth.session_token': 'valid-session-token' };

function createMockRequest(
  pathname: string,
  options: { cookies?: Record<string, string>; method?: string } = {}
): NextRequest {
  const url = `http://localhost:3000${pathname}`;
  const { cookies = {}, method = 'GET' } = options;
  return {
    nextUrl: new URL(url),
    url,
    method,
    headers: new Map<string, string>(),
    cookies: {
      get: (name: string) => (cookies[name] ? { name, value: cookies[name] } : undefined),
    },
  } as unknown as NextRequest;
}

describe('proxy — welcome redirect, welcome route set', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWelcomeRedirectFor.mockResolvedValue(null);
  });

  afterEach(() => {
    __resetTenantResolverForTests();
  });

  it('redirects a signed-in request to where welcomeRedirectFor says', async () => {
    mockWelcomeRedirectFor.mockResolvedValue('/welcome');
    const request = createMockRequest('/dashboard', { cookies: SESSION_COOKIE });

    const response = await proxy(request);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3000/welcome');
    expect(response.headers.get('x-request-id')).toBe('test-request-id-123');
    expect(mockWelcomeRedirectFor).toHaveBeenCalledWith(request, null);
  });

  it('lets the request through when welcomeRedirectFor answers null', async () => {
    const response = await proxy(createMockRequest('/dashboard', { cookies: SESSION_COOKIE }));

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(mockWelcomeRedirectFor).toHaveBeenCalledTimes(1);
  });

  it('passes the org the tenant resolver names, not a client header', async () => {
    registerTenantResolver(() => 'org_acme');
    const request = createMockRequest('/dashboard', { cookies: SESSION_COOKIE });

    await proxy(request);

    expect(mockWelcomeRedirectFor).toHaveBeenCalledWith(request, 'org_acme');
  });

  it('does not ask for a request with no session cookie', async () => {
    const response = await proxy(createMockRequest('/'));

    expect(response.status).toBe(200);
    expect(mockWelcomeRedirectFor).not.toHaveBeenCalled();
  });
});

describe('proxy — welcome redirect, no welcome route set (the shipped default)', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doMock('@/lib/app/welcome', () => ({ appWelcomeRoute: '/welcome' }));
  });

  it('never asks, so nothing is read and nobody is redirected', async () => {
    vi.resetModules();
    vi.doMock('@/lib/app/welcome', () => ({ appWelcomeRoute: null }));
    const { proxy: freshProxy } = await import('@/proxy');
    mockWelcomeRedirectFor.mockClear();
    mockWelcomeRedirectFor.mockResolvedValue('/welcome');

    const response = await freshProxy(createMockRequest('/dashboard', { cookies: SESSION_COOKIE }));

    expect(response.status).toBe(200);
    expect(mockWelcomeRedirectFor).not.toHaveBeenCalled();
  });
});
