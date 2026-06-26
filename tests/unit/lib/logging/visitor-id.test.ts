/**
 * Unit tests for the anonymous visitor-id crypto core.
 *
 * These tests assert the security-critical properties: a signed id
 * round-trips, tampered/forged values are rejected, a different signing
 * secret cannot verify another's cookie, and malformed input never throws.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  VISITOR_COOKIE_NAME,
  VISITOR_HEADER_NAME,
  VISITOR_COOKIE_MAX_AGE,
  isVisitorTrackingEnabled,
  isHttpAccessLogEnabled,
  generateVisitorId,
  signVisitorId,
  issueVisitorId,
  verifyVisitorId,
  visitorCookieOptions,
} from '@/lib/logging/visitor-id';

describe('visitor-id constants', () => {
  it('uses a stable cookie + header name and a 180-day TTL', () => {
    expect(VISITOR_COOKIE_NAME).toBe('sunrise_vid');
    expect(VISITOR_HEADER_NAME).toBe('x-visitor-id');
    expect(VISITOR_COOKIE_MAX_AGE).toBe(60 * 60 * 24 * 180);
  });
});

describe('generateVisitorId', () => {
  it('produces distinct, non-empty, URL-safe ids', () => {
    const a = generateVisitorId();
    const b = generateVisitorId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(0);
    // nanoid alphabet: A-Za-z0-9_-
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('signVisitorId / verifyVisitorId round-trip', () => {
  it('verifies a freshly signed id back to the same value', async () => {
    const id = 'visitor-abc123';
    const cookieValue = await signVisitorId(id);

    expect(cookieValue).toContain('.');
    expect(cookieValue.startsWith(`${id}.`)).toBe(true);
    expect(await verifyVisitorId(cookieValue)).toBe(id);
  });

  it('is deterministic — the same id signs to the same value (HMAC)', async () => {
    const first = await signVisitorId('stable-id');
    const second = await signVisitorId('stable-id');
    expect(first).toBe(second);
  });

  it('issueVisitorId returns a verifiable id + cookie value pair', async () => {
    const { id, cookieValue } = await issueVisitorId();
    expect(await verifyVisitorId(cookieValue)).toBe(id);
  });

  it('round-trips ids that contain the separator character', async () => {
    // The id segment is everything before the LAST '.', so a dotted id
    // must survive verification intact.
    const id = 'tenant.region.visitor';
    expect(await verifyVisitorId(await signVisitorId(id))).toBe(id);
  });
});

describe('verifyVisitorId rejects tampered / malformed values', () => {
  it('rejects a value whose id segment was altered', async () => {
    const cookieValue = await signVisitorId('real-visitor');
    const signature = cookieValue.slice(cookieValue.lastIndexOf('.') + 1);
    const forged = `attacker-visitor.${signature}`;
    expect(await verifyVisitorId(forged)).toBeNull();
  });

  it('rejects a value whose signature was altered', async () => {
    const cookieValue = await signVisitorId('real-visitor');
    const id = cookieValue.slice(0, cookieValue.lastIndexOf('.'));
    // Flip the signature to a different valid-base64url string.
    const tamperedSig = (await signVisitorId('other-visitor')).split('.')[1];
    expect(await verifyVisitorId(`${id}.${tamperedSig}`)).toBeNull();
  });

  it.each([
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['no separator', 'justanid'],
    ['trailing separator only', 'id.'],
    ['leading separator only', '.sig'],
    ['non-base64url signature', 'id.!!!not base64!!!'],
  ])('returns null for %s', async (_label, value) => {
    expect(await verifyVisitorId(value)).toBeNull();
  });

  it('never throws on arbitrary garbage input', async () => {
    await expect(verifyVisitorId('💥.💥')).resolves.toBeNull();
  });
});

describe('verifyVisitorId is bound to BETTER_AUTH_SECRET', () => {
  afterEach(() => {
    vi.resetModules();
    process.env.BETTER_AUTH_SECRET = 'test-secret-key-for-testing-only';
  });

  it('rejects a cookie signed under a different secret', async () => {
    // Sign under secret A in a fresh module instance.
    vi.resetModules();
    process.env.BETTER_AUTH_SECRET = 'secret-A-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const modA = await import('@/lib/logging/visitor-id');
    const cookieFromA = await modA.signVisitorId('shared-id');

    // Verify under secret B in another fresh module instance.
    vi.resetModules();
    process.env.BETTER_AUTH_SECRET = 'secret-B-bbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const modB = await import('@/lib/logging/visitor-id');
    expect(await modB.verifyVisitorId(cookieFromA)).toBeNull();

    // Sanity: B can still verify its own cookies.
    const cookieFromB = await modB.signVisitorId('shared-id');
    expect(await modB.verifyVisitorId(cookieFromB)).toBe('shared-id');
  });

  it('throws when BETTER_AUTH_SECRET is absent at signing time', async () => {
    vi.resetModules();
    delete process.env.BETTER_AUTH_SECRET;
    const mod = await import('@/lib/logging/visitor-id');
    await expect(mod.signVisitorId('x')).rejects.toThrow(/BETTER_AUTH_SECRET/);
  });
});

describe('isVisitorTrackingEnabled (default ON)', () => {
  afterEach(() => {
    delete process.env.LOG_VISITOR_ID;
  });

  it('defaults to true when unset', () => {
    delete process.env.LOG_VISITOR_ID;
    expect(isVisitorTrackingEnabled()).toBe(true);
  });

  it('returns true for any value other than "false"', () => {
    process.env.LOG_VISITOR_ID = 'true';
    expect(isVisitorTrackingEnabled()).toBe(true);
    process.env.LOG_VISITOR_ID = 'yes';
    expect(isVisitorTrackingEnabled()).toBe(true);
  });

  it('returns false only for "false" (case-insensitive)', () => {
    process.env.LOG_VISITOR_ID = 'false';
    expect(isVisitorTrackingEnabled()).toBe(false);
    process.env.LOG_VISITOR_ID = 'FALSE';
    expect(isVisitorTrackingEnabled()).toBe(false);
  });
});

describe('isHttpAccessLogEnabled (default OFF)', () => {
  afterEach(() => {
    delete process.env.LOG_HTTP_ACCESS;
  });

  it('defaults to false when unset', () => {
    delete process.env.LOG_HTTP_ACCESS;
    expect(isHttpAccessLogEnabled()).toBe(false);
  });

  it('returns true only for "true" (case-insensitive)', () => {
    process.env.LOG_HTTP_ACCESS = 'true';
    expect(isHttpAccessLogEnabled()).toBe(true);
    process.env.LOG_HTTP_ACCESS = 'TRUE';
    expect(isHttpAccessLogEnabled()).toBe(true);
  });

  it('returns false for non-"true" values', () => {
    process.env.LOG_HTTP_ACCESS = '1';
    expect(isHttpAccessLogEnabled()).toBe(false);
  });
});

describe('visitorCookieOptions', () => {
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => {
    Object.defineProperty(process.env, 'NODE_ENV', {
      value: originalEnv,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  });

  function setNodeEnv(value: string): void {
    Object.defineProperty(process.env, 'NODE_ENV', {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }

  it('is HttpOnly, SameSite=Lax, Path=/, 180-day Max-Age', () => {
    const opts = visitorCookieOptions();
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('lax');
    expect(opts.path).toBe('/');
    expect(opts.maxAge).toBe(VISITOR_COOKIE_MAX_AGE);
  });

  it('sets Secure only in production', () => {
    setNodeEnv('production');
    expect(visitorCookieOptions().secure).toBe(true);

    setNodeEnv('development');
    expect(visitorCookieOptions().secure).toBe(false);

    setNodeEnv('test');
    expect(visitorCookieOptions().secure).toBe(false);
  });
});
