import { describe, it, expect } from 'vitest';

import { computeETag, checkConditional } from '@/lib/api/etag';

describe('computeETag', () => {
  it('returns a weak ETag format W/"..."', () => {
    const etag = computeETag({ hello: 'world' });
    expect(etag).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
  });

  it('same data produces same ETag', () => {
    const a = computeETag({ x: 1, y: 2 });
    const b = computeETag({ x: 1, y: 2 });
    expect(a).toBe(b);
  });

  it('different data produces different ETag', () => {
    const a = computeETag({ x: 1 });
    const b = computeETag({ x: 2 });
    expect(a).not.toBe(b);
  });

  it('handles null, arrays, and nested objects', () => {
    const etag = computeETag({ a: null, b: [1, 2], c: { d: 'e' } });
    expect(etag).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
  });
});

describe('checkConditional', () => {
  it('returns 304 when If-None-Match matches', () => {
    const etag = computeETag({ data: 'test' });
    const request = new Request('http://localhost', {
      headers: { 'If-None-Match': etag },
    });

    const result = checkConditional(request, etag);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(304);
    expect(result!.headers.get('ETag')).toBe(etag);
  });

  it('returns null when If-None-Match does not match', () => {
    const etag = computeETag({ data: 'test' });
    const request = new Request('http://localhost', {
      headers: { 'If-None-Match': 'W/"stale-hash"' },
    });

    const result = checkConditional(request, etag);
    expect(result).toBeNull();
  });

  it('returns null when no If-None-Match header present', () => {
    const etag = computeETag({ data: 'test' });
    const request = new Request('http://localhost');

    const result = checkConditional(request, etag);
    expect(result).toBeNull();
  });
});
