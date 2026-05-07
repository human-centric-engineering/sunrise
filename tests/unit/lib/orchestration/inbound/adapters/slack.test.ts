/**
 * Tests: SlackAdapter — HMAC-SHA256 verification + handshake + normalise.
 *
 * Security-critical: HMAC replay-window logic uses `Math.abs(nowSec - ts) > MAX_AGE_SEC`
 * with MAX_AGE_SEC = 300. Boundary at exactly 300 passes (strict `>`).
 *
 * Timestamp tests use vi.useFakeTimers() so Date.now() is deterministic.
 * Always restored in afterEach to avoid leaking fake timers between tests.
 *
 * @see lib/orchestration/inbound/adapters/slack.ts
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { SlackAdapter } from '@/lib/orchestration/inbound/adapters/slack';
import type { VerifyContext } from '@/lib/orchestration/inbound/types';

// ─── Constants ────────────────────────────────────────────────────────────────

const SIGNING_SECRET = 'test-signing-secret-abc123';
const PINNED_NOW_SEC = 1_714_000_000; // fixed epoch second for deterministic window tests
const PINNED_NOW_MS = PINNED_NOW_SEC * 1000;
const MAX_AGE_SEC = 300;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Generate a valid Slack-style HMAC signature for the given inputs. */
function makeSlackSignature(secret: string, ts: number, body: string): string {
  const hex = createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex');
  return `v0=${hex}`;
}

/** Build a VerifyContext with optional overrides. */
function makeCtx(rawBody = '{"type":"event_callback"}'): VerifyContext {
  return {
    signingSecret: null, // Slack adapter uses its own secret from constructor, not per-trigger
    metadata: {},
    rawBody,
  };
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('SlackAdapter.handleHandshake', () => {
  const adapter = new SlackAdapter(SIGNING_SECRET);

  it('returns null when body.type is not url_verification', () => {
    // Arrange
    const body = { type: 'event_callback', event: { type: 'message' } };

    // Act
    const result = adapter.handleHandshake(body);

    // Assert
    expect(result).toBeNull();
  });

  it('returns null when body is null', () => {
    const result = adapter.handleHandshake(null);
    expect(result).toBeNull();
  });

  it('returns null when body is undefined', () => {
    const result = adapter.handleHandshake(undefined);
    expect(result).toBeNull();
  });

  it('returns 200 with text/plain content-type echoing body.challenge verbatim', async () => {
    // Arrange
    const body = { type: 'url_verification', challenge: 'abc123xyz' };

    // Act
    const result = adapter.handleHandshake(body);

    // Assert — must not be null; must be a real Response
    expect(result).not.toBeNull();
    const response = result as Response;
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/plain/);
    const text = await response.text();
    expect(text).toBe('abc123xyz');
  });

  it('returns 200 with empty body when challenge is missing', async () => {
    // Arrange — type is url_verification but no challenge property
    const body = { type: 'url_verification' };

    // Act
    const result = adapter.handleHandshake(body);

    // Assert — graceful: 200 empty body, no throw
    expect(result).not.toBeNull();
    const response = result as Response;
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe('');
  });

  it('returns 200 with empty body when challenge is non-string (number)', async () => {
    // Arrange — challenge exists but is not a string
    const body = { type: 'url_verification', challenge: 42 };

    // Act
    const result = adapter.handleHandshake(body);

    // Assert — non-string challenge → treated as absent → empty string body
    expect(result).not.toBeNull();
    const response = result as Response;
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe('');
  });
});

describe('SlackAdapter.verify — missing headers', () => {
  const adapter = new SlackAdapter(SIGNING_SECRET);
  const RAW_BODY = '{"type":"event_callback"}';

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns missing_signature when x-slack-signature is absent', async () => {
    // Arrange — only timestamp header present
    const ts = String(PINNED_NOW_SEC);
    const req = new NextRequest('https://example.com/', {
      method: 'POST',
      headers: { 'x-slack-request-timestamp': ts },
    });

    // Act
    const result = await adapter.verify(req, makeCtx(RAW_BODY));

    // Assert
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('missing_signature');
    }
  });

  it('returns missing_signature when x-slack-request-timestamp is absent', async () => {
    // Arrange — only signature header present
    const sig = makeSlackSignature(SIGNING_SECRET, PINNED_NOW_SEC, RAW_BODY);
    const req = new NextRequest('https://example.com/', {
      method: 'POST',
      headers: { 'x-slack-signature': sig },
    });

    // Act
    const result = await adapter.verify(req, makeCtx(RAW_BODY));

    // Assert
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('missing_signature');
    }
  });
});

describe('SlackAdapter.verify — bad_format', () => {
  const adapter = new SlackAdapter(SIGNING_SECRET);
  const RAW_BODY = '{"type":"event_callback"}';

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns bad_format when signature lacks v0= prefix', async () => {
    // Arrange — strip the prefix
    const hex = createHmac('sha256', SIGNING_SECRET)
      .update(`v0:${PINNED_NOW_SEC}:${RAW_BODY}`)
      .digest('hex');
    const req = new NextRequest('https://example.com/', {
      method: 'POST',
      headers: {
        'x-slack-signature': hex, // raw hex without v0=
        'x-slack-request-timestamp': String(PINNED_NOW_SEC),
      },
    });

    // Act
    const result = await adapter.verify(req, makeCtx(RAW_BODY));

    // Assert
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('bad_format');
    }
  });

  it('returns bad_format on non-hex signature value after prefix stripped', async () => {
    // Arrange — prefix present but hex portion is invalid
    const req = new NextRequest('https://example.com/', {
      method: 'POST',
      headers: {
        'x-slack-signature': 'v0=zzznotvalidhex!!!',
        'x-slack-request-timestamp': String(PINNED_NOW_SEC),
      },
    });

    // Act
    const result = await adapter.verify(req, makeCtx(RAW_BODY));

    // Assert
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('bad_format');
    }
  });

  it('returns bad_format on non-numeric timestamp', async () => {
    // Arrange
    const sig = makeSlackSignature(SIGNING_SECRET, PINNED_NOW_SEC, RAW_BODY);
    const req = new NextRequest('https://example.com/', {
      method: 'POST',
      headers: {
        'x-slack-signature': sig,
        'x-slack-request-timestamp': 'not-a-number',
      },
    });

    // Act
    const result = await adapter.verify(req, makeCtx(RAW_BODY));

    // Assert
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('bad_format');
    }
  });

  it('returns bad_format on non-integer timestamp (float)', async () => {
    // Arrange — Number("3.14") passes isFinite but fails isInteger
    const sig = makeSlackSignature(SIGNING_SECRET, PINNED_NOW_SEC, RAW_BODY);
    const req = new NextRequest('https://example.com/', {
      method: 'POST',
      headers: {
        'x-slack-signature': sig,
        'x-slack-request-timestamp': '3.14',
      },
    });

    // Act
    const result = await adapter.verify(req, makeCtx(RAW_BODY));

    // Assert
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('bad_format');
    }
  });
});

describe('SlackAdapter.verify — stale_timestamp (replay window)', () => {
  const adapter = new SlackAdapter(SIGNING_SECRET);
  const RAW_BODY = '{"type":"event_callback"}';

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns stale_timestamp when timestamp is more than 300s in the past', async () => {
    // Arrange — pin wall clock to PINNED_NOW_SEC; ts is 301s earlier
    vi.useFakeTimers();
    vi.setSystemTime(new Date(PINNED_NOW_MS));
    const staleTs = PINNED_NOW_SEC - (MAX_AGE_SEC + 1); // 301s in past
    const sig = makeSlackSignature(SIGNING_SECRET, staleTs, RAW_BODY);
    const req = new NextRequest('https://example.com/', {
      method: 'POST',
      headers: {
        'x-slack-signature': sig,
        'x-slack-request-timestamp': String(staleTs),
      },
    });

    // Act
    const result = await adapter.verify(req, makeCtx(RAW_BODY));

    // Assert
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('stale_timestamp');
    }
  });

  it('returns stale_timestamp when timestamp is more than 300s in the future (clock skew defence)', async () => {
    // Arrange — ts is 301s ahead of pinned wall clock
    vi.useFakeTimers();
    vi.setSystemTime(new Date(PINNED_NOW_MS));
    const futureTs = PINNED_NOW_SEC + (MAX_AGE_SEC + 1); // 301s in future
    const sig = makeSlackSignature(SIGNING_SECRET, futureTs, RAW_BODY);
    const req = new NextRequest('https://example.com/', {
      method: 'POST',
      headers: {
        'x-slack-signature': sig,
        'x-slack-request-timestamp': String(futureTs),
      },
    });

    // Act
    const result = await adapter.verify(req, makeCtx(RAW_BODY));

    // Assert
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('stale_timestamp');
    }
  });

  it('accepts timestamp at exactly the 300s boundary (Math.abs === 300 passes strict >)', async () => {
    // Arrange — Math.abs(nowSec - ts) === 300; source uses `>` so this must pass
    vi.useFakeTimers();
    vi.setSystemTime(new Date(PINNED_NOW_MS));
    const boundaryTs = PINNED_NOW_SEC - MAX_AGE_SEC; // exactly 300s ago
    const sig = makeSlackSignature(SIGNING_SECRET, boundaryTs, RAW_BODY);
    const req = new NextRequest('https://example.com/', {
      method: 'POST',
      headers: {
        'x-slack-signature': sig,
        'x-slack-request-timestamp': String(boundaryTs),
      },
    });

    // Act
    const result = await adapter.verify(req, makeCtx(RAW_BODY));

    // Assert — valid:true proves source uses strict > (not >=)
    expect(result.valid).toBe(true);
  });
});

describe('SlackAdapter.verify — bad_signature', () => {
  const adapter = new SlackAdapter(SIGNING_SECRET);
  const RAW_BODY = '{"type":"event_callback"}';

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns bad_signature on tampered body (sig computed over different body)', async () => {
    // Arrange — sign the original body but send a tampered one in ctx
    vi.useFakeTimers();
    vi.setSystemTime(new Date(PINNED_NOW_MS));
    const sig = makeSlackSignature(SIGNING_SECRET, PINNED_NOW_SEC, RAW_BODY);
    const req = new NextRequest('https://example.com/', {
      method: 'POST',
      headers: {
        'x-slack-signature': sig,
        'x-slack-request-timestamp': String(PINNED_NOW_SEC),
      },
    });

    // Act — ctx.rawBody differs from the body the sig was computed over
    const result = await adapter.verify(req, makeCtx(`${RAW_BODY} tampered`));

    // Assert
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('bad_signature');
    }
  });

  it('returns bad_signature on tampered signature (one hex byte flipped)', async () => {
    // Arrange — flip one character of the valid hex portion
    vi.useFakeTimers();
    vi.setSystemTime(new Date(PINNED_NOW_MS));
    const validSig = makeSlackSignature(SIGNING_SECRET, PINNED_NOW_SEC, RAW_BODY);
    // Flip the first hex character after 'v0='
    const originalHexByte = validSig[3]; // char at index 3 (first hex byte after 'v0=')
    const flippedByte = originalHexByte === 'a' ? 'b' : 'a';
    const tamperedSig = 'v0=' + flippedByte + validSig.slice(4);
    const req = new NextRequest('https://example.com/', {
      method: 'POST',
      headers: {
        'x-slack-signature': tamperedSig,
        'x-slack-request-timestamp': String(PINNED_NOW_SEC),
      },
    });

    // Act
    const result = await adapter.verify(req, makeCtx(RAW_BODY));

    // Assert
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('bad_signature');
    }
  });

  it('returns bad_signature on signature length mismatch (62 hex chars instead of 64)', async () => {
    // Arrange — a hex string with wrong byte-length hits provided.length !== expected.length
    vi.useFakeTimers();
    vi.setSystemTime(new Date(PINNED_NOW_MS));
    // 62 hex chars = 31 bytes; expected is 32 bytes (SHA-256)
    const shortHex = 'a'.repeat(62);
    const req = new NextRequest('https://example.com/', {
      method: 'POST',
      headers: {
        'x-slack-signature': `v0=${shortHex}`,
        'x-slack-request-timestamp': String(PINNED_NOW_SEC),
      },
    });

    // Act
    const result = await adapter.verify(req, makeCtx(RAW_BODY));

    // Assert — length mismatch branch returns bad_signature (not bad_format)
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('bad_signature');
    }
  });
});

describe('SlackAdapter.verify — happy path', () => {
  const adapter = new SlackAdapter(SIGNING_SECRET);
  const RAW_BODY = '{"type":"event_callback","event":{"type":"message","text":"hello"}}';

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns valid:true on correct HMAC over v0:{timestamp}:{rawBody}', async () => {
    // Arrange — fresh signature with pinned clock
    vi.useFakeTimers();
    vi.setSystemTime(new Date(PINNED_NOW_MS));
    const sig = makeSlackSignature(SIGNING_SECRET, PINNED_NOW_SEC, RAW_BODY);
    const req = new NextRequest('https://example.com/', {
      method: 'POST',
      headers: {
        'x-slack-signature': sig,
        'x-slack-request-timestamp': String(PINNED_NOW_SEC),
      },
    });

    // Act
    const result = await adapter.verify(req, makeCtx(RAW_BODY));

    // Assert — code must have computed the same HMAC to reach valid:true
    expect(result.valid).toBe(true);
  });

  it('returns valid:true and does NOT include externalId (event_id comes from normalise)', async () => {
    // Arrange — verify does not read event_id from the body
    vi.useFakeTimers();
    vi.setSystemTime(new Date(PINNED_NOW_MS));
    const sig = makeSlackSignature(SIGNING_SECRET, PINNED_NOW_SEC, RAW_BODY);
    const req = new NextRequest('https://example.com/', {
      method: 'POST',
      headers: {
        'x-slack-signature': sig,
        'x-slack-request-timestamp': String(PINNED_NOW_SEC),
      },
    });

    // Act
    const result = await adapter.verify(req, makeCtx(RAW_BODY));

    // Assert — externalId is sourced from normalise, not verify, for Slack
    expect(result.valid).toBe(true);
    expect(result).not.toHaveProperty('externalId');
  });
});

describe('SlackAdapter.normalise — event_callback envelope', () => {
  const adapter = new SlackAdapter(SIGNING_SECRET);
  const mockHeaders = new Headers();

  it('maps event_callback envelope fields correctly', () => {
    // Arrange
    const body = {
      type: 'event_callback',
      team_id: 'T01ABCDEF',
      api_app_id: 'A01XYZNOP',
      event_time: 1714000000,
      event_id: 'Ev01XYZ',
      event: {
        type: 'message',
        user: 'U01USER',
        channel: 'C01CHAN',
        channel_type: 'channel',
        text: 'Hello world',
        ts: '1714000000.123456',
        thread_ts: '1714000000.000000',
      },
    };

    // Act
    const result = adapter.normalise(body, mockHeaders);

    // Assert — channel set to adapter's channel slug, payload maps all fields
    expect(result.channel).toBe('slack');
    expect(result.payload).toMatchObject({
      teamId: 'T01ABCDEF',
      appId: 'A01XYZNOP',
      eventTime: 1714000000,
      type: 'message',
      user: 'U01USER',
      channel: 'C01CHAN',
      channelType: 'channel',
      text: 'Hello world',
      ts: '1714000000.123456',
      threadTs: '1714000000.000000',
    });
  });

  it('sets externalId from outer event_id when present', () => {
    // Arrange
    const body = {
      type: 'event_callback',
      event_id: 'Ev01XYZ123',
      event: { type: 'message' },
    };

    // Act
    const result = adapter.normalise(body, mockHeaders);

    // Assert
    expect(result.externalId).toBe('Ev01XYZ123');
  });

  it('omits externalId (not undefined — property absent) when event_id is absent', () => {
    // Arrange — no event_id in body
    const body = { type: 'event_callback', event: { type: 'message' } };

    // Act
    const result = adapter.normalise(body, mockHeaders);

    // Assert — not.toHaveProperty checks the property is not set at all
    expect(result).not.toHaveProperty('externalId');
  });

  it('sets eventType from inner event.type when present', () => {
    // Arrange
    const body = {
      type: 'event_callback',
      event: { type: 'app_mention' },
    };

    // Act
    const result = adapter.normalise(body, mockHeaders);

    // Assert
    expect(result.eventType).toBe('app_mention');
  });

  it('omits eventType when event.type is absent', () => {
    // Arrange — event has no type field
    const body = { type: 'event_callback', event: { user: 'U01USER' } };

    // Act
    const result = adapter.normalise(body, mockHeaders);

    // Assert
    expect(result).not.toHaveProperty('eventType');
  });

  it('preserves bot_id alongside (or in place of) user', () => {
    // Arrange — bot event: has bot_id, no user
    const body = {
      type: 'event_callback',
      event: {
        type: 'message',
        bot_id: 'B01BOT',
        channel: 'C01CHAN',
        text: 'bot message',
        ts: '1714000000.999',
      },
    };

    // Act
    const result = adapter.normalise(body, mockHeaders);

    // Assert — botId in payload, user defaults to ''
    expect(result.payload.botId).toBe('B01BOT');
    expect(result.payload.user).toBe('');
  });

  it('produces empty-string defaults for every payload field when event is empty', () => {
    // Arrange — body has no event fields
    const body = {
      type: 'event_callback',
      event: {},
    };

    // Act
    const result = adapter.normalise(body, mockHeaders);

    // Assert — no crash; all payload string fields default to ''
    expect(result.payload.type).toBe('');
    expect(result.payload.user).toBe('');
    expect(result.payload.botId).toBe('');
    expect(result.payload.channel).toBe('');
    expect(result.payload.channelType).toBe('');
    expect(result.payload.text).toBe('');
    expect(result.payload.ts).toBe('');
    expect(result.payload.threadTs).toBe('');
    expect(result.payload.teamId).toBe('');
    expect(result.payload.appId).toBe('');
    expect(result.payload.eventTime).toBe(0);
  });

  it('produces empty-string defaults for every payload field when body is null — no crash', () => {
    // Arrange
    const body = null;

    // Act — must not throw; null body treated as empty envelope
    const result = adapter.normalise(body, mockHeaders);

    // Assert
    expect(result.channel).toBe('slack');
    expect(result.payload.type).toBe('');
    expect(result.payload.user).toBe('');
    expect(result.payload.text).toBe('');
    expect(result.payload.teamId).toBe('');
    expect(result.payload.eventTime).toBe(0);
    expect(result).not.toHaveProperty('externalId');
    expect(result).not.toHaveProperty('eventType');
  });
});
