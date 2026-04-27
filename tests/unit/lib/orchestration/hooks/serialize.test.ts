/**
 * Tests: Hook serialization helpers.
 *
 * toSafeHook strips the raw `secret` column and replaces it with a
 * `hasSecret: boolean` flag so the admin client never receives the
 * plaintext signing secret.
 *
 * Test Coverage:
 * - Non-null secret → hasSecret=true, secret key absent
 * - Null secret → hasSecret=false, secret key absent
 * - Non-secret fields pass through verbatim
 * - Complex JsonValue types in action/filter pass through unchanged
 * - Structural guarantee: returned object has no `secret` property
 *
 * @see lib/orchestration/hooks/serialize.ts
 */

import { describe, it, expect } from 'vitest';
import { toSafeHook } from '@/lib/orchestration/hooks/serialize';
import type { HookRow } from '@/lib/orchestration/hooks/serialize';

// ---------------------------------------------------------------------------
// Shared test fixture
// ---------------------------------------------------------------------------

function makeHookRow(overrides: Partial<HookRow> = {}): HookRow {
  return {
    id: 'hook-123',
    name: 'My Webhook',
    eventType: 'conversation.started',
    action: { url: 'https://example.com/webhook', method: 'POST' },
    filter: null,
    isEnabled: true,
    secret: 'super-secret-value',
    createdBy: 'user-456',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('toSafeHook', () => {
  describe('secret redaction', () => {
    it('should return hasSecret=true when secret is a non-null string', () => {
      // Arrange
      const row = makeHookRow({ secret: 'abc123secretvalue' });

      // Act
      const result = toSafeHook(row);

      // Assert
      expect(result.hasSecret).toBe(true);
    });

    it('should return hasSecret=false when secret is null', () => {
      // Arrange
      const row = makeHookRow({ secret: null });

      // Act
      const result = toSafeHook(row);

      // Assert
      expect(result.hasSecret).toBe(false);
    });

    it('should omit the secret key when secret is non-null', () => {
      // Arrange
      const row = makeHookRow({ secret: 'plaintext-secret' });

      // Act
      const result = toSafeHook(row);

      // Assert — structural guarantee: the property must not exist on the result
      expect('secret' in result).toBe(false);
    });

    it('should omit the secret key when secret is null', () => {
      // Arrange
      const row = makeHookRow({ secret: null });

      // Act
      const result = toSafeHook(row);

      // Assert
      expect('secret' in result).toBe(false);
    });
  });

  describe('field passthrough', () => {
    it('should preserve all non-secret fields verbatim', () => {
      // Arrange
      const row = makeHookRow({
        id: 'hook-abc',
        name: 'Test Hook',
        eventType: 'message.created',
        isEnabled: false,
        createdBy: 'user-999',
        createdAt: new Date('2025-06-15T12:00:00.000Z'),
        updatedAt: new Date('2025-06-16T08:30:00.000Z'),
      });

      // Act
      const result = toSafeHook(row);

      // Assert — each non-secret field is preserved exactly
      expect(result.id).toBe('hook-abc');
      expect(result.name).toBe('Test Hook');
      expect(result.eventType).toBe('message.created');
      expect(result.isEnabled).toBe(false);
      expect(result.createdBy).toBe('user-999');
      expect(result.createdAt).toEqual(new Date('2025-06-15T12:00:00.000Z'));
      expect(result.updatedAt).toEqual(new Date('2025-06-16T08:30:00.000Z'));
    });

    it('should pass through a complex nested object in the action field unchanged', () => {
      // Arrange
      const complexAction = {
        url: 'https://api.example.com/hooks',
        method: 'POST',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        retries: { max: 3, backoff: [1, 2, 4] },
      };
      const row = makeHookRow({ action: complexAction });

      // Act
      const result = toSafeHook(row);

      // Assert — deep equality, not reference equality (spread creates a shallow copy)
      expect(result.action).toEqual(complexAction);
    });

    it('should pass through an array JsonValue in the filter field unchanged', () => {
      // Arrange
      const arrayFilter = ['event.type == "message"', 'user.role == "admin"'];
      const row = makeHookRow({ filter: arrayFilter });

      // Act
      const result = toSafeHook(row);

      // Assert
      expect(result.filter).toEqual(arrayFilter);
    });

    it('should pass through null filter unchanged', () => {
      // Arrange
      const row = makeHookRow({ filter: null });

      // Act
      const result = toSafeHook(row);

      // Assert
      expect(result.filter).toBeNull();
    });
  });
});
