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

  describe("wildcard ('*') is intentionally not supported", () => {
    // Wildcard CORS for the approve/reject embed endpoints would require
    // changing all three sites in the parser pipeline together: the Zod
    // schema in lib/validations/orchestration.ts, parseEmbedAllowedOrigins
    // in lib/orchestration/settings.ts, and this helper. Adding wildcard
    // support to the helper alone produces dead code because the parser
    // strips every entry that fails new URL().origin (which '*' does).
    // These tests pin that contract so a future contributor doesn't reintroduce
    // a half-wired wildcard.

    it("returns undefined when '*' is in the allowlist and an origin matches", () => {
      // '*' is treated as just another non-matching string. The helper
      // does not special-case it.
      const result = allowlistCorsHeaders('https://customer-1.com', ['*'], 'POST');
      expect(result).toBeUndefined();
    });

    it("returns undefined for null origin even when '*' is in the allowlist", () => {
      const result = allowlistCorsHeaders(null, ['*'], 'POST');
      expect(result).toBeUndefined();
    });
  });
});
