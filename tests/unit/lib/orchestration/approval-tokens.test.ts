/**
 * Unit Test: Stateless HMAC-signed approval tokens
 *
 * @see lib/orchestration/approval-tokens.ts
 *
 * Coverage targets:
 * - Round-trip: generate → verify succeeds
 * - Tampered token → throws
 * - Expired token → throws
 * - Malformed tokens → throw descriptive errors
 * - buildApprovalUrls produces valid URLs with tokens
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
  generateApprovalToken,
  verifyApprovalToken,
  buildApprovalUrls,
} from '@/lib/orchestration/approval-tokens';

const SECRET = 'test-secret-that-is-at-least-32-characters-long';

/** Mint a token with an arbitrary payload, signed correctly. */
function signPayload(payload: unknown): string {
  const json = JSON.stringify(payload);
  const signature = createHmac('sha256', SECRET).update(json, 'utf8').digest('base64url');
  return `${Buffer.from(json, 'utf8').toString('base64url')}.${signature}`;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('approval-tokens', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-29T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('generateApprovalToken', () => {
    it('generates a token with dot-separated payload and signature', () => {
      const { token } = generateApprovalToken('exec-1', 'approve');
      expect(token).toContain('.');
      const parts = token.split('.');
      expect(parts).toHaveLength(2);
      expect(parts[0].length).toBeGreaterThan(0);
      expect(parts[1].length).toBeGreaterThan(0);
    });

    it('sets default expiry to 7 days', () => {
      const { expiresAt } = generateApprovalToken('exec-1', 'approve');
      const expectedExpiry = new Date('2026-04-29T12:00:00Z');
      expectedExpiry.setMinutes(expectedExpiry.getMinutes() + 7 * 24 * 60);
      expect(expiresAt.getTime()).toBe(expectedExpiry.getTime());
    });

    it('respects custom expiry', () => {
      const { expiresAt } = generateApprovalToken('exec-1', 'approve', 60);
      const expectedExpiry = new Date('2026-04-29T13:00:00Z');
      expect(expiresAt.getTime()).toBe(expectedExpiry.getTime());
    });
  });

  describe('verifyApprovalToken', () => {
    it('round-trips: generate → verify succeeds', () => {
      const { token } = generateApprovalToken('exec-1', 'approve', 60);
      const payload = verifyApprovalToken(token);
      expect(payload.executionId).toBe('exec-1');
      expect(payload.action).toBe('approve');
    });

    it('round-trips reject action', () => {
      const { token } = generateApprovalToken('exec-2', 'reject', 120);
      const payload = verifyApprovalToken(token);
      expect(payload.executionId).toBe('exec-2');
      expect(payload.action).toBe('reject');
    });

    it('throws on tampered payload', () => {
      const { token } = generateApprovalToken('exec-1', 'approve', 60);
      const [, signature] = token.split('.');
      // Create a different payload
      const tamperedPayload = Buffer.from(
        JSON.stringify({
          executionId: 'exec-hacked',
          action: 'approve',
          expiresAt: new Date().toISOString(),
        })
      ).toString('base64url');
      expect(() => verifyApprovalToken(`${tamperedPayload}.${signature}`)).toThrow(
        'Invalid approval token signature'
      );
    });

    it('throws on tampered signature', () => {
      const { token } = generateApprovalToken('exec-1', 'approve', 60);
      const [payload] = token.split('.');
      expect(() => verifyApprovalToken(`${payload}.tampered-sig`)).toThrow(
        'Invalid approval token signature'
      );
    });

    it('throws on expired token', () => {
      const { token } = generateApprovalToken('exec-1', 'approve', 60);
      // Advance time past expiry
      vi.advanceTimersByTime(61 * 60_000);
      expect(() => verifyApprovalToken(token)).toThrow('Approval token has expired');
    });

    it('throws on missing dot separator', () => {
      expect(() => verifyApprovalToken('nodot')).toThrow('Invalid approval token format');
    });

    it('throws on invalid base64 payload', () => {
      expect(() => verifyApprovalToken('!!!invalid.sig')).toThrow(
        'Invalid approval token signature'
      );
    });

    it('throws on validly-signed token with incomplete payload (missing fields)', () => {
      // Craft a token with valid HMAC but incomplete JSON payload
      const token = signPayload({ typ: 'workflow-approval', executionId: 'exec-1' }); // missing action + expiresAt

      expect(() => verifyApprovalToken(token)).toThrow('Incomplete approval token payload');
    });

    it('throws on validly-signed token with non-JSON payload', () => {
      const payload = 'not-json-at-all';
      const encodedPayload = Buffer.from(payload, 'utf8').toString('base64url');
      const sig = createHmac('sha256', SECRET).update(payload, 'utf8').digest('base64url');
      const token = `${encodedPayload}.${sig}`;

      expect(() => verifyApprovalToken(token)).toThrow('Invalid approval token payload');
    });

    it('returns the correct action without modifying it', () => {
      const approveToken = generateApprovalToken('exec-1', 'approve', 60);
      const rejectToken = generateApprovalToken('exec-1', 'reject', 60);

      expect(verifyApprovalToken(approveToken.token).action).toBe('approve');
      expect(verifyApprovalToken(rejectToken.token).action).toBe('reject');
    });
  });

  // #507: this scheme and `lib/storage/access-tokens.ts` HMAC the same
  // construction with the same secret, so the MAC cannot tell them apart —
  // a signature minted there verifies structurally here. Before the `typ` tag,
  // the only thing stopping a cross-scheme replay was that the two payload
  // schemas happened to be disjoint on required fields, which is a property of
  // today's shapes rather than a decision anyone made.
  describe('domain separation from the storage-token scheme', () => {
    it('rejects an authentically signed storage token', () => {
      const token = signPayload({
        typ: 'storage-read',
        key: 'documents/user-1/contract.pdf',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });

      expect(() => verifyApprovalToken(token)).toThrow(
        'Approval token payload is not a workflow-approval token'
      );
    });

    it('rejects a payload that satisfies both schemas at once', () => {
      // The failure the tag exists for, and the one the disjointness accident
      // does not cover: a single payload carrying every field both verifiers
      // require. Untagged, one signature over this is simultaneously a valid
      // approval on exec-1 and a valid read grant for that storage key.
      const token = signPayload({
        key: 'documents/user-1/contract.pdf',
        executionId: 'exec-1',
        action: 'approve',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });

      // Rejected as untagged — which is what this payload is. The tagged
      // version of the same shape is the next test.
      expect(() => verifyApprovalToken(token)).toThrow(
        'Approval token payload is missing its scheme tag'
      );
    });

    it('rejects a both-schemas payload tagged for the other scheme', () => {
      // Same superset shape, but tagged `storage-read`. This is the one the
      // tag is really for: authentic, complete, satisfies every field this
      // verifier requires, and belongs to the other protocol.
      const token = signPayload({
        typ: 'storage-read',
        key: 'documents/user-1/contract.pdf',
        executionId: 'exec-1',
        action: 'approve',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });

      expect(() => verifyApprovalToken(token)).toThrow(
        'Approval token payload is not a workflow-approval token'
      );
    });

    it('tells a legacy untagged token apart from a wrong-scheme one', () => {
      // The dominant shape for the first week after deploy: an approval link
      // emailed before the tag existed. The scheme was right and the token
      // merely predates the check, so reporting "not a workflow-approval
      // token" would send whoever is debugging the deploy hunting a
      // cross-scheme bug that isn't there.
      const token = signPayload({
        executionId: 'exec-1',
        action: 'approve',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });

      expect(() => verifyApprovalToken(token)).toThrow(
        'Approval token payload is missing its scheme tag'
      );
    });

    it('covers the tag with the signature, so a token cannot be retagged', () => {
      // Domain separation is only worth anything if the tag is inside the
      // signed bytes. Same payload, same expiry, tag swapped, original
      // signature — this must fail on the MAC, not on the tag check.
      const expiresAt = '2099-01-01T00:00:00.000Z';
      const signed = signPayload({
        typ: 'workflow-approval',
        executionId: 'exec-1',
        action: 'approve',
        expiresAt,
      });
      const signature = signed.slice(signed.indexOf('.') + 1);
      const retagged = Buffer.from(
        JSON.stringify({
          typ: 'storage-read',
          executionId: 'exec-1',
          action: 'approve',
          expiresAt,
        }),
        'utf8'
      ).toString('base64url');

      expect(() => verifyApprovalToken(`${retagged}.${signature}`)).toThrow(
        'Invalid approval token signature'
      );
    });
  });

  describe('buildApprovalUrls', () => {
    it('builds approve and reject URLs with tokens', () => {
      const { approveUrl, rejectUrl, expiresAt } = buildApprovalUrls(
        'exec-1',
        'https://app.example.com'
      );

      expect(approveUrl).toContain('/api/v1/orchestration/approvals/exec-1/approve?token=');
      expect(rejectUrl).toContain('/api/v1/orchestration/approvals/exec-1/reject?token=');
      expect(expiresAt).toBeInstanceOf(Date);
    });

    it('respects custom expiry', () => {
      const { expiresAt } = buildApprovalUrls('exec-1', 'https://app.example.com', 120);
      const expectedExpiry = new Date('2026-04-29T14:00:00Z');
      expect(expiresAt.getTime()).toBe(expectedExpiry.getTime());
    });

    it('produces URLs with verifiable tokens', () => {
      const { approveUrl, rejectUrl } = buildApprovalUrls('exec-1', 'https://app.example.com', 60);

      // Extract tokens from URLs
      const approveToken = decodeURIComponent(new URL(approveUrl).searchParams.get('token')!);
      const rejectToken = decodeURIComponent(new URL(rejectUrl).searchParams.get('token')!);

      const approvePayload = verifyApprovalToken(approveToken);
      expect(approvePayload.executionId).toBe('exec-1');
      expect(approvePayload.action).toBe('approve');

      const rejectPayload = verifyApprovalToken(rejectToken);
      expect(rejectPayload.executionId).toBe('exec-1');
      expect(rejectPayload.action).toBe('reject');
    });
  });
});
