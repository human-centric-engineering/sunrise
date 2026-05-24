/**
 * Tests: signed-URL reconstruction for Twilio-style HMAC verification.
 *
 * The signature breaks if the URL we reconstruct differs from the URL
 * the provider hit. Three precedence layers, exercised below:
 *   1. TWILIO_EXTERNAL_BASE_URL env var (highest)
 *   2. X-Forwarded-Proto + X-Forwarded-Host headers (proxy fallback)
 *   3. req.url (last resort)
 *
 * @see lib/orchestration/inbound/url-reconstruct.ts
 */

import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { reconstructSignedUrl } from '@/lib/orchestration/inbound/url-reconstruct';

const ORIGINAL_BASE_URL = process.env.TWILIO_EXTERNAL_BASE_URL;
const ORIGINAL_TRUST = process.env.TWILIO_TRUST_FORWARDED_HEADERS;

afterEach(() => {
  if (ORIGINAL_BASE_URL === undefined) delete process.env.TWILIO_EXTERNAL_BASE_URL;
  else process.env.TWILIO_EXTERNAL_BASE_URL = ORIGINAL_BASE_URL;
  if (ORIGINAL_TRUST === undefined) delete process.env.TWILIO_TRUST_FORWARDED_HEADERS;
  else process.env.TWILIO_TRUST_FORWARDED_HEADERS = ORIGINAL_TRUST;
});

function makeReq(url: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(url, { headers });
}

describe('reconstructSignedUrl — TWILIO_EXTERNAL_BASE_URL override', () => {
  it('rewrites the origin to the override but preserves path + query', () => {
    process.env.TWILIO_EXTERNAL_BASE_URL = 'https://public.example.com';
    const req = makeReq('http://internal:3000/api/v1/inbound/twilio/abc?foo=bar');
    expect(reconstructSignedUrl(req)).toBe(
      'https://public.example.com/api/v1/inbound/twilio/abc?foo=bar'
    );
  });

  it('honours a custom port in the override', () => {
    process.env.TWILIO_EXTERNAL_BASE_URL = 'https://gateway.example.com:8443';
    const req = makeReq('http://internal:3000/api/v1/inbound/twilio/abc');
    expect(reconstructSignedUrl(req)).toBe(
      'https://gateway.example.com:8443/api/v1/inbound/twilio/abc'
    );
  });

  it('takes precedence over X-Forwarded-* headers', () => {
    process.env.TWILIO_EXTERNAL_BASE_URL = 'https://override.example.com';
    const req = makeReq('http://internal:3000/api/v1/inbound/twilio/abc', {
      'x-forwarded-proto': 'http',
      'x-forwarded-host': 'forwarded.example.com',
    });
    expect(reconstructSignedUrl(req)).toBe(
      'https://override.example.com/api/v1/inbound/twilio/abc'
    );
  });
});

describe('reconstructSignedUrl — X-Forwarded-* headers', () => {
  it('rewrites origin from forwarded headers when no override is set', () => {
    delete process.env.TWILIO_EXTERNAL_BASE_URL;
    const req = makeReq('http://internal:3000/api/v1/inbound/twilio/abc?x=1', {
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'public.example.com',
    });
    expect(reconstructSignedUrl(req)).toBe(
      'https://public.example.com/api/v1/inbound/twilio/abc?x=1'
    );
  });

  it('is ignored when TWILIO_TRUST_FORWARDED_HEADERS=false', () => {
    delete process.env.TWILIO_EXTERNAL_BASE_URL;
    process.env.TWILIO_TRUST_FORWARDED_HEADERS = 'false';
    const req = makeReq('http://internal:3000/api/v1/inbound/twilio/abc', {
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'public.example.com',
    });
    expect(reconstructSignedUrl(req)).toBe('http://internal:3000/api/v1/inbound/twilio/abc');
  });

  it('is ignored when trustForwardedHeaders opt is false', () => {
    delete process.env.TWILIO_EXTERNAL_BASE_URL;
    delete process.env.TWILIO_TRUST_FORWARDED_HEADERS;
    const req = makeReq('http://internal:3000/api/v1/inbound/twilio/abc', {
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'public.example.com',
    });
    expect(reconstructSignedUrl(req, { trustForwardedHeaders: false })).toBe(
      'http://internal:3000/api/v1/inbound/twilio/abc'
    );
  });

  it('falls through to req.url when only one of the forwarded headers is set', () => {
    delete process.env.TWILIO_EXTERNAL_BASE_URL;
    const req = makeReq('http://internal:3000/api/v1/inbound/twilio/abc', {
      'x-forwarded-proto': 'https',
      // x-forwarded-host missing
    });
    expect(reconstructSignedUrl(req)).toBe('http://internal:3000/api/v1/inbound/twilio/abc');
  });
});

describe('reconstructSignedUrl — fallback to req.url', () => {
  it('returns req.url verbatim when no override and no forwarded headers', () => {
    delete process.env.TWILIO_EXTERNAL_BASE_URL;
    const req = makeReq('http://localhost:3000/api/v1/inbound/twilio/abc?a=1&b=2');
    expect(reconstructSignedUrl(req)).toBe(
      'http://localhost:3000/api/v1/inbound/twilio/abc?a=1&b=2'
    );
  });
});
