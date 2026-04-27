/**
 * Unit tests for lib/orchestration/hooks/types.ts
 *
 * Tests: hasReservedHookHeader, WebhookActionSchema, HookEventPayloadSchema,
 * HOOK_EVENT_TYPES, and RESERVED_HEADER_ERROR constants.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock isSafeProviderUrl so we control URL validation without network access.
// Default: allow all URLs — individual tests override when testing rejection.
vi.mock('@/lib/security/safe-url', () => ({
  isSafeProviderUrl: vi.fn().mockReturnValue(true),
}));

// Mock the signing module to use real header names — the test verifies
// case-insensitive matching against these values.
vi.mock('@/lib/orchestration/hooks/signing', () => ({
  SIGNATURE_HEADER: 'X-Sunrise-Signature',
  TIMESTAMP_HEADER: 'X-Sunrise-Timestamp',
}));

import { isSafeProviderUrl } from '@/lib/security/safe-url';
import {
  hasReservedHookHeader,
  WebhookActionSchema,
  HookEventPayloadSchema,
  HOOK_EVENT_TYPES,
  RESERVED_HEADER_ERROR,
} from '@/lib/orchestration/hooks/types';

// ---------------------------------------------------------------------------
// hasReservedHookHeader
// ---------------------------------------------------------------------------

describe('hasReservedHookHeader', () => {
  it('returns true when headers contain the signature header (exact case)', () => {
    // Arrange
    const headers = { 'X-Sunrise-Signature': 'sha256=abc' };

    // Act
    const result = hasReservedHookHeader(headers);

    // Assert
    expect(result).toBe(true);
  });

  it('returns true when headers contain the timestamp header (exact case)', () => {
    // Arrange
    const headers = { 'X-Sunrise-Timestamp': '1700000000' };

    // Act
    const result = hasReservedHookHeader(headers);

    // Assert
    expect(result).toBe(true);
  });

  it('returns true when the reserved header is provided in all-lowercase', () => {
    // Arrange — case-insensitive check: lowercase key should still match
    const headers = { 'x-sunrise-signature': 'sha256=abc' };

    // Act
    const result = hasReservedHookHeader(headers);

    // Assert
    expect(result).toBe(true);
  });

  it('returns true when the reserved header is provided in all-uppercase', () => {
    // Arrange
    const headers = { 'X-SUNRISE-TIMESTAMP': '1700000000' };

    // Act
    const result = hasReservedHookHeader(headers);

    // Assert
    expect(result).toBe(true);
  });

  it('returns false when no reserved headers are present', () => {
    // Arrange
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer token' };

    // Act
    const result = hasReservedHookHeader(headers);

    // Assert
    expect(result).toBe(false);
  });

  it('returns false for empty headers object', () => {
    // Arrange
    const headers: Record<string, string> = {};

    // Act
    const result = hasReservedHookHeader(headers);

    // Assert
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RESERVED_HEADER_ERROR
// ---------------------------------------------------------------------------

describe('RESERVED_HEADER_ERROR', () => {
  it('is a non-empty string', () => {
    expect(typeof RESERVED_HEADER_ERROR).toBe('string');
    expect(RESERVED_HEADER_ERROR.length).toBeGreaterThan(0);
  });

  it('mentions both reserved header names', () => {
    expect(RESERVED_HEADER_ERROR).toContain('X-Sunrise-Signature');
    expect(RESERVED_HEADER_ERROR).toContain('X-Sunrise-Timestamp');
  });
});

// ---------------------------------------------------------------------------
// HOOK_EVENT_TYPES
// ---------------------------------------------------------------------------

describe('HOOK_EVENT_TYPES', () => {
  it('is a non-empty readonly tuple', () => {
    expect(Array.isArray(HOOK_EVENT_TYPES)).toBe(true);
    expect(HOOK_EVENT_TYPES.length).toBeGreaterThan(0);
  });

  it('contains expected event types', () => {
    expect(HOOK_EVENT_TYPES).toContain('conversation.started');
    expect(HOOK_EVENT_TYPES).toContain('message.created');
    expect(HOOK_EVENT_TYPES).toContain('workflow.started');
    expect(HOOK_EVENT_TYPES).toContain('workflow.completed');
    expect(HOOK_EVENT_TYPES).toContain('workflow.failed');
    expect(HOOK_EVENT_TYPES).toContain('agent.updated');
  });
});

// ---------------------------------------------------------------------------
// WebhookActionSchema
// ---------------------------------------------------------------------------

describe('WebhookActionSchema', () => {
  beforeEach(() => {
    // Default: isSafeProviderUrl returns true (safe URL)
    vi.mocked(isSafeProviderUrl).mockReturnValue(true);
  });

  it('accepts a valid webhook action with type and https URL', () => {
    // Arrange
    const input = { type: 'webhook', url: 'https://example.com/hook' };

    // Act
    const result = WebhookActionSchema.safeParse(input);

    // Assert
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('webhook');
      expect(result.data.url).toBe('https://example.com/hook');
    }
  });

  it('accepts a valid webhook action with optional headers', () => {
    // Arrange
    const input = {
      type: 'webhook',
      url: 'https://example.com/hook',
      headers: { 'X-Custom': 'value' },
    };

    // Act
    const result = WebhookActionSchema.safeParse(input);

    // Assert
    expect(result.success).toBe(true);
  });

  it('rejects when type is not "webhook"', () => {
    // Arrange
    const input = { type: 'email', url: 'https://example.com/hook' };

    // Act
    const result = WebhookActionSchema.safeParse(input);

    // Assert
    expect(result.success).toBe(false);
  });

  it('rejects when url is not a valid URL', () => {
    // Arrange
    const input = { type: 'webhook', url: 'not-a-url' };

    // Act
    const result = WebhookActionSchema.safeParse(input);

    // Assert
    expect(result.success).toBe(false);
  });

  it('rejects when isSafeProviderUrl returns false (private/internal URL)', () => {
    // Arrange — override mock to reject this URL
    vi.mocked(isSafeProviderUrl).mockReturnValue(false);
    const input = { type: 'webhook', url: 'http://192.168.1.1/hook' };

    // Act
    const result = WebhookActionSchema.safeParse(input);

    // Assert
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.toLowerCase().includes('not allowed'))).toBe(true);
    }
  });

  it('rejects when url field is missing', () => {
    // Arrange
    const input = { type: 'webhook' };

    // Act
    const result = WebhookActionSchema.safeParse(input);

    // Assert
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HookEventPayloadSchema
// ---------------------------------------------------------------------------

describe('HookEventPayloadSchema', () => {
  it('accepts a valid payload with a known event type and ISO 8601 timestamp', () => {
    // Arrange
    const input = {
      eventType: 'conversation.started',
      timestamp: '2024-01-15T10:30:00.000Z',
      data: { conversationId: 'abc-123' },
    };

    // Act
    const result = HookEventPayloadSchema.safeParse(input);

    // Assert
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.eventType).toBe('conversation.started');
    }
  });

  it('rejects an unknown eventType', () => {
    // Arrange
    const input = {
      eventType: 'unknown.event',
      timestamp: '2024-01-15T10:30:00.000Z',
      data: {},
    };

    // Act
    const result = HookEventPayloadSchema.safeParse(input);

    // Assert
    expect(result.success).toBe(false);
  });

  it('rejects a non-ISO timestamp string', () => {
    // Arrange
    const input = {
      eventType: 'message.created',
      timestamp: 'not-a-date',
      data: {},
    };

    // Act
    const result = HookEventPayloadSchema.safeParse(input);

    // Assert
    expect(result.success).toBe(false);
  });

  it('rejects payload missing the data field', () => {
    // Arrange
    const input = {
      eventType: 'workflow.started',
      timestamp: '2024-01-15T10:30:00.000Z',
    };

    // Act
    const result = HookEventPayloadSchema.safeParse(input);

    // Assert
    expect(result.success).toBe(false);
  });

  it('accepts all known HOOK_EVENT_TYPES', () => {
    // Arrange & Act & Assert
    for (const eventType of HOOK_EVENT_TYPES) {
      const input = {
        eventType,
        timestamp: '2024-06-01T00:00:00.000Z',
        data: { test: true },
      };
      const result = HookEventPayloadSchema.safeParse(input);
      expect(result.success, `Expected ${eventType} to be valid`).toBe(true);
    }
  });
});
