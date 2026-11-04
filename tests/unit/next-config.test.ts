/**
 * Tests for `next.config.js`: the `allowedDevOrigins` derivation, and the
 * `X-Frame-Options` rule's path list (#887).
 *
 * Next allows only `localhost` to reach its dev endpoints (HMR socket,
 * `/_next/*` dev resources) and blocks everything else. An app served through a
 * local reverse proxy loses hot reload until its hostname is allowed, so the
 * config derives that hostname from the URLs the app is already configured to
 * use. The point of these tests is that a fork never has to edit the file.
 *
 * The config reads `process.env` at module load, so each case sets the
 * environment and re-imports.
 *
 * @see next.config.js
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';
import { frameDenySource } from '@/lib/security/frame-deny-source.cjs';

async function loadConfig(env: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const mod = await import('@/next.config.js');
  return (mod.default ?? mod) as { allowedDevOrigins: string[] };
}

describe('next.config allowedDevOrigins', () => {
  const saved = {
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
    ALLOWED_DEV_ORIGINS: process.env.ALLOWED_DEV_ORIGINS,
  };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('allows the proxied hostname the app is served on', async () => {
    const config = await loadConfig({
      NEXT_PUBLIC_APP_URL: 'https://myapp.test',
      BETTER_AUTH_URL: 'https://myapp.test',
      ALLOWED_DEV_ORIGINS: undefined,
    });

    expect(config.allowedDevOrigins).toEqual(['myapp.test']);
  });

  it('takes the host only — not the scheme, port or path', async () => {
    const config = await loadConfig({
      NEXT_PUBLIC_APP_URL: 'https://myapp.test:8443/some/path',
      BETTER_AUTH_URL: undefined,
      ALLOWED_DEV_ORIGINS: undefined,
    });

    expect(config.allowedDevOrigins).toEqual(['myapp.test']);
  });

  it('covers both URLs when they disagree, so neither host is locked out', async () => {
    const config = await loadConfig({
      NEXT_PUBLIC_APP_URL: 'https://app.myapp.test',
      BETTER_AUTH_URL: 'https://auth.myapp.test',
      ALLOWED_DEV_ORIGINS: undefined,
    });

    expect(config.allowedDevOrigins).toEqual(
      expect.arrayContaining(['app.myapp.test', 'auth.myapp.test'])
    );
  });

  it('appends extra hosts from ALLOWED_DEV_ORIGINS, trimming whitespace', async () => {
    const config = await loadConfig({
      NEXT_PUBLIC_APP_URL: 'https://myapp.test',
      BETTER_AUTH_URL: undefined,
      ALLOWED_DEV_ORIGINS: '192.168.0.18, *.myapp.test',
    });

    expect(config.allowedDevOrigins).toEqual(['myapp.test', '192.168.0.18', '*.myapp.test']);
  });

  it('does not duplicate a host named twice', async () => {
    const config = await loadConfig({
      NEXT_PUBLIC_APP_URL: 'https://myapp.test',
      BETTER_AUTH_URL: 'https://myapp.test',
      ALLOWED_DEV_ORIGINS: 'myapp.test',
    });

    expect(config.allowedDevOrigins).toEqual(['myapp.test']);
  });

  it('yields an empty list rather than throwing on a malformed URL', async () => {
    const config = await loadConfig({
      NEXT_PUBLIC_APP_URL: 'not-a-url',
      BETTER_AUTH_URL: undefined,
      ALLOWED_DEV_ORIGINS: undefined,
    });

    // lib/env.ts validates these at startup with a far better message; the
    // config must not be the thing that explodes first.
    expect(config.allowedDevOrigins).toEqual([]);
  });

  it('adds nothing for a plain localhost setup, which Next already allows', async () => {
    const config = await loadConfig({
      NEXT_PUBLIC_APP_URL: 'http://localhost:3010',
      BETTER_AUTH_URL: 'http://localhost:3010',
      ALLOWED_DEV_ORIGINS: undefined,
    });

    expect(config.allowedDevOrigins).toEqual(['localhost']);
  });
});

describe('next.config X-Frame-Options rule (#887)', () => {
  interface HeaderRule {
    source: string;
    headers: { key: string; value: string }[];
  }

  async function headerRules(): Promise<HeaderRule[]> {
    vi.resetModules();
    const mod = await import('@/next.config.js');
    const config = (mod.default ?? mod) as { headers: () => Promise<HeaderRule[]> };
    return config.headers();
  }

  /** Whether Next would apply a rule with this `source` to `pathname` — Next's own matcher. */
  function nextMatches(source: string, pathname: string): boolean {
    return getPathMatch(source, { strict: true, removeUnnamedParams: true })(pathname) !== false;
  }

  it('is one rule over every path while lib/app/frameable-paths.json is empty (vanilla Sunrise)', async () => {
    const rules = (await headerRules()).filter((rule) =>
      rule.headers.some((header) => header.key === 'X-Frame-Options')
    );

    expect(rules).toEqual([
      { source: '/(.*)', headers: [{ key: 'X-Frame-Options', value: 'DENY' }] },
    ]);
  });

  it('still sends the other blanket headers on every path', async () => {
    const blanket = (await headerRules()).find(
      (rule) => rule.source === '/(.*)' && !rule.headers.some((h) => h.key === 'X-Frame-Options')
    );

    expect(blanket?.headers).toEqual([
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    ]);
  });

  it('leaves the listed prefixes out of DENY and keeps every other path in it', () => {
    const source = frameDenySource(['/embed/', '/q/']);

    expect(source).toBe('/((?!embed/|q/).*)');
    for (const path of ['/', '/login', '/admin/embed', '/embedded', '/qa', '/api/v1/embed/x']) {
      expect(nextMatches(source, path), path).toBe(true);
    }
    for (const path of ['/embed/widget-1', '/embed/widget-1/step', '/q/v1']) {
      expect(nextMatches(source, path), path).toBe(false);
    }
  });

  it.each([
    ['not an array', { '/embed/': true }],
    ['a root prefix', ['/']],
    ['no leading slash', ['embed/']],
    ['no trailing slash', ['/embed']],
    ['two segments', ['/embed/v1/']],
    ['a pattern', ['/(.*)/']],
    ['a lookahead escape', ['/a)|(.*/']],
    ['a traversal', ['/../']],
    ['uppercase', ['/Embed/']],
    ['a non-string', [42]],
  ])('ignores %s, so a typo cannot open the whole app', (_label, listed) => {
    const source = frameDenySource(listed);

    expect(source).toBe('/(.*)');
    expect(nextMatches(source, '/embed/widget-1')).toBe(true);
  });

  it('keeps the valid prefixes of a mixed list, once each', () => {
    expect(frameDenySource(['/embed/', '/', '/embed/', '/q/'])).toBe('/((?!embed/|q/).*)');
  });
});
