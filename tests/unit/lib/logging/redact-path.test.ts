/**
 * Unit Tests: collapseDynamicSegments (#685)
 *
 * The logger redacts by key name only, so a credential in a route path reaches
 * the log verbatim unless the path is collapsed first. These pin what the
 * heuristic collapses and — as importantly — what it leaves readable.
 *
 * @see lib/logging/redact-path.ts
 */

import { describe, it, expect } from 'vitest';
import {
  collapseDynamicSegments,
  loggablePath,
  scrubUrl,
  scrubUrlsDeep,
  scrubUrlsInError,
  scrubUrlsInText,
} from '@/lib/logging/redact-path';

describe('collapseDynamicSegments', () => {
  it.each([
    ['uuid', '/api/v1/x/3f2504e0-4f89-11d3-9a0c-0305e82c3301'],
    ['cuid', '/api/v1/x/cmtd5heg2001804ky8pgo6odx'],
    ['cuid2', '/api/v1/x/tz4a98xxat96iws9zmbrgj3a'],
    ['base64url token', '/api/v1/x/Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z'],
    ['mixed-case token with no digits', '/api/v1/x/AbcdEfghIjklMnopQrstUvwx'],
    ['hex token', '/api/v1/x/deadbeefcafebabe0123456789abcdef'],
    ['standard base64 token', '/api/v1/x/q8Zr+Jd0Wm4xT2pLs9VbN3kHe='],
    ['percent-encoded token', '/api/v1/x/q8Zr%2BJd0Wm4xT2pLs9VbN3kHe%3D'],
  ])('collapses a %s segment', (_label, path) => {
    expect(collapseDynamicSegments(path)).toBe('/api/v1/x/[param]');
  });

  it('collapses every sensitive segment and keeps the rest in place', () => {
    expect(
      collapseDynamicSegments(
        '/api/v1/admin/orchestration/agents/cmtd5heg2001804ky8pgo6odx/embed-tokens/cmtd5heg2001804ky8pgo6ody'
      )
    ).toBe('/api/v1/admin/orchestration/agents/[param]/embed-tokens/[param]');
  });

  it.each([
    '/api/v1/admin/orchestration',
    '/api/v1/users/123/posts',
    '/api/v1/admin/orchestration/provider-models',
    '/api/v1/knowledge/patterns/12',
    '/',
    '',
  ])('leaves %j unchanged', (path) => {
    expect(collapseDynamicSegments(path)).toBe(path);
  });

  it('leaves a 19-character token alone (documented limit)', () => {
    expect(collapseDynamicSegments('/x/Ab3dEf6hIj9kLm2nO')).toBe('/x/Ab3dEf6hIj9kLm2nO');
  });

  it.each(['ada@example.com', 'ada%40example.com', 'ADA%40EXAMPLE.COM'])(
    'collapses an email-address segment %j',
    (email) => {
      expect(collapseDynamicSegments(`/api/v1/admin/invitations/${email}`)).toBe(
        '/api/v1/admin/invitations/[param]'
      );
    }
  );

  it('collapses a JWT segment', () => {
    expect(
      collapseDynamicSegments(
        '/x/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'
      )
    ).toBe('/x/[param]');
  });

  it.each(['/blog/how-we-scaled-to-10000-users', '/pricing-2026-launch-notes-and-faq'])(
    'keeps a readable slug with numbers %j',
    (path) => {
      expect(collapseDynamicSegments(path)).toBe(path);
    }
  );

  it('still collapses a token that contains a hyphen', () => {
    expect(collapseDynamicSegments('/x/Ab3dEf6hIj9kLm2-Op5qRs8tUv1wXy4z')).toBe('/x/[param]');
  });
});

describe('loggablePath', () => {
  it('passes undefined through and collapses a present path', () => {
    expect(loggablePath(undefined)).toBeUndefined();
    expect(loggablePath('/api/v1/x/cmtd5heg2001804ky8pgo6odx')).toBe('/api/v1/x/[param]');
  });
});

describe('scrubUrl', () => {
  const token = 'Xk9fQ2mZp4LrT7vB1nWc8sYd';

  it('drops the query string and fragment and collapses a credential-shaped segment', () => {
    expect(scrubUrl(`https://app.example.com/s/${token}?email=a%40b.c#t=${token}`)).toBe(
      'https://app.example.com/s/[param]'
    );
  });

  it('drops user:password from the authority', () => {
    expect(scrubUrl('https://user:secret@app.example.com/admin?x=1')).toBe(
      'https://app.example.com/admin'
    );
  });

  it('scrubs a relative path and leaves readable segments alone', () => {
    expect(scrubUrl(`/s/${token}?q=1`)).toBe('/s/[param]');
    expect(scrubUrl('/admin/orchestration/agents#tab')).toBe('/admin/orchestration/agents');
  });

  it('keeps a bare origin intact', () => {
    expect(scrubUrl('https://app.example.com?ref=x')).toBe('https://app.example.com');
  });

  it('does not exempt a web URL because it contains /node_modules/', () => {
    expect(scrubUrl(`https://h.example/s/${token}/node_modules/x`)).toBe(
      'https://h.example/s/[param]/node_modules/x'
    );
  });

  it('collapses segments ahead of a build-asset tail', () => {
    expect(scrubUrl(`https://h.example/s/${token}/_next/static/chunks/a.js`)).toBe(
      'https://h.example/s/[param]/_next/static/chunks/a.js'
    );
  });

  it('keeps installed package paths whole, scoped packages included', () => {
    expect(scrubUrl('/var/task/node_modules/@prisma/client/runtime/library.js')).toBe(
      '/var/task/node_modules/@prisma/client/runtime/library.js'
    );
  });

  it('keeps a build asset path intact under a basePath', () => {
    expect(scrubUrl('https://host/app/_next/static/AbCdEf0123456789xYz12/_buildManifest.js')).toBe(
      'https://host/app/_next/static/AbCdEf0123456789xYz12/_buildManifest.js'
    );
  });

  it('keeps a Next.js build asset path intact, minus its query', () => {
    expect(
      scrubUrl('https://app.example.com/_next/static/AbCdEf0123456789xYz12/_buildManifest.js?dpl=1')
    ).toBe('https://app.example.com/_next/static/AbCdEf0123456789xYz12/_buildManifest.js');
  });
});

describe('scrubUrlsInText', () => {
  const token = 'Xk9fQ2mZp4LrT7vB1nWc8sYd';

  it('scrubs paths and URLs in span names', () => {
    expect(scrubUrlsInText(`GET /s/${token}?a=1`)).toBe('GET /s/[param]');
    expect(scrubUrlsInText(`middleware GET https://app.example.com/s/${token}`)).toBe(
      'middleware GET https://app.example.com/s/[param]'
    );
    expect(scrubUrlsInText(`fetch(https://app.example.com/s/${token}?x=1)`)).toBe(
      'fetch(https://app.example.com/s/[param])'
    );
  });

  it('scrubs stack frame URLs and keeps their line and column', () => {
    const stack = `Error: boom\n    at f (https://app.example.com/s/${token}?email=a%40b.c:12:34)\n    at g (https://app.example.com/_next/static/chunks/main-abc.js:1:2)`;
    expect(scrubUrlsInText(stack)).toBe(
      'Error: boom\n    at f (https://app.example.com/s/[param]:12:34)\n    at g (https://app.example.com/_next/static/chunks/main-abc.js:1:2)'
    );
  });

  it('does not let trailing punctuation shield a credential segment', () => {
    expect(scrubUrlsInText(`Failed to load https://app.example.com/s/${token}, status 404`)).toBe(
      'Failed to load https://app.example.com/s/[param], status 404'
    );
    expect(scrubUrlsInText(`{"url":"https://app.example.com/s/${token}"}`)).toBe(
      '{"url":"https://app.example.com/s/[param]"}'
    );
  });

  it('stops a URL at a quote or comma, so JSON after it survives', () => {
    expect(scrubUrlsInText('{"a":"https://h.example/x?q=1","b":"keep"}')).toBe(
      '{"a":"https://h.example/x","b":"keep"}'
    );
    expect(scrubUrlsInText(`["/s/${token}?a=1",'/x#y']`)).toBe(`["/s/[param]",'/x']`);
  });

  it('scrubs a scheme-less host/path', () => {
    expect(scrubUrlsInText(`see h.com/s/${token}?email=a%40b.c`)).toBe('see h.com/s/[param]');
    expect(scrubUrlsInText(`at app.example.com:3000/s/${token}#t`)).toBe(
      'at app.example.com:3000/s/[param]'
    );
  });

  it('leaves user-agent product tokens alone', () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
    expect(scrubUrlsInText(ua)).toBe(ua);
  });

  it('leaves text with no URL or leading-slash path alone', () => {
    expect(scrubUrlsInText('pageload')).toBe('pageload');
    expect(scrubUrlsInText('a/b and 1/2')).toBe('a/b and 1/2');
  });
});

describe('scrubUrlsDeep', () => {
  const token = 'Xk9fQ2mZp4LrT7vB1nWc8sYd';

  it('scrubs strings in nested objects and arrays, and leaves other values alone', () => {
    const when = new Date(0);
    const input = {
      request: { url: `https://app.example.com/s/${token}?a=1`, method: 'GET' },
      config: { urls: [`/s/${token}#x`], value: [`/s/${token}`] },
      count: 3,
      when,
    };

    expect(scrubUrlsDeep(input)).toEqual({
      request: { url: 'https://app.example.com/s/[param]', method: 'GET' },
      config: { urls: ['/s/[param]'], value: ['/s/[param]'] },
      count: 3,
      when,
    });
    expect(input.request.url).toBe(`https://app.example.com/s/${token}?a=1`);
  });

  it('copies an Error with its message, stack and own properties scrubbed', () => {
    const error = Object.assign(new Error(`bad link /s/${token}?a=1`), { code: 'E_LINK' });
    error.name = 'LinkError';
    error.stack = `LinkError: bad link\n    at https://app.example.com/s/${token}?a=1:3:7`;

    const scrubbed = scrubUrlsInError(error);

    expect(scrubbed).not.toBe(error);
    expect(scrubbed).toMatchObject({
      name: 'LinkError',
      message: 'bad link /s/[param]',
      stack: 'LinkError: bad link\n    at https://app.example.com/s/[param]:3:7',
      code: 'E_LINK',
    });
    expect(error.message).toBe(`bad link /s/${token}?a=1`);
  });

  it('keeps the subclass and scrubs the cause chain, so linked errors survive', () => {
    const inner = new Error(`inner https://app.example.com/s/${token}?a=1`);
    const outer = new TypeError('outer', { cause: inner });

    const scrubbed = scrubUrlsInError(outer);

    expect(scrubbed).toBeInstanceOf(TypeError);
    expect(scrubbed.name).toBe('TypeError');
    expect(scrubbed.cause).toBeInstanceOf(Error);
    expect(scrubbed.cause).toMatchObject({ message: 'inner https://app.example.com/s/[param]' });
    expect(Object.keys(scrubbed)).not.toContain('cause');
  });

  it("scrubs an AggregateError's errors", () => {
    const scrubbed = scrubUrlsInError(
      new AggregateError([new Error(`failed /s/${token}?a=1`)], 'several failed')
    );

    expect(scrubbed).toBeInstanceOf(AggregateError);
    expect(scrubbed).toHaveProperty('errors');
    expect(Reflect.get(scrubbed, 'errors')).toEqual([
      expect.objectContaining({ message: 'failed /s/[param]' }),
    ]);
  });

  it('turns a URL object into its scrubbed href', () => {
    expect(scrubUrlsDeep({ a: new URL(`https://h.example/s/${token}?x=1`) })).toEqual({
      a: 'https://h.example/s/[param]',
    });
  });

  it('terminates on an Error that references itself', () => {
    const error = new Error('loop') as Error & { self?: unknown };
    error.self = error;

    expect(() => scrubUrlsDeep(error)).not.toThrow();
  });
});
