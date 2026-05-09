/**
 * Direct unit tests for the CORS helpers in approval-route-helpers.
 *
 * The other approval-related test files (approval-actions, approval-scoping,
 * approval-tokens) cover the request-handling helpers. This file specifically
 * covers `singleOriginCorsHeaders` and `allowlistCorsHeaders` — the CORS
 * gates the embed and chat reject/approve routes delegate to.
 */

import { describe, it, expect } from 'vitest';

import {
  allowlistCorsHeaders,
  singleOriginCorsHeaders,
} from '@/lib/orchestration/approval-route-helpers';

describe('singleOriginCorsHeaders', () => {
  it('returns CORS headers when the request origin matches the allowed origin', () => {
    const result = singleOriginCorsHeaders(
      'https://app.example.com',
      'https://app.example.com',
      'POST'
    );

    expect(result).toEqual({
      'Access-Control-Allow-Origin': 'https://app.example.com',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    });
  });

  it('returns undefined when the request origin does not match', () => {
    const result = singleOriginCorsHeaders(
      'https://attacker.com',
      'https://app.example.com',
      'POST'
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined for null requestOrigin (no wildcard exception)', () => {
    expect(singleOriginCorsHeaders(null, 'https://app.example.com', 'POST')).toBeUndefined();
  });

  it("returns undefined for the literal string 'null' (sandboxed iframe Origin)", () => {
    // Browsers send `Origin: null` for sandboxed iframes and `file://`. Treating
    // it as a real origin would let arbitrary file:// content call the API.
    expect(singleOriginCorsHeaders('null', 'https://app.example.com', 'POST')).toBeUndefined();
  });
});

describe('allowlistCorsHeaders', () => {
  describe('exact-match allowlist (no wildcard)', () => {
    it('returns CORS headers when origin is in the allowlist', () => {
      const result = allowlistCorsHeaders(
        'https://partner.example.com',
        ['https://partner.example.com', 'https://other.example.com'],
        'POST'
      );

      expect(result).toEqual({
        'Access-Control-Allow-Origin': 'https://partner.example.com',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      });
    });

    it('returns undefined when origin is not in the allowlist', () => {
      expect(
        allowlistCorsHeaders('https://attacker.com', ['https://partner.example.com'], 'POST')
      ).toBeUndefined();
    });

    it('returns undefined for null origin', () => {
      expect(allowlistCorsHeaders(null, ['https://partner.example.com'], 'POST')).toBeUndefined();
    });

    it("returns undefined for the literal 'null' origin", () => {
      expect(allowlistCorsHeaders('null', ['https://partner.example.com'], 'POST')).toBeUndefined();
    });

    it('returns undefined when the allowlist is empty', () => {
      expect(allowlistCorsHeaders('https://anywhere.com', [], 'POST')).toBeUndefined();
    });
  });

  describe("wildcard allowlist ('*')", () => {
    // The CORS spec forbids `credentials: 'include'` with literal
    // `Access-Control-Allow-Origin: *`. These embed endpoints authenticate via
    // a token in the URL query string, so credentials are not in play and the
    // wildcard is safe.

    it("returns literal '*' when '*' is in the allowlist and origin matches a real value", () => {
      const result = allowlistCorsHeaders('https://customer-1.com', ['*'], 'POST');

      // Must NOT echo back the requesting origin — that would imply
      // per-origin behaviour and re-introduce the credential vector.
      expect(result?.['Access-Control-Allow-Origin']).toBe('*');
      expect(result?.['Access-Control-Allow-Methods']).toBe('POST, OPTIONS');
    });

    it("returns literal '*' for null origin when '*' is in the allowlist", () => {
      // Null origin is the case the route plan flagged: with a wildcard
      // configured, an admin has explicitly opted into "any origin can call
      // this", which includes sandboxed iframes / file:// (null origin).
      const result = allowlistCorsHeaders(null, ['*'], 'POST');
      expect(result?.['Access-Control-Allow-Origin']).toBe('*');
    });

    it("returns literal '*' for the string 'null' origin when '*' is in the allowlist", () => {
      const result = allowlistCorsHeaders('null', ['*'], 'POST');
      expect(result?.['Access-Control-Allow-Origin']).toBe('*');
    });

    it("returns literal '*' even when both '*' and specific origins are in the allowlist", () => {
      // If the admin set both, the wildcard wins — that's the explicit intent.
      const result = allowlistCorsHeaders(
        'https://attacker.com',
        ['*', 'https://specific.com'],
        'POST'
      );
      expect(result?.['Access-Control-Allow-Origin']).toBe('*');
    });
  });
});
