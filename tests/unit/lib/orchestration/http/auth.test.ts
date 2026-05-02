/**
 * Tests for `lib/orchestration/http/auth.ts`.
 *
 * Covers:
 *   - none / no-op
 *   - bearer / api-key — header set from env-var secret
 *   - query-param — secret appended to URL with default and custom param name
 *   - basic — both `user:pass` (encoded) and pre-encoded forms
 *   - hmac — signature stable across runs, defaults applied, overrides honoured
 *   - missing env-var fail-fast for every non-`none` type
 */

import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyAuth } from '@/lib/orchestration/http/auth';
import { HttpError } from '@/lib/orchestration/http/errors';

describe('applyAuth', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns no-op for undefined config', () => {
    const out = applyAuth(undefined, 'https://api.example.com/x', 'POST', '{}');
    expect(out).toEqual({ url: 'https://api.example.com/x', headers: {} });
  });

  it('returns no-op for type "none"', () => {
    const out = applyAuth({ type: 'none' }, 'https://api.example.com/x', 'POST', '{}');
    expect(out.headers).toEqual({});
  });

  it('attaches Bearer header for type "bearer"', () => {
    process.env.TEST_TOKEN = 'sk_test_abc';
    const out = applyAuth(
      { type: 'bearer', secret: 'TEST_TOKEN' },
      'https://api.example.com/x',
      'POST',
      '{}'
    );
    expect(out.headers).toEqual({ Authorization: 'Bearer sk_test_abc' });
    expect(out.url).toBe('https://api.example.com/x');
  });

  it('attaches X-API-Key header for type "api-key"', () => {
    process.env.TEST_KEY = 'apikey_xyz';
    const out = applyAuth(
      { type: 'api-key', secret: 'TEST_KEY' },
      'https://api.example.com/x',
      'POST',
      '{}'
    );
    expect(out.headers).toEqual({ 'X-API-Key': 'apikey_xyz' });
  });

  it('honours custom api-key header name', () => {
    process.env.TEST_KEY = 'apikey_xyz';
    const out = applyAuth(
      { type: 'api-key', secret: 'TEST_KEY', apiKeyHeaderName: 'X-Postmark-Server-Token' },
      'https://api.example.com/x',
      'POST',
      '{}'
    );
    expect(out.headers).toEqual({ 'X-Postmark-Server-Token': 'apikey_xyz' });
  });

  it('appends default query param for type "query-param"', () => {
    process.env.TEST_KEY = 'qpval';
    const out = applyAuth(
      { type: 'query-param', secret: 'TEST_KEY' },
      'https://api.example.com/x',
      'GET',
      ''
    );
    expect(out.headers).toEqual({});
    expect(out.url).toBe('https://api.example.com/x?api_key=qpval');
  });

  it('appends custom query param name when supplied', () => {
    process.env.TEST_KEY = 'tk';
    const out = applyAuth(
      { type: 'query-param', secret: 'TEST_KEY', queryParam: 'token' },
      'https://api.example.com/x',
      'GET',
      ''
    );
    expect(out.url).toBe('https://api.example.com/x?token=tk');
  });

  it('encodes user:pass to base64 for type "basic"', () => {
    process.env.TEST_BASIC = 'alice:wonderland';
    const out = applyAuth(
      { type: 'basic', secret: 'TEST_BASIC' },
      'https://api.example.com/x',
      'POST',
      '{}'
    );
    const expected = Buffer.from('alice:wonderland', 'utf8').toString('base64');
    expect(out.headers).toEqual({ Authorization: `Basic ${expected}` });
  });

  it('treats colon-less basic secret as already-encoded', () => {
    process.env.TEST_BASIC_PRE = 'YWxpY2U6d29uZGVybGFuZA==';
    const out = applyAuth(
      { type: 'basic', secret: 'TEST_BASIC_PRE' },
      'https://api.example.com/x',
      'POST',
      '{}'
    );
    expect(out.headers).toEqual({ Authorization: 'Basic YWxpY2U6d29uZGVybGFuZA==' });
  });

  it('produces a stable HMAC signature for fixed inputs', () => {
    process.env.HMAC_SECRET = 'shhh';
    const out = applyAuth(
      { type: 'hmac', secret: 'HMAC_SECRET' },
      'https://api.example.com/v1/charge',
      'POST',
      '{"amount":100}'
    );
    const expected = createHmac('sha256', 'shhh')
      .update('POST\n/v1/charge\n{"amount":100}')
      .digest('hex');
    expect(out.headers).toEqual({ 'X-Signature': expected });
  });

  it('honours custom HMAC header name and algorithm', () => {
    process.env.HMAC_SECRET = 'shhh';
    const out = applyAuth(
      {
        type: 'hmac',
        secret: 'HMAC_SECRET',
        hmacHeaderName: 'X-Vendor-Sig',
        hmacAlgorithm: 'sha512',
      },
      'https://api.example.com/v1/x',
      'POST',
      'body'
    );
    const expected = createHmac('sha512', 'shhh').update('POST\n/v1/x\nbody').digest('hex');
    expect(out.headers).toEqual({ 'X-Vendor-Sig': expected });
  });

  it('honours custom HMAC body template', () => {
    process.env.HMAC_SECRET = 'shhh';
    const out = applyAuth(
      {
        type: 'hmac',
        secret: 'HMAC_SECRET',
        hmacBodyTemplate: '{method}|{path}',
      },
      'https://api.example.com/v1/x',
      'POST',
      'body'
    );
    const expected = createHmac('sha256', 'shhh').update('POST|/v1/x').digest('hex');
    expect(out.headers).toEqual({ 'X-Signature': expected });
  });

  it.each(['bearer', 'api-key', 'query-param', 'basic', 'hmac'] as const)(
    'throws missing_auth_secret when env var unset for type "%s"',
    (type) => {
      delete process.env.UNSET_VAR;
      expect(() =>
        applyAuth({ type, secret: 'UNSET_VAR' }, 'https://api.example.com/x', 'POST', '{}')
      ).toThrow(HttpError);
    }
  );

  it.each(['bearer', 'api-key', 'query-param', 'basic', 'hmac'] as const)(
    'throws missing_auth_secret when no secret env name supplied for type "%s"',
    (type) => {
      try {
        applyAuth({ type }, 'https://api.example.com/x', 'POST', '{}');
        throw new Error('expected to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).code).toBe('missing_auth_secret');
      }
    }
  );

  it('failed env lookup carries the env var name in the message', () => {
    delete process.env.MY_SECRET_VAR;
    try {
      applyAuth(
        { type: 'bearer', secret: 'MY_SECRET_VAR' },
        'https://api.example.com/x',
        'POST',
        '{}'
      );
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).message).toContain('MY_SECRET_VAR');
    }
  });
});
