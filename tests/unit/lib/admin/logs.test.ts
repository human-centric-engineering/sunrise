/**
 * Unit Tests: lib/admin/logs.ts
 *
 * Tests the in-memory ring buffer that backs the admin logs viewer.
 * No Prisma or logger dependencies — this module is pure in-memory state.
 *
 * IMPORTANT: Each test calls clearLogBuffer() in beforeEach to reset module-level
 * mutable state. Without this, tests are order-dependent (brittle pattern #11).
 *
 * Coverage target: 85%
 * Exports under test: addLogEntry, getLogEntries, clearLogBuffer, getBufferSize, getMaxBufferSize
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  addLogEntry,
  getLogEntries,
  clearLogBuffer,
  getBufferSize,
  getMaxBufferSize,
} from '@/lib/admin/logs';
import type { LogEntry } from '@/types/admin';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<Omit<LogEntry, 'id'>> = {}): Omit<LogEntry, 'id'> {
  return {
    timestamp: new Date().toISOString(),
    level: 'info',
    message: 'Test log message',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('lib/admin/logs', () => {
  beforeEach(() => {
    // Reset module-level mutable state before every test.
    // vi.clearAllMocks() does NOT touch plain objects — explicit reset is required.
    clearLogBuffer();
  });

  // -------------------------------------------------------------------------
  // clearLogBuffer / getBufferSize / getMaxBufferSize
  // -------------------------------------------------------------------------

  describe('clearLogBuffer', () => {
    it('should empty the buffer and reset size to zero', () => {
      // Arrange
      addLogEntry(makeEntry());
      addLogEntry(makeEntry());
      expect(getBufferSize()).toBe(2);

      // Act
      clearLogBuffer();

      // Assert
      expect(getBufferSize()).toBe(0);
    });

    it('should make getLogEntries return an empty entries array after clearing', () => {
      // Arrange
      addLogEntry(makeEntry({ message: 'will be cleared' }));

      // Act
      clearLogBuffer();
      const result = getLogEntries({});

      // Assert
      expect(result.entries).toEqual([]);
      expect(result.total).toBe(0);
    });
  });

  describe('getMaxBufferSize', () => {
    it('should return 1000', () => {
      expect(getMaxBufferSize()).toBe(1000);
    });
  });

  // -------------------------------------------------------------------------
  // addLogEntry
  // -------------------------------------------------------------------------

  describe('addLogEntry', () => {
    it('should add an entry that is then retrievable via getLogEntries', () => {
      // Arrange
      const entry = makeEntry({ message: 'Hello from test', level: 'warn' });

      // Act
      addLogEntry(entry);
      const { entries } = getLogEntries({});

      // Assert — verify the code persisted the entry, not just that it returned something
      expect(entries).toHaveLength(1);
      expect(entries[0].message).toBe('Hello from test');
      expect(entries[0].level).toBe('warn');
      expect(entries[0].id).toBeDefined();
    });

    it('should auto-generate an id when none is provided', () => {
      // Arrange / Act
      addLogEntry(makeEntry());
      const { entries } = getLogEntries({});

      // Assert — id must follow the log_N prefix pattern
      expect(entries[0].id).toMatch(/^log_\d+$/);
    });

    it('should preserve a caller-supplied id', () => {
      // Arrange
      const entry = { ...makeEntry(), id: 'custom-id-abc' };

      // Act
      addLogEntry(entry);
      const { entries } = getLogEntries({});

      // Assert
      expect(entries[0].id).toBe('custom-id-abc');
    });

    it('should evict the oldest entry when the buffer reaches MAX_BUFFER_SIZE', () => {
      // Arrange — fill the buffer to its limit
      const maxSize = getMaxBufferSize();
      for (let i = 0; i < maxSize; i++) {
        addLogEntry(makeEntry({ message: `entry-${i}` }));
      }
      expect(getBufferSize()).toBe(maxSize);

      // Act — add one more, triggering eviction of the oldest
      addLogEntry(makeEntry({ message: 'overflow-entry' }));

      // Assert — buffer must not exceed MAX_BUFFER_SIZE
      expect(getBufferSize()).toBe(maxSize);

      // The overflow-entry is present (newest)
      const { entries } = getLogEntries({ limit: maxSize });
      const hasOverflow = entries.some((e) => e.message === 'overflow-entry');
      expect(hasOverflow).toBe(true);

      // The original entry-0 was evicted (oldest)
      const hasFirstEntry = entries.some((e) => e.message === 'entry-0');
      expect(hasFirstEntry).toBe(false);
    }, 10000);
  });

  // -------------------------------------------------------------------------
  // getLogEntries — paginated shape
  // -------------------------------------------------------------------------

  describe('getLogEntries — paginated shape', () => {
    it('should return entries and total in the expected shape', () => {
      // Arrange
      addLogEntry(makeEntry({ message: 'a' }));
      addLogEntry(makeEntry({ message: 'b' }));

      // Act
      const result = getLogEntries({ page: 1, limit: 10 });

      // Assert — verify the return CONTRACT, not just the mock return value
      expect(result).toHaveProperty('entries');
      expect(result).toHaveProperty('total');
      expect(Array.isArray(result.entries)).toBe(true);
      expect(typeof result.total).toBe('number');
      expect(result.total).toBe(2);
      expect(result.entries).toHaveLength(2);
    });

    it('should sort entries newest-first (descending timestamp)', () => {
      // Arrange — add with explicit distinct timestamps
      addLogEntry(makeEntry({ message: 'older', timestamp: '2025-01-01T00:00:00.000Z' }));
      addLogEntry(makeEntry({ message: 'newer', timestamp: '2025-06-01T00:00:00.000Z' }));

      // Act
      const { entries } = getLogEntries({});

      // Assert — first item must be the newer one
      expect(entries[0].message).toBe('newer');
      expect(entries[1].message).toBe('older');
    });

    it('should paginate: page 1 returns first N entries', () => {
      // Arrange — add 5 entries
      for (let i = 1; i <= 5; i++) {
        addLogEntry(makeEntry({ message: `msg-${i}`, timestamp: `2025-01-0${i}T00:00:00.000Z` }));
      }

      // Act — request page 1 with limit 3 (sorted newest-first, so msgs 5,4,3)
      const result = getLogEntries({ page: 1, limit: 3 });

      // Assert
      expect(result.total).toBe(5);
      expect(result.entries).toHaveLength(3);
    });

    it('should paginate: page 2 returns the remaining entries', () => {
      // Arrange — add 5 entries with fixed timestamps so sort order is deterministic
      for (let i = 1; i <= 5; i++) {
        addLogEntry(makeEntry({ message: `msg-${i}`, timestamp: `2025-01-0${i}T00:00:00.000Z` }));
      }

      // Act — page 2 with limit 3 should return 2 entries (4 + 5 total, offset 3)
      const result = getLogEntries({ page: 2, limit: 3 });

      // Assert
      expect(result.total).toBe(5);
      expect(result.entries).toHaveLength(2);
    });

    it('should apply default pagination (page 1, limit 50) when options are omitted', () => {
      // Arrange — add 60 entries
      for (let i = 0; i < 60; i++) {
        addLogEntry(makeEntry({ message: `entry-${i}` }));
      }

      // Act — no pagination options supplied
      const result = getLogEntries({});

      // Assert — default limit of 50 is applied; total reflects all 60
      expect(result.total).toBe(60);
      expect(result.entries).toHaveLength(50);
    });
  });

  // -------------------------------------------------------------------------
  // getLogEntries — empty buffer
  // -------------------------------------------------------------------------

  describe('getLogEntries — empty buffer', () => {
    it('should return an empty array (not null/undefined) when the buffer is empty', () => {
      // Act
      const result = getLogEntries({});

      // Assert — must be an empty array, not null, to satisfy callers that call .length
      expect(result.entries).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('should return empty array when level filter matches nothing in an empty buffer', () => {
      // Act
      const result = getLogEntries({ level: 'error' });

      // Assert
      expect(result.entries).toEqual([]);
      expect(result.total).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // getLogEntries — level filter
  // -------------------------------------------------------------------------

  describe('getLogEntries — level filter', () => {
    it('should return only entries matching the requested level', () => {
      // Arrange
      addLogEntry(makeEntry({ level: 'info', message: 'info-msg' }));
      addLogEntry(makeEntry({ level: 'warn', message: 'warn-msg' }));
      addLogEntry(makeEntry({ level: 'error', message: 'error-msg' }));
      addLogEntry(makeEntry({ level: 'debug', message: 'debug-msg' }));

      // Act
      const result = getLogEntries({ level: 'error' });

      // Assert — only the error entry is returned; total reflects filtered count
      expect(result.total).toBe(1);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].message).toBe('error-msg');
      expect(result.entries[0].level).toBe('error');
    });

    it('should return all entries when no level filter is applied', () => {
      // Arrange
      addLogEntry(makeEntry({ level: 'info' }));
      addLogEntry(makeEntry({ level: 'warn' }));
      addLogEntry(makeEntry({ level: 'error' }));

      // Act
      const result = getLogEntries({});

      // Assert
      expect(result.total).toBe(3);
      expect(result.entries).toHaveLength(3);
    });

    it('should return empty entries when level filter matches no records', () => {
      // Arrange — add only info entries
      addLogEntry(makeEntry({ level: 'info', message: 'info-1' }));
      addLogEntry(makeEntry({ level: 'info', message: 'info-2' }));

      // Act — filter for debug which doesn't exist
      const result = getLogEntries({ level: 'debug' });

      // Assert — total must be 0 (filtered), not 2 (total buffer size)
      expect(result.total).toBe(0);
      expect(result.entries).toEqual([]);
    });

    it('should filter correctly for each supported level value', () => {
      // Arrange
      const levels = ['debug', 'info', 'warn', 'error'] as const;
      levels.forEach((level) => {
        addLogEntry(makeEntry({ level, message: `${level}-message` }));
      });

      // Act + Assert — each level filter returns exactly one entry
      levels.forEach((level) => {
        const result = getLogEntries({ level });
        expect(result.total).toBe(1);
        expect(result.entries[0].level).toBe(level);
        expect(result.entries[0].message).toBe(`${level}-message`);
      });
    });
  });

  // -------------------------------------------------------------------------
  // getLogEntries — search filter
  // -------------------------------------------------------------------------

  describe('getLogEntries — search filter', () => {
    it('should match entries whose message contains the search term (case-insensitive)', () => {
      // Arrange
      addLogEntry(makeEntry({ message: 'Database connection failed' }));
      addLogEntry(makeEntry({ message: 'User logged in' }));

      // Act — search is case-insensitive per the implementation
      const result = getLogEntries({ search: 'database' });

      // Assert
      expect(result.total).toBe(1);
      expect(result.entries[0].message).toBe('Database connection failed');
    });

    it('should match entries whose context contains the search term', () => {
      // Arrange
      addLogEntry(
        makeEntry({ message: 'generic', context: { requestId: 'req-abc-123', userId: 'u1' } })
      );
      addLogEntry(makeEntry({ message: 'other' }));

      // Act
      const result = getLogEntries({ search: 'req-abc-123' });

      // Assert — the match came from context, not message
      expect(result.total).toBe(1);
      expect(result.entries[0].message).toBe('generic');
    });

    it('should return empty when search term matches nothing', () => {
      // Arrange
      addLogEntry(makeEntry({ message: 'Hello world' }));

      // Act
      const result = getLogEntries({ search: 'xyzzy-no-match' });

      // Assert
      expect(result.total).toBe(0);
      expect(result.entries).toEqual([]);
    });
  });
});
