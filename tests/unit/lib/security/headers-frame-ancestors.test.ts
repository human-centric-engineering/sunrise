/**
 * `setSecurityHeaders`' `frameAncestors` option: the platform half of the
 * frame-ancestors seam (#887, `lib/app/frame-ancestors.ts`).
 *
 * What matters: with no answer the headers are exactly what they always were
 * (`frame-ancestors 'none'` and DENY); with an answer, exactly the valid
 * origins may frame that one response and DENY is gone; and a bad value can
 * never widen or break the policy, because it is spliced into a header.
 *
 * @see lib/security/headers.ts · lib/app/frame-ancestors.ts · proxy.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextResponse } from 'next/server';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@/lib/logging', () => ({
  logger: { warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { getCSP, setSecurityHeaders } from '@/lib/security/headers';

function frameAncestorsOf(response: NextResponse): string | undefined {
  return response.headers
    .get('Content-Security-Policy')
    ?.split('; ')
    .find((directive) => directive.startsWith('frame-ancestors '));
}

describe('setSecurityHeaders frameAncestors', () => {
  beforeEach(() => warn.mockClear());
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ['absent', undefined],
    ['empty', []],
  ])('sends exactly the platform headers when the answer is %s', (_label, frameAncestors) => {
    vi.stubEnv('NODE_ENV', 'production');
    const response = NextResponse.next();

    setSecurityHeaders(
      response,
      'nonce',
      frameAncestors === undefined ? undefined : { frameAncestors }
    );

    // The whole policy, not just the one directive: an empty seam changes nothing.
    expect(response.headers.get('Content-Security-Policy')).toBe(getCSP('nonce'));
    expect(frameAncestorsOf(response)).toBe("frame-ancestors 'none'");
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(warn).not.toHaveBeenCalled();
  });

  it('lets exactly the named origins frame the response, and drops DENY', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const response = NextResponse.next();
    // An earlier writer's DENY must not survive: the header is removed, not just left unset.
    response.headers.set('X-Frame-Options', 'DENY');

    setSecurityHeaders(response, 'nonce', {
      frameAncestors: ['https://www.client.com', 'https://shop.client.com:8443'],
    });

    expect(frameAncestorsOf(response)).toBe(
      'frame-ancestors https://www.client.com https://shop.client.com:8443'
    );
    expect(response.headers.get('X-Frame-Options')).toBeNull();
    // Every other directive is exactly the platform's.
    expect(response.headers.get('Content-Security-Policy')).toBe(
      getCSP('nonce').replace(
        "frame-ancestors 'none'",
        'frame-ancestors https://www.client.com https://shop.client.com:8443'
      )
    );
  });

  it('frames only the response it was given: the next one is refused again', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const framed = NextResponse.next();
    setSecurityHeaders(framed, 'nonce', { frameAncestors: ['https://www.client.com'] });

    const next = NextResponse.next();
    setSecurityHeaders(next, 'nonce');

    expect(frameAncestorsOf(framed)).toBe('frame-ancestors https://www.client.com');
    expect(frameAncestorsOf(next)).toBe("frame-ancestors 'none'");
    expect(next.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it.each([
    ['a wildcard', 'https://*.client.com'],
    ['a bare star', '*'],
    ['plain http', 'http://www.client.com'],
    ['a path', 'https://www.client.com/page'],
    ['a directive injection', "https://www.client.com; script-src 'unsafe-inline'"],
    ['two origins in one entry', 'https://www.client.com https://evil.example.com'],
    ['a keyword', "'self'"],
    ['a data scheme', 'data:'],
  ])('drops %s and keeps DENY when nothing valid is left', (_label, origin) => {
    vi.stubEnv('NODE_ENV', 'production');
    const response = NextResponse.next();

    setSecurityHeaders(response, 'nonce', { frameAncestors: [origin] });

    expect(frameAncestorsOf(response)).toBe("frame-ancestors 'none'");
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(warn).toHaveBeenCalledWith(
      'Ignoring invalid frame-ancestors origin from lib/app/frame-ancestors.ts',
      expect.objectContaining({ origin })
    );
  });

  it('keeps the valid entries of a mixed answer, once each', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const response = NextResponse.next();

    setSecurityHeaders(response, 'nonce', {
      frameAncestors: ['https://a.example.com', 'https://*.b.example.com', 'https://a.example.com'],
    });

    expect(frameAncestorsOf(response)).toBe('frame-ancestors https://a.example.com');
    expect(response.headers.get('X-Frame-Options')).toBeNull();
  });

  it('accepts http://localhost outside production only, so an embed can be tried locally', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const dev = NextResponse.next();
    setSecurityHeaders(dev, undefined, { frameAncestors: ['http://localhost:4000'] });
    expect(frameAncestorsOf(dev)).toBe('frame-ancestors http://localhost:4000');

    vi.stubEnv('NODE_ENV', 'production');
    const prod = NextResponse.next();
    setSecurityHeaders(prod, 'nonce', { frameAncestors: ['http://localhost:4000'] });
    expect(frameAncestorsOf(prod)).toBe("frame-ancestors 'none'");
    expect(prod.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it.each([
    ['an object', { a: 'https://www.client.com' }],
    ['a string', 'https://www.client.com'],
    ['a number', 42],
  ])('treats %s in place of a list as no answer, and keeps DENY', (_label, answer) => {
    vi.stubEnv('NODE_ENV', 'production');
    const response = NextResponse.next();

    // A resolver returning stored data typed `as string[]` can hand over anything.
    expect(() =>
      setSecurityHeaders(response, 'nonce', {
        frameAncestors: answer as unknown as readonly string[],
      })
    ).not.toThrow();
    expect(frameAncestorsOf(response)).toBe("frame-ancestors 'none'");
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('drops an entry that cannot be serialised, without throwing', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const response = NextResponse.next();

    expect(() =>
      setSecurityHeaders(response, 'nonce', {
        frameAncestors: [
          BigInt(1),
          circular,
          'https://www.client.com',
        ] as unknown as readonly string[],
      })
    ).not.toThrow();
    expect(frameAncestorsOf(response)).toBe('frame-ancestors https://www.client.com');
    expect(warn).toHaveBeenCalledWith(
      'Ignoring invalid frame-ancestors origin from lib/app/frame-ancestors.ts',
      expect.objectContaining({ origin: '<bigint>' })
    );
  });

  it('cuts a long rejected value in the warning', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const long = `https://${'a'.repeat(500)}/`;

    setSecurityHeaders(NextResponse.next(), 'nonce', { frameAncestors: [long] });

    expect(warn).toHaveBeenCalledWith(
      'Ignoring invalid frame-ancestors origin from lib/app/frame-ancestors.ts',
      expect.objectContaining({ origin: long.slice(0, 200) })
    );
  });

  it('stops warning, after one notice, once it has seen too many distinct bad values', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const fresh = await import('@/lib/security/headers');
    warn.mockClear();

    for (let i = 0; i < 1000; i++) {
      fresh.setSecurityHeaders(NextResponse.next(), 'nonce', { frameAncestors: [`bad-${i}`] });
    }
    expect(warn).toHaveBeenCalledTimes(1000);

    // Past the cap: one notice, then silence — even on repeat requests.
    for (let round = 0; round < 3; round++) {
      fresh.setSecurityHeaders(NextResponse.next(), 'nonce', {
        frameAncestors: ['bad-new-1', 'bad-new-2'],
      });
    }
    expect(warn).toHaveBeenCalledTimes(1001);
    expect(warn).toHaveBeenLastCalledWith(
      'Too many distinct invalid CSP origins; not logging further ones',
      { limit: 1000 }
    );
  });

  it('drops non-string entries and keeps the valid ones', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const response = NextResponse.next();

    setSecurityHeaders(response, 'nonce', {
      // A nested array stringifies to a valid origin; only a real string may pass.
      frameAncestors: [
        null,
        7,
        ['https://nested.client.com'],
        'https://www.client.com',
      ] as unknown as readonly string[],
    });

    expect(frameAncestorsOf(response)).toBe('frame-ancestors https://www.client.com');
  });

  it.each([
    'https://www.client.com:0',
    'https://www.client.com:65536',
    'https://www.client.com:99999',
  ])('drops %s, a port no browser would use', (origin) => {
    vi.stubEnv('NODE_ENV', 'production');
    const response = NextResponse.next();

    setSecurityHeaders(response, 'nonce', { frameAncestors: [origin] });

    expect(frameAncestorsOf(response)).toBe("frame-ancestors 'none'");
  });

  it('accepts the highest valid port', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const response = NextResponse.next();

    setSecurityHeaders(response, 'nonce', { frameAncestors: ['https://www.client.com:65535'] });

    expect(frameAncestorsOf(response)).toBe('frame-ancestors https://www.client.com:65535');
  });

  it('warns about a bad stored origin once, not on every request', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const origin = 'https://www.repeat-offender.com/';

    for (let i = 0; i < 3; i++) {
      setSecurityHeaders(NextResponse.next(), 'nonce', { frameAncestors: [origin] });
    }

    expect(
      warn.mock.calls.filter(([, ctx]) => (ctx as { origin: unknown }).origin === origin)
    ).toHaveLength(1);
  });

  it('does not accept a localhost look-alike outside production', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const response = NextResponse.next();

    setSecurityHeaders(response, undefined, {
      frameAncestors: ['http://localhost.evil.example.com', 'http://127.0.0.1:4000'],
    });

    expect(frameAncestorsOf(response)).toBe("frame-ancestors 'none'");
  });
});
