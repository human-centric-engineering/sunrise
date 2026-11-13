/**
 * CSP app seam: `lib/app/csp.ts` (#450, #841)
 *
 * `lib/app/csp.ts` lets a fork add origins to `frame-src`, `script-src`,
 * `connect-src` and `media-src` without editing the platform's CSP table. The
 * values are spliced into a header, so every list is validated once at module
 * load — this file exercises that filter with a mocked seam, since the real one
 * is empty in vanilla Sunrise.
 *
 * Lives in its own file because the validated lists are computed at import
 * time; each case needs a fresh module graph.
 *
 * @see lib/security/headers.ts · lib/app/csp.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type SeamList = 'appFrameSrc' | 'appScriptSrc' | 'appConnectSrc' | 'appMediaSrc';

const mockSeam: Record<SeamList, string[]> = {
  appFrameSrc: [],
  appScriptSrc: [],
  appConnectSrc: [],
  appMediaSrc: [],
};

vi.mock('@/lib/app/csp', () => ({
  get appFrameSrc() {
    return mockSeam.appFrameSrc;
  },
  get appScriptSrc() {
    return mockSeam.appScriptSrc;
  },
  get appConnectSrc() {
    return mockSeam.appConnectSrc;
  },
  get appMediaSrc() {
    return mockSeam.appMediaSrc;
  },
}));

const warn = vi.fn();
vi.mock('@/lib/logging', () => ({
  logger: { warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

/** Re-import headers.ts with the seam's lists set as given (the rest empty). */
async function loadHeadersWith(lists: Partial<Record<SeamList, string[]>>) {
  for (const key of Object.keys(mockSeam) as SeamList[]) {
    mockSeam[key] = lists[key] ?? [];
  }
  vi.resetModules();
  return import('@/lib/security/headers');
}

/**
 * Each seam list, the directive it feeds, and that directive's platform value in
 * development and production. The platform values are written out rather than
 * read from headers.ts, so a test that compared the module to itself cannot pass
 * by construction.
 */
const LISTS = [
  {
    list: 'appFrameSrc',
    wildcard: true,
    directive: 'frame-src',
    dev: ["'self'"],
    prod: ["'self'"],
  },
  {
    list: 'appScriptSrc',
    wildcard: false,
    directive: 'script-src',
    dev: ["'self'", "'unsafe-eval'", "'unsafe-inline'"],
    prod: ["'self'"],
  },
  {
    list: 'appConnectSrc',
    wildcard: true,
    directive: 'connect-src',
    dev: ["'self'", 'webpack://*', 'ws://localhost:*', 'wss://localhost:*'],
    prod: ["'self'"],
  },
  {
    list: 'appMediaSrc',
    wildcard: true,
    directive: 'media-src',
    dev: ["'self'", 'blob:'],
    prod: ["'self'", 'blob:'],
  },
] as const;

describe('CSP app seam (lib/app/csp.ts)', () => {
  beforeEach(() => {
    warn.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('builds exactly the platform policy when every list is empty (vanilla Sunrise)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { getCSP } = await loadHeadersWith({});

    // The whole production header, pinned: an empty seam must change nothing.
    expect(getCSP()).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: https: blob:; media-src 'self' blob:; font-src 'self' data:; " +
        "connect-src 'self'; worker-src 'self' blob:; frame-src 'self'; frame-ancestors 'none'; " +
        "form-action 'self'; base-uri 'self'; object-src 'none'; upgrade-insecure-requests; " +
        'report-uri /api/csp-report'
    );
    expect(warn).not.toHaveBeenCalled();
  });

  describe.each(LISTS)('$list → $directive', ({ list, directive, dev, prod, wildcard }) => {
    it('adds the fork origins after the platform values, in config and header', async () => {
      const { getCSP, getCSPConfig } = await loadHeadersWith({
        [list]: ['https://one.example.com', 'https://two.example.com'],
      });

      expect(getCSPConfig()[directive]).toEqual([
        ...dev,
        'https://one.example.com',
        'https://two.example.com',
      ]);
      expect(getCSP()).toContain(
        `${directive} ${dev.join(' ')} https://one.example.com https://two.example.com;`
      );
    });

    it('applies in production as well as development', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      const { getCSPConfig } = await loadHeadersWith({ [list]: ['https://one.example.com'] });

      expect(getCSPConfig()[directive]).toEqual([...prod, 'https://one.example.com']);
    });

    it('accepts a port in range, and drops one out of range', async () => {
      const { getCSPConfig } = await loadHeadersWith({
        [list]: ['https://media.example.com:65535', 'https://media.example.com:65536'],
      });

      expect(getCSPConfig()[directive]).toEqual([...dev, 'https://media.example.com:65535']);
    });

    it(`${wildcard ? 'accepts' : 'drops'} a left-most wildcard`, async () => {
      const { getCSPConfig } = await loadHeadersWith({ [list]: ['https://*.example.com'] });

      expect(getCSPConfig()[directive]).toEqual(wildcard ? [...dev, 'https://*.example.com'] : dev);
    });

    it.each([
      ['*', 'a bare wildcard'],
      ['https://*', 'a scheme-wide wildcard'],
      ['http://evil.example.com', 'a plaintext origin'],
      ['data:', 'a data scheme'],
      ["'unsafe-inline'", 'a CSP keyword'],
      ['https://ok.example.com; script-src *', 'a directive-injection attempt'],
      ['https://ok.example.com https://evil.example.com', 'two origins in one entry'],
      ['https://ok.example.com/embed', 'a path'],
    ])('drops %s (%s) and warns', async (origin) => {
      const { getCSPConfig } = await loadHeadersWith({ [list]: [origin] });

      expect(getCSPConfig()[directive]).toEqual(dev);
      expect(warn).toHaveBeenCalledWith(
        `Ignoring invalid ${directive} origin from lib/app/csp.ts`,
        expect.objectContaining({ origin })
      );
    });

    it('keeps the valid origins when one entry in the list is invalid', async () => {
      const { getCSPConfig } = await loadHeadersWith({
        [list]: ['https://one.example.com', '*'],
      });

      expect(getCSPConfig()[directive]).toEqual([...dev, 'https://one.example.com']);
    });

    it('does not touch any other directive', async () => {
      const { getCSPConfig } = await loadHeadersWith({ [list]: ['https://one.example.com'] });
      const config = getCSPConfig();

      expect(config['frame-ancestors']).toEqual(["'none'"]);
      for (const other of LISTS.filter((entry) => entry.list !== list)) {
        expect(config[other.directive]).toEqual(other.dev);
      }
    });
  });

  it("never lets a fork put 'unsafe-eval' into the production header (#864)", async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { getCSP } = await loadHeadersWith({
      appScriptSrc: ["'unsafe-eval'", 'https://challenges.cloudflare.com'],
    });

    for (const csp of [getCSP(), getCSP('abc123')]) {
      expect(csp).not.toContain('unsafe-eval');
      expect(csp).toContain('https://challenges.cloudflare.com');
    }
    expect(warn).toHaveBeenCalledWith(
      'Ignoring invalid script-src origin from lib/app/csp.ts',
      expect.objectContaining({ origin: "'unsafe-eval'" })
    );
  });

  it('keeps the production nonce alongside a fork script origin', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { getCSPConfig } = await loadHeadersWith({
      appScriptSrc: ['https://challenges.cloudflare.com'],
    });

    expect(getCSPConfig('abc123')['script-src']).toEqual([
      "'self'",
      "'nonce-abc123'",
      'https://challenges.cloudflare.com',
    ]);
  });

  it('lists a repeated origin once', async () => {
    const { getCSPConfig } = await loadHeadersWith({
      appMediaSrc: ['https://media.example.com', 'https://media.example.com'],
    });

    expect(getCSPConfig()['media-src']).toEqual(["'self'", 'blob:', 'https://media.example.com']);
  });

  it('lists a fork origin that analytics also adds only once', async () => {
    vi.stubEnv('NEXT_PUBLIC_PLAUSIBLE_DOMAIN', 'example.com');
    const { getCSPConfig } = await loadHeadersWith({
      appScriptSrc: ['https://plausible.io'],
      appConnectSrc: ['https://plausible.io'],
    });
    const config = getCSPConfig();

    expect(config['script-src'].filter((v) => v === 'https://plausible.io')).toHaveLength(1);
    expect(config['connect-src'].filter((v) => v === 'https://plausible.io')).toHaveLength(1);
  });
});
