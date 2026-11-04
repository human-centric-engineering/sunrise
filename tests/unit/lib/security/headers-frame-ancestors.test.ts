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

  it('does not accept a localhost look-alike outside production', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const response = NextResponse.next();

    setSecurityHeaders(response, undefined, {
      frameAncestors: ['http://localhost.evil.example.com', 'http://127.0.0.1:4000'],
    });

    expect(frameAncestorsOf(response)).toBe("frame-ancestors 'none'");
  });
});
