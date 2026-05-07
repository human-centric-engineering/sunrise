/**
 * Unit Tests: PostmarkAdapter
 *
 * Tests the Postmark inbound-parse adapter:
 *   - `verify`: Basic-auth header parsing and constant-time credential comparison
 *   - `normalise`: JSON body flattening into the channel-agnostic NormalisedTriggerPayload
 *
 * No mocking required — pure logic with no I/O.
 *
 * @see lib/orchestration/inbound/adapters/postmark.ts
 */

import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { PostmarkAdapter } from '@/lib/orchestration/inbound/adapters/postmark';
import type { VerifyContext } from '@/lib/orchestration/inbound/types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const EXPECTED_USER = 'inbound-user';
const EXPECTED_PASS = 'inbound-secret-pass';

const adapter = new PostmarkAdapter(EXPECTED_USER, EXPECTED_PASS);

/** Minimal VerifyContext — Postmark adapter ignores ctx entirely. */
const ctx: VerifyContext = {
  signingSecret: null,
  metadata: {},
  rawBody: '',
};

/**
 * Encode a user:pass pair as a Basic-auth header value.
 */
function basicAuth(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
}

/**
 * Build a NextRequest with the given Authorization header (or none).
 */
function makeRequest(authHeader?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) {
    headers['authorization'] = authHeader;
  }
  return new NextRequest('https://example.com/api/v1/inbound/postmark/my-workflow', { headers });
}

/** A realistic Postmark inbound payload (all fields present). */
const fullPostmarkBody = {
  FromFull: { Email: 'alice@example.com', Name: 'Alice' },
  ToFull: [{ Email: 'inbound@example.com', Name: 'Inbound', MailboxHash: 'hash-abc' }],
  CcFull: [{ Email: 'bob@example.com', Name: 'Bob' }],
  Subject: 'Hello there',
  MessageID: 'msg-abc-123',
  Date: 'Wed, 7 May 2026 10:00:00 +0000',
  TextBody: 'Plain text body',
  HtmlBody: '<p>HTML body</p>',
  StrippedTextReply: 'Stripped reply',
  MailboxHash: 'top-level-hash',
  MessageStream: 'inbound',
  Attachments: [
    {
      Name: 'report.pdf',
      Content: 'base64content==',
      ContentType: 'application/pdf',
      ContentLength: 1024,
      ContentID: 'cid-1',
    },
  ],
};

// ─── verify ───────────────────────────────────────────────────────────────────

describe('PostmarkAdapter.verify', () => {
  describe('missing_signature — absent or malformed Authorization header', () => {
    it('returns missing_signature when Authorization header is absent', async () => {
      // Arrange
      const req = makeRequest(/* no header */);

      // Act
      const result = await adapter.verify(req, ctx);

      // Assert
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe('missing_signature');
      }
    });

    it("returns missing_signature when Authorization header doesn't start with 'Basic '", async () => {
      // Arrange
      const req = makeRequest('Bearer some-token');

      // Act
      const result = await adapter.verify(req, ctx);

      // Assert
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe('missing_signature');
      }
    });
  });

  describe('bad_format — base64 decoding and colon separator', () => {
    it('returns bad_format when decoded credentials are missing the colon separator', async () => {
      // Arrange — encode a string without a colon
      const encoded = Buffer.from('usernamepassword', 'utf8').toString('base64');
      const req = makeRequest(`Basic ${encoded}`);

      // Act
      const result = await adapter.verify(req, ctx);

      // Assert
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe('bad_format');
      }
    });
  });

  describe('unauthorized — credential mismatch', () => {
    it('returns unauthorized when username is wrong but password is correct', async () => {
      // Arrange
      const req = makeRequest(basicAuth('wrong-user', EXPECTED_PASS));

      // Act
      const result = await adapter.verify(req, ctx);

      // Assert
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe('unauthorized');
      }
    });

    it('returns unauthorized when password is wrong but username is correct', async () => {
      // Arrange
      const req = makeRequest(basicAuth(EXPECTED_USER, 'wrong-pass'));

      // Act
      const result = await adapter.verify(req, ctx);

      // Assert
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe('unauthorized');
      }
    });

    it('returns unauthorized when both username and password are wrong', async () => {
      // Arrange
      const req = makeRequest(basicAuth('wrong-user', 'wrong-pass'));

      // Act
      const result = await adapter.verify(req, ctx);

      // Assert
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe('unauthorized');
      }
    });
  });

  describe('valid — correct credentials', () => {
    it('returns valid:true on exact-match credentials', async () => {
      // Arrange
      const req = makeRequest(basicAuth(EXPECTED_USER, EXPECTED_PASS));

      // Act
      const result = await adapter.verify(req, ctx);

      // Assert
      expect(result.valid).toBe(true);
    });

    it('returns valid:true and does not include externalId (Postmark verify cannot read body)', async () => {
      // The adapter doc notes that MessageID cannot be read without re-parsing
      // the body — verify always returns {valid:true} without externalId.
      // Arrange
      const req = makeRequest(basicAuth(EXPECTED_USER, EXPECTED_PASS));

      // Act
      const result = await adapter.verify(req, ctx);

      // Assert — verify contract: no externalId on the verify result for Postmark
      expect(result.valid).toBe(true);
      expect(result).not.toHaveProperty('externalId');
    });
  });

  describe('constant-time intent — mismatched lengths should not throw', () => {
    // The timingSafeStringEqual helper performs a constant-time compare via
    // node:crypto.timingSafeEqual. The length-mismatch short-circuit leaks
    // credential length but not content — this is an explicit, documented
    // trade-off in the source code. The constant-time property is verified by
    // code review and the timingSafeEqual import, not by a unit timing assertion.
    // This test confirms that a length mismatch returns a structured failure
    // and never throws, validating the defensive path is reachable.

    it('handles user length mismatch without throwing and returns unauthorized', async () => {
      // Arrange — username much shorter than expected (length-mismatch path)
      const req = makeRequest(basicAuth('x', EXPECTED_PASS));

      // Act
      const result = await adapter.verify(req, ctx);

      // Assert — returns structured failure, not an exception
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe('unauthorized');
      }
    });

    it('handles pass length mismatch without throwing and returns unauthorized', async () => {
      // Arrange — password much shorter than expected (length-mismatch path)
      const req = makeRequest(basicAuth(EXPECTED_USER, 'x'));

      // Act
      const result = await adapter.verify(req, ctx);

      // Assert — returns structured failure, not an exception
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe('unauthorized');
      }
    });
  });
});

// ─── normalise ────────────────────────────────────────────────────────────────

describe('PostmarkAdapter.normalise', () => {
  const headers = new Headers();

  describe('from field', () => {
    it('flattens FromFull into {from: {email, name}}', () => {
      // Arrange + Act
      const result = adapter.normalise(fullPostmarkBody, headers);

      // Assert — from is a computed transformation, not a direct pass-through
      expect(result.payload['from']).toEqual({
        email: 'alice@example.com',
        name: 'Alice',
      });
    });
  });

  describe('to field', () => {
    it('flattens ToFull[] into [{email, name, mailboxHash}]', () => {
      // Arrange + Act
      const result = adapter.normalise(fullPostmarkBody, headers);

      // Assert — to array is mapped and re-shaped, not passed through directly
      expect(result.payload['to']).toEqual([
        {
          email: 'inbound@example.com',
          name: 'Inbound',
          mailboxHash: 'hash-abc',
        },
      ]);
    });
  });

  describe('cc field', () => {
    it('flattens CcFull[] into [{email, name}] and OMITS mailboxHash from cc shape', () => {
      // Arrange + Act
      const result = adapter.normalise(fullPostmarkBody, headers);

      // Assert — cc items deliberately exclude mailboxHash (per channel contract)
      expect(result.payload['cc']).toEqual([{ email: 'bob@example.com', name: 'Bob' }]);
      // Confirm the shape does NOT include mailboxHash even when CcFull has it
      const ccItem = (result.payload['cc'] as Array<Record<string, unknown>>)[0];
      expect(ccItem).not.toHaveProperty('mailboxHash');
    });
  });

  describe('attachments field', () => {
    it('maps Attachments[] to {name, contentType, contentLength, contentBase64, contentId}', () => {
      // Arrange + Act
      const result = adapter.normalise(fullPostmarkBody, headers);

      // Assert — each attachment field is renamed/restructured (not a pass-through)
      expect(result.payload['attachments']).toEqual([
        {
          name: 'report.pdf',
          contentType: 'application/pdf',
          contentLength: 1024,
          contentBase64: 'base64content==',
          contentId: 'cid-1',
        },
      ]);
    });
  });

  describe('externalId from MessageID', () => {
    it('sets externalId from MessageID when present', () => {
      // Arrange + Act
      const result = adapter.normalise(fullPostmarkBody, headers);

      // Assert — MessageID drives the dedup key; adapter extracts and re-exposes it
      expect(result.externalId).toBe('msg-abc-123');
    });

    it('OMITS externalId when MessageID is missing', () => {
      // Arrange — body without MessageID
      const body = { ...fullPostmarkBody, MessageID: undefined };

      // Act
      const result = adapter.normalise(body, headers);

      // Assert — field must be absent, not set to undefined
      expect(result).not.toHaveProperty('externalId');
    });

    it('OMITS externalId when MessageID is empty string', () => {
      // Arrange — empty string is falsy, should be treated as absent
      const body = { ...fullPostmarkBody, MessageID: '' };

      // Act
      const result = adapter.normalise(body, headers);

      // Assert
      expect(result).not.toHaveProperty('externalId');
    });
  });

  describe('eventType', () => {
    it("sets eventType to 'inbound_email' always", () => {
      // Arrange + Act
      const result = adapter.normalise(fullPostmarkBody, headers);

      // Assert — eventType is hardcoded for the Postmark channel
      expect(result.eventType).toBe('inbound_email');
    });
  });

  describe('channel', () => {
    it("sets channel to 'postmark'", () => {
      // Arrange + Act
      const result = adapter.normalise(fullPostmarkBody, headers);

      // Assert
      expect(result.channel).toBe('postmark');
    });
  });

  describe('empty defaults — missing fields', () => {
    it('returns empty-string defaults for every payload field when body is {}', () => {
      // Arrange — completely empty body (all fields missing)
      // Act
      const result = adapter.normalise({}, headers);

      // Assert — adapter must not crash and must produce a full envelope
      expect(result.channel).toBe('postmark');
      expect(result.eventType).toBe('inbound_email');
      expect(result).not.toHaveProperty('externalId');

      const payload = result.payload;
      expect(payload['from']).toEqual({ email: '', name: '' });
      expect(payload['to']).toEqual([]);
      expect(payload['cc']).toEqual([]);
      expect(payload['subject']).toBe('');
      expect(payload['messageId']).toBe('');
      expect(payload['date']).toBe('');
      expect(payload['textBody']).toBe('');
      expect(payload['htmlBody']).toBe('');
      expect(payload['strippedTextReply']).toBe('');
      expect(payload['mailboxHash']).toBe('');
      expect(payload['messageStream']).toBe('');
      expect(payload['attachments']).toEqual([]);
    });

    it('returns empty-string defaults when body is null (no crash)', () => {
      // Arrange — null body exercises the `rawBody ?? {}` nullish-coalescing branch
      // Act
      const result = adapter.normalise(null, headers);

      // Assert — must not throw; full envelope with empty defaults
      expect(result.channel).toBe('postmark');
      expect(result.eventType).toBe('inbound_email');
      expect(result).not.toHaveProperty('externalId');

      const payload = result.payload;
      expect(payload['from']).toEqual({ email: '', name: '' });
      expect(payload['to']).toEqual([]);
      expect(payload['cc']).toEqual([]);
      expect(payload['subject']).toBe('');
      expect(payload['textBody']).toBe('');
      expect(payload['attachments']).toEqual([]);
    });
  });
});
