/**
 * Unit Test: Stateless HMAC-signed storage access tokens
 *
 * @see lib/storage/access-tokens.ts
 *
 * Coverage targets:
 * - Round-trip: generate → verify returns the key it was minted for
 * - Key binding: a token names exactly one key (the route's whole ACL)
 * - Tampered payload / signature → throws
 * - Expired token → throws
 * - Malformed tokens → throw descriptive errors
 * - TTL clamping to MAX_EXPIRY_SECONDS
 * - buildStorageAccessUrl produces a usable, correctly encoded URL
 */

import { createHmac } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/lib/env', () => ({
  env: {
    BETTER_AUTH_SECRET: 'test-secret-that-is-at-least-32-characters-long',
    BETTER_AUTH_URL: 'https://app.example.com',
  },
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import {
  generateStorageAccessToken,
  verifyStorageAccessToken,
  buildStorageAccessUrl,
  MAX_EXPIRY_SECONDS,
} from '@/lib/storage/access-tokens';

const SECRET = 'test-secret-that-is-at-least-32-characters-long';
const KEY = 'documents/user-1/contract.pdf';

/** Mint a token with an arbitrary payload, signed correctly. */
function signPayload(payload: unknown): string {
  const json = JSON.stringify(payload);
  const signature = createHmac('sha256', SECRET).update(json, 'utf8').digest('base64url');
  return `${Buffer.from(json, 'utf8').toString('base64url')}.${signature}`;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('storage access tokens', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('generate → verify round trip', () => {
    it('returns the key the token was minted for', () => {
      const { token } = generateStorageAccessToken(KEY, 300);

      expect(verifyStorageAccessToken(token).key).toBe(KEY);
    });

    it('reports the expiry it applied', () => {
      const { expiresAt } = generateStorageAccessToken(KEY, 300);

      expect(expiresAt.toISOString()).toBe('2026-07-30T12:05:00.000Z');
    });

    it('defaults to a one-hour lifetime', () => {
      const { expiresAt } = generateStorageAccessToken(KEY);

      expect(expiresAt.toISOString()).toBe('2026-07-30T13:00:00.000Z');
    });

    it('clamps a lifetime beyond the maximum', () => {
      const { expiresAt } = generateStorageAccessToken(KEY, MAX_EXPIRY_SECONDS * 10);

      expect(expiresAt.getTime()).toBe(Date.now() + MAX_EXPIRY_SECONDS * 1000);
    });

    it('rejects an empty key', () => {
      expect(() => generateStorageAccessToken('')).toThrow(/requires a key/i);
    });
  });

  describe('key binding', () => {
    it('names exactly one key, so the route can reject a mismatch', () => {
      // Comparing this against the requested key is the entire access-control
      // model — storage keys encode no ownership to authorise against.
      const { token } = generateStorageAccessToken('avatars/user-1/avatar.jpg', 300);

      expect(verifyStorageAccessToken(token).key).toBe('avatars/user-1/avatar.jpg');
      expect(verifyStorageAccessToken(token).key).not.toBe('avatars/user-2/avatar.jpg');
    });
  });

  describe('tampering', () => {
    it('throws when the payload is swapped for another key under the old signature', () => {
      const { token } = generateStorageAccessToken(KEY, 300);
      const signature = token.slice(token.indexOf('.') + 1);
      const forgedPayload = Buffer.from(
        JSON.stringify({ key: 'secrets/admin.pdf', expiresAt: '2099-01-01T00:00:00.000Z' }),
        'utf8'
      ).toString('base64url');

      expect(() => verifyStorageAccessToken(`${forgedPayload}.${signature}`)).toThrow(/signature/i);
    });

    it('throws when the signature is altered', () => {
      const { token } = generateStorageAccessToken(KEY, 300);
      const [payload, signature] = token.split('.');
      const flipped = signature.slice(0, -1) + (signature.endsWith('a') ? 'b' : 'a');

      expect(() => verifyStorageAccessToken(`${payload}.${flipped}`)).toThrow(/signature/i);
    });

    it('throws when a token signed with a different secret is presented', () => {
      const json = JSON.stringify({ key: KEY, expiresAt: '2099-01-01T00:00:00.000Z' });
      const wrongSignature = createHmac('sha256', 'a-completely-different-secret-value')
        .update(json, 'utf8')
        .digest('base64url');
      const token = `${Buffer.from(json, 'utf8').toString('base64url')}.${wrongSignature}`;

      expect(() => verifyStorageAccessToken(token)).toThrow(/signature/i);
    });
  });

  describe('expiry', () => {
    it('throws once the token has expired', () => {
      const { token } = generateStorageAccessToken(KEY, 300);

      vi.setSystemTime(new Date('2026-07-30T12:05:01Z'));

      expect(() => verifyStorageAccessToken(token)).toThrow(/expired/i);
    });

    it('still verifies one second before expiry', () => {
      const { token } = generateStorageAccessToken(KEY, 300);

      vi.setSystemTime(new Date('2026-07-30T12:04:59Z'));

      expect(verifyStorageAccessToken(token).key).toBe(KEY);
    });

    it('throws on a correctly signed token with an unparseable expiry', () => {
      const token = signPayload({ typ: 'storage-read', key: KEY, expiresAt: 'not-a-date' });

      expect(() => verifyStorageAccessToken(token)).toThrow(/expired/i);
    });
  });

  describe('malformed input', () => {
    it('throws when there is no separator', () => {
      expect(() => verifyStorageAccessToken('no-dot-here')).toThrow(/format/i);
    });

    it('throws when the payload is not JSON', () => {
      const payload = Buffer.from('not json at all', 'utf8').toString('base64url');
      const signature = createHmac('sha256', SECRET)
        .update('not json at all', 'utf8')
        .digest('base64url');

      expect(() => verifyStorageAccessToken(`${payload}.${signature}`)).toThrow(/payload/i);
    });

    it('throws when the payload is missing the key', () => {
      const token = signPayload({ typ: 'storage-read', expiresAt: '2099-01-01T00:00:00.000Z' });

      expect(() => verifyStorageAccessToken(token)).toThrow(/incomplete/i);
    });

    it('throws on an empty token', () => {
      expect(() => verifyStorageAccessToken('')).toThrow(/format/i);
    });
  });

  // #507: this scheme and `lib/orchestration/approval-tokens.ts` HMAC the same
  // construction with the same secret, so the MAC cannot tell them apart —
  // a signature minted there verifies structurally here. Before the `typ` tag,
  // the only thing stopping a cross-scheme replay was that the two payload
  // schemas happened to be disjoint on required fields, which is a property of
  // today's shapes rather than a decision anyone made.
  describe('domain separation from the approval-token scheme', () => {
    it('rejects an authentically signed approval token', () => {
      const token = signPayload({
        typ: 'workflow-approval',
        executionId: 'exec-1',
        action: 'approve',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });

      expect(() => verifyStorageAccessToken(token)).toThrow(/not a storage-read token/i);
    });

    it('rejects a payload that satisfies both schemas at once', () => {
      // The failure the tag exists for, and the one the disjointness accident
      // does not cover: a single payload carrying every field both verifiers
      // require. Untagged, one signature over this is simultaneously a valid
      // storage-read grant and a valid approval on exec-1.
      const token = signPayload({
        key: KEY,
        executionId: 'exec-1',
        action: 'approve',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });

      // Rejected as untagged — which is what this payload is. The tagged
      // version of the same shape is the next test.
      expect(() => verifyStorageAccessToken(token)).toThrow(/missing its scheme tag/i);
    });

    it('rejects a both-schemas payload tagged for the other scheme', () => {
      // Same superset shape, but tagged `workflow-approval`. This is the one
      // the tag is really for: authentic, complete, satisfies every field
      // this verifier requires, and belongs to the other protocol.
      const token = signPayload({
        typ: 'workflow-approval',
        key: KEY,
        executionId: 'exec-1',
        action: 'approve',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });

      expect(() => verifyStorageAccessToken(token)).toThrow(/not a storage-read token/i);
    });

    it('tells a legacy untagged token apart from a wrong-scheme one', () => {
      // The dominant shape for the first week after deploy: a token minted
      // before the tag existed. The scheme was right and the token merely
      // predates the check, so reporting "not a storage-read token" would
      // send whoever is debugging the deploy hunting a cross-scheme bug that
      // isn't there. The storage route echoes this message in its 401.
      const token = signPayload({ key: KEY, expiresAt: '2099-01-01T00:00:00.000Z' });

      expect(() => verifyStorageAccessToken(token)).toThrow(
        'Storage token payload is missing its scheme tag'
      );
    });

    it('covers the tag with the signature, so a token cannot be retagged', () => {
      // Domain separation is only worth anything if the tag is inside the
      // signed bytes. Same payload, same expiry, tag swapped, original
      // signature — this must fail on the MAC, not on the tag check.
      const expiresAt = '2026-07-30T12:05:00.000Z';
      const signed = signPayload({ typ: 'storage-read', key: KEY, expiresAt });
      const signature = signed.slice(signed.indexOf('.') + 1);
      const retagged = Buffer.from(
        JSON.stringify({ typ: 'workflow-approval', key: KEY, expiresAt }),
        'utf8'
      ).toString('base64url');

      expect(() => verifyStorageAccessToken(`${retagged}.${signature}`)).toThrow(/signature/i);
    });
  });

  describe('buildStorageAccessUrl', () => {
    it('builds a relative URL the read route can serve', () => {
      const { url } = buildStorageAccessUrl(KEY, 300);

      expect(url).toMatch(/^\/api\/v1\/storage\/documents\/user-1\/contract\.pdf\?token=/);
    });

    it('produces a token that verifies for the same key', () => {
      const { url } = buildStorageAccessUrl(KEY, 300);
      const token = decodeURIComponent(url.split('token=')[1]);

      expect(verifyStorageAccessToken(token).key).toBe(KEY);
    });

    it('preserves path separators while encoding the segments', () => {
      const { url } = buildStorageAccessUrl('documents/my folder/a+b.pdf', 300);

      expect(url).toContain('/api/v1/storage/documents/my%20folder/a%2Bb.pdf');
    });

    it('prefixes an absolute base URL when the link leaves the app', () => {
      const { url } = buildStorageAccessUrl(KEY, 300, 'https://app.example.com/');

      expect(url).toMatch(/^https:\/\/app\.example\.com\/api\/v1\/storage\//);
      // No doubled slash from the trailing slash on the base
      expect(url).not.toContain('.com//api');
    });
  });
});
