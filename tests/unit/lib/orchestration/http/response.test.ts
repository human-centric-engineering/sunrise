/**
 * Tests for `lib/orchestration/http/response.ts`.
 *
 * Covers:
 *   - isRetriableStatus: 429/502/503/504 retriable; 4xx (other) and 5xx (other) not
 *   - readResponseBody: JSON parse on JSON content-type; on JSON-shaped text;
 *     fall through to text on parse failure; size cap via content-length and
 *     actual byte length
 *   - applyResponseTransform: jmespath extraction, template interpolation,
 *     missing-path → empty string
 *   - getNestedValue: dot-path traversal with null guards
 */

import { describe, expect, it } from 'vitest';

import { HttpError } from '@/lib/orchestration/http/errors';
import {
  applyResponseTransform,
  getNestedValue,
  isRetriableStatus,
  readResponseBody,
} from '@/lib/orchestration/http/response';

describe('isRetriableStatus', () => {
  it.each([429, 502, 503, 504])('returns true for %d', (code) => {
    expect(isRetriableStatus(code)).toBe(true);
  });

  it.each([400, 401, 403, 404, 410, 500, 501])('returns false for %d', (code) => {
    expect(isRetriableStatus(code)).toBe(false);
  });
});

describe('readResponseBody', () => {
  it('parses JSON when content-type is application/json', async () => {
    const res = new Response(JSON.stringify({ a: 1 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    expect(await readResponseBody(res, 1024)).toEqual({ a: 1 });
  });

  it('parses JSON when body shape looks like JSON despite missing content-type', async () => {
    const res = new Response('{"x":2}', { status: 200 });
    expect(await readResponseBody(res, 1024)).toEqual({ x: 2 });
  });

  it('parses JSON arrays', async () => {
    const res = new Response('[1,2,3]', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    expect(await readResponseBody(res, 1024)).toEqual([1, 2, 3]);
  });

  it('returns raw text when JSON parse fails despite JSON-looking content-type', async () => {
    const res = new Response('not actually json', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    expect(await readResponseBody(res, 1024)).toBe('not actually json');
  });

  it('returns raw text for non-JSON content-type', async () => {
    const res = new Response('hello world', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
    expect(await readResponseBody(res, 1024)).toBe('hello world');
  });

  it('throws response_too_large when content-length exceeds cap', async () => {
    const res = new Response('x'.repeat(10), {
      status: 200,
      headers: { 'Content-Type': 'text/plain', 'content-length': '100' },
    });
    await expect(readResponseBody(res, 50)).rejects.toBeInstanceOf(HttpError);
  });

  it('throws response_too_large when actual body exceeds cap', async () => {
    const res = new Response('x'.repeat(100), {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
    try {
      await readResponseBody(res, 50);
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).code).toBe('response_too_large');
    }
  });
});

describe('applyResponseTransform', () => {
  it('extracts a field via jmespath', () => {
    const body = { user: { id: 'u1', name: 'Alice' } };
    expect(applyResponseTransform(body, { type: 'jmespath', expression: 'user.id' })).toBe('u1');
  });

  it('returns null for jmespath miss', () => {
    expect(applyResponseTransform({ a: 1 }, { type: 'jmespath', expression: 'b.c' })).toBeNull();
  });

  it('interpolates a template string from body fields', () => {
    const body = { name: 'Bob', count: 3 };
    expect(
      applyResponseTransform(body, {
        type: 'template',
        expression: '{{name}} has {{count}}',
      })
    ).toBe('Bob has 3');
  });

  it('template returns empty string for missing path', () => {
    expect(
      applyResponseTransform({ a: 1 }, { type: 'template', expression: '{{missing.path}}' })
    ).toBe('');
  });

  it('template stringifies object values', () => {
    const body = { obj: { k: 'v' } };
    expect(applyResponseTransform(body, { type: 'template', expression: '{{obj}}' })).toBe(
      '{"k":"v"}'
    );
  });
});

describe('getNestedValue', () => {
  it('walks a dot path', () => {
    expect(getNestedValue({ a: { b: { c: 7 } } }, 'a.b.c')).toBe(7);
  });

  it('returns undefined when an intermediate value is null', () => {
    expect(getNestedValue({ a: null }, 'a.b')).toBeUndefined();
  });

  it('returns undefined when an intermediate value is a primitive', () => {
    expect(getNestedValue({ a: 'string' }, 'a.b')).toBeUndefined();
  });

  it('returns the object itself for an empty-segment path', () => {
    expect(getNestedValue({ a: 1 }, 'a')).toBe(1);
  });
});
