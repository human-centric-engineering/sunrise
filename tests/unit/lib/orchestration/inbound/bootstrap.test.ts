/**
 * Tests: Inbound adapter bootstrap.
 *
 * `bootstrapInboundAdapters()` is idempotent — only the first call registers
 * adapters. `resetBootstrapState()` re-arms it for subsequent calls.
 *
 * Registry interactions are tested via a mock of `@/lib/orchestration/inbound/registry`
 * so we count registrations per-channel without touching the real adapter map.
 * Env vars are managed with vi.stubEnv / vi.unstubAllEnvs.
 *
 * @see lib/orchestration/inbound/bootstrap.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock registry — count registerInboundAdapter calls without side-effects on
// the real singleton map.
// ---------------------------------------------------------------------------

vi.mock('@/lib/orchestration/inbound/registry', () => ({
  registerInboundAdapter: vi.fn(),
  getInboundAdapter: vi.fn(),
  listInboundChannels: vi.fn(() => []),
  resetInboundAdapters: vi.fn(),
}));

// Mock logger to prevent output noise in tests.
vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { registerInboundAdapter } from '@/lib/orchestration/inbound/registry';
import { GenericHmacAdapter } from '@/lib/orchestration/inbound/adapters/generic-hmac';
import { PostmarkAdapter } from '@/lib/orchestration/inbound/adapters/postmark';
import { SlackAdapter } from '@/lib/orchestration/inbound/adapters/slack';
import {
  bootstrapInboundAdapters,
  resetBootstrapState,
} from '@/lib/orchestration/inbound/bootstrap';

// ---------------------------------------------------------------------------
// Reset bootstrap state and mock history before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetBootstrapState();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// GenericHmacAdapter — always registered
// ---------------------------------------------------------------------------

describe('bootstrapInboundAdapters — GenericHmacAdapter', () => {
  it('always registers GenericHmacAdapter regardless of env configuration', () => {
    // Arrange — no env vars set (Postmark/Slack adapters will be skipped)

    // Act
    bootstrapInboundAdapters();

    // Assert — at least one call, and the first adapter passed is a GenericHmacAdapter
    expect(vi.mocked(registerInboundAdapter)).toHaveBeenCalledWith(expect.any(GenericHmacAdapter));
  });
});

// ---------------------------------------------------------------------------
// PostmarkAdapter — conditional on POSTMARK_INBOUND_USER + POSTMARK_INBOUND_PASS
// ---------------------------------------------------------------------------

describe('bootstrapInboundAdapters — PostmarkAdapter', () => {
  it('registers PostmarkAdapter when both POSTMARK_INBOUND_USER and POSTMARK_INBOUND_PASS are set', () => {
    // Arrange
    vi.stubEnv('POSTMARK_INBOUND_USER', 'pm-user');
    vi.stubEnv('POSTMARK_INBOUND_PASS', 'pm-pass');

    // Act
    bootstrapInboundAdapters();

    // Assert — a PostmarkAdapter instance was registered
    expect(vi.mocked(registerInboundAdapter)).toHaveBeenCalledWith(expect.any(PostmarkAdapter));
  });

  it('does NOT register PostmarkAdapter when only POSTMARK_INBOUND_USER is set', () => {
    // Arrange — pass is absent
    vi.stubEnv('POSTMARK_INBOUND_USER', 'pm-user');

    // Act
    bootstrapInboundAdapters();

    // Assert — no PostmarkAdapter in any call
    const calls = vi.mocked(registerInboundAdapter).mock.calls;
    const registeredPostmark = calls.some((args) => args[0] instanceof PostmarkAdapter);
    expect(registeredPostmark).toBe(false);
  });

  it('does NOT register PostmarkAdapter when only POSTMARK_INBOUND_PASS is set', () => {
    // Arrange — user is absent
    vi.stubEnv('POSTMARK_INBOUND_PASS', 'pm-pass');

    // Act
    bootstrapInboundAdapters();

    // Assert — no PostmarkAdapter in any call
    const calls = vi.mocked(registerInboundAdapter).mock.calls;
    const registeredPostmark = calls.some((args) => args[0] instanceof PostmarkAdapter);
    expect(registeredPostmark).toBe(false);
  });

  it('does NOT register PostmarkAdapter when both env vars are set to empty string', () => {
    // Arrange — empty-string values are falsy in JS; bootstrap must check truthiness
    vi.stubEnv('POSTMARK_INBOUND_USER', '');
    vi.stubEnv('POSTMARK_INBOUND_PASS', '');

    // Act
    bootstrapInboundAdapters();

    // Assert — no PostmarkAdapter registered
    const calls = vi.mocked(registerInboundAdapter).mock.calls;
    const registeredPostmark = calls.some((args) => args[0] instanceof PostmarkAdapter);
    expect(registeredPostmark).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SlackAdapter — conditional on SLACK_SIGNING_SECRET
// ---------------------------------------------------------------------------

describe('bootstrapInboundAdapters — SlackAdapter', () => {
  it('registers SlackAdapter when SLACK_SIGNING_SECRET is set to a non-empty string', () => {
    // Arrange
    vi.stubEnv('SLACK_SIGNING_SECRET', 'slack-secret');

    // Act
    bootstrapInboundAdapters();

    // Assert — a SlackAdapter instance was registered
    expect(vi.mocked(registerInboundAdapter)).toHaveBeenCalledWith(expect.any(SlackAdapter));
  });

  it('does NOT register SlackAdapter when SLACK_SIGNING_SECRET is empty string', () => {
    // Arrange — empty string is falsy; should be treated as "not set"
    vi.stubEnv('SLACK_SIGNING_SECRET', '');

    // Act
    bootstrapInboundAdapters();

    // Assert — no SlackAdapter in any call
    const calls = vi.mocked(registerInboundAdapter).mock.calls;
    const registeredSlack = calls.some((args) => args[0] instanceof SlackAdapter);
    expect(registeredSlack).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('bootstrapInboundAdapters — idempotency', () => {
  it('makes zero new registrations on the second call (idempotent)', () => {
    // Arrange — set env vars so all three adapters would register on first call
    vi.stubEnv('POSTMARK_INBOUND_USER', 'pm-user');
    vi.stubEnv('POSTMARK_INBOUND_PASS', 'pm-pass');
    vi.stubEnv('SLACK_SIGNING_SECRET', 'slack-secret');

    // Act — call twice
    bootstrapInboundAdapters();
    const countAfterFirst = vi.mocked(registerInboundAdapter).mock.calls.length;
    bootstrapInboundAdapters();
    const countAfterSecond = vi.mocked(registerInboundAdapter).mock.calls.length;

    // Assert — total call count does not grow after the second invocation
    // (3 adapters registered: GenericHmac, Postmark, Slack)
    expect(countAfterFirst).toBe(3);
    expect(countAfterSecond).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// resetBootstrapState — re-enables bootstrap
// ---------------------------------------------------------------------------

describe('resetBootstrapState', () => {
  it('re-enables bootstrap so a subsequent call registers adapters again', () => {
    // Arrange — bootstrap once, confirm it ran
    bootstrapInboundAdapters();
    const countAfterFirst = vi.mocked(registerInboundAdapter).mock.calls.length;
    expect(countAfterFirst).toBeGreaterThan(0);

    // Act — reset state and clear the call history, then bootstrap again
    resetBootstrapState();
    vi.clearAllMocks();
    bootstrapInboundAdapters();

    // Assert — adapters registered again (count > 0 proves bootstrap re-ran)
    expect(vi.mocked(registerInboundAdapter).mock.calls.length).toBeGreaterThan(0);
  });
});
