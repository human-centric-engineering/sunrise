/**
 * Post-auth landing resolver (issue #473)
 *
 * `AUTH_LANDING_ROUTE` / `AUTH_LANDING_LABEL` resolve the fork seam
 * (`lib/app/auth-landing.ts`) against the platform defaults once, at module
 * load. These cases pin the default a fork inherits, the override path, and the
 * root-relative guard.
 *
 * The guard is the case worth having: the resolved value is spliced into
 * redirects and, at the login/OAuth sites, passed to `safeCallbackUrl()` as the
 * *fallback* — which that helper does not validate (it only sanitises the
 * untrusted URL). An absolute or protocol-relative seam value would therefore
 * redirect authenticated users off-site, so it throws rather than falling back.
 *
 * Resolution happens at module load, so each case stubs the scaffold via
 * `vi.doMock` and re-imports fresh.
 *
 * @see lib/auth-landing/route.ts · lib/app/auth-landing.ts · lib/security/sanitize.ts
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('@/lib/app/auth-landing');
  vi.doUnmock('@/lib/app/welcome');
});

/** Load the resolver with a stubbed seam. */
async function loadWith(
  route: string | null,
  label: string | null = null,
  welcome: string | null = null
) {
  vi.resetModules();
  vi.doMock('@/lib/app/auth-landing', () => ({
    appAuthLandingRoute: route,
    appAuthLandingLabel: label,
  }));
  vi.doMock('@/lib/app/welcome', () => ({ appWelcomeRoute: welcome }));
  return import('@/lib/auth-landing/route');
}

describe('AUTH_LANDING_ROUTE', () => {
  it('falls back to /dashboard when the seam is null', async () => {
    const { AUTH_LANDING_ROUTE, DEFAULT_AUTH_LANDING_ROUTE } = await loadWith(null);

    expect(AUTH_LANDING_ROUTE).toBe('/dashboard');
    expect(AUTH_LANDING_ROUTE).toBe(DEFAULT_AUTH_LANDING_ROUTE);
  });

  it('uses a root-relative fork override', async () => {
    const { AUTH_LANDING_ROUTE } = await loadWith('/programme');

    expect(AUTH_LANDING_ROUTE).toBe('/programme');
  });

  it('accepts a nested path', async () => {
    const { AUTH_LANDING_ROUTE } = await loadWith('/app/home');

    expect(AUTH_LANDING_ROUTE).toBe('/app/home');
  });

  it.each([
    ['an absolute URL', 'https://evil.example.com'],
    ['a protocol-relative URL', '//evil.example.com'],
    ['a backslash-prefixed path', '/\\evil.example.com'],
    ['a bare path with no leading slash', 'programme'],
  ])('throws on %s rather than silently redirecting off-site', async (_case, value) => {
    await expect(loadWith(value)).rejects.toThrow(/appAuthLandingRoute/);
  });

  it('trims incidental whitespace around an otherwise-valid override', async () => {
    const { AUTH_LANDING_ROUTE } = await loadWith('  /programme  ');

    expect(AUTH_LANDING_ROUTE).toBe('/programme');
  });

  it('names the offending value in the error', async () => {
    // The fork has to be able to find the file and the typo from the message
    // alone — this fires at module load, before any page renders.
    await expect(loadWith('//evil.example.com')).rejects.toThrow(/lib\/app\/auth-landing\.ts/);
  });
});

describe('AUTH_LANDING_LABEL', () => {
  it('falls back to Dashboard when the seam is null', async () => {
    const { AUTH_LANDING_LABEL, DEFAULT_AUTH_LANDING_LABEL } = await loadWith(null, null);

    expect(AUTH_LANDING_LABEL).toBe('Dashboard');
    expect(AUTH_LANDING_LABEL).toBe(DEFAULT_AUTH_LANDING_LABEL);
  });

  it('uses a fork override', async () => {
    const { AUTH_LANDING_LABEL } = await loadWith('/programme', 'Programme');

    expect(AUTH_LANDING_LABEL).toBe('Programme');
  });

  it('is independent of the route — a renamed label keeps the default route', async () => {
    const { AUTH_LANDING_ROUTE, AUTH_LANDING_LABEL } = await loadWith(null, 'Home');

    expect(AUTH_LANDING_ROUTE).toBe('/dashboard');
    expect(AUTH_LANDING_LABEL).toBe('Home');
  });

  it('throws on an empty-string label rather than rendering blank copy', async () => {
    await expect(loadWith('/programme', '')).rejects.toThrow(/appAuthLandingLabel/);
  });

  it('trims incidental whitespace around an otherwise-valid label', async () => {
    const { AUTH_LANDING_LABEL } = await loadWith('/programme', '  Programme  ');

    expect(AUTH_LANDING_LABEL).toBe('Programme');
  });
});

describe('AUTH_WELCOME_ROUTE (§134 t-1063)', () => {
  it('is null when the seam is null, so nobody is redirected', async () => {
    const { AUTH_WELCOME_ROUTE } = await loadWith(null);

    expect(AUTH_WELCOME_ROUTE).toBeNull();
  });

  it('uses a root-relative fork value', async () => {
    const { AUTH_WELCOME_ROUTE } = await loadWith(null, null, ' /welcome ');

    expect(AUTH_WELCOME_ROUTE).toBe('/welcome');
  });

  it.each([
    ['an absolute URL', 'https://evil.example.com/welcome'],
    ['a protocol-relative URL', '//evil.example.com'],
  ])('throws on %s', async (_label, value) => {
    await expect(loadWith(null, null, value)).rejects.toThrow(/lib\/app\/welcome\.ts/);
  });

  it.each([
    ['the default landing route', null, '/dashboard'],
    ['the same path with a query', null, '/dashboard?step=1'],
    ['the same path with a trailing slash', null, '/dashboard/'],
    ['a fork landing route', '/app', '/app'],
  ])('throws when it is %s, which would redirect to itself', async (_label, landing, welcome) => {
    await expect(loadWith(landing, null, welcome)).rejects.toThrow(/landing route itself/);
  });

  it('accepts a path beneath the landing route', async () => {
    const { AUTH_WELCOME_ROUTE } = await loadWith(null, null, '/dashboard/welcome');

    expect(AUTH_WELCOME_ROUTE).toBe('/dashboard/welcome');
  });
});
