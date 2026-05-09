/**
 * Pure-function tests for approval-card-helpers.ts
 *
 * All functions under test are stateless and have no external dependencies —
 * no mocking required. Tests follow AAA pattern with one concern per `it`.
 */

import { describe, it, expect } from 'vitest';
import {
  reducer,
  extractFinalOutput,
  safeStringify,
  MAX_FOLLOWUP_RENDER_CHARS,
} from '@/components/admin/orchestration/chat/approval-card-helpers';
import type {
  CardState,
  ReducerEvent,
} from '@/components/admin/orchestration/chat/approval-card-helpers';

// ---------------------------------------------------------------------------
// extractFinalOutput
// ---------------------------------------------------------------------------

describe('extractFinalOutput', () => {
  it('returns null for a non-array string input', () => {
    // Arrange
    const input = 'not an array';

    // Act
    const result = extractFinalOutput(input);

    // Assert
    expect(result).toBeNull();
  });

  it('returns null for a non-array number input', () => {
    // Arrange
    const input = 42;

    // Act
    const result = extractFinalOutput(input);

    // Assert
    expect(result).toBeNull();
  });

  it('returns null for a non-array object input', () => {
    // Arrange
    const input = { status: 'completed', output: 'data' };

    // Act
    const result = extractFinalOutput(input);

    // Assert
    expect(result).toBeNull();
  });

  it('returns null for null input', () => {
    // Act
    const result = extractFinalOutput(null);

    // Assert
    expect(result).toBeNull();
  });

  it('returns null for an empty array', () => {
    // Act
    const result = extractFinalOutput([]);

    // Assert
    expect(result).toBeNull();
  });

  it('returns null when no entries have status completed', () => {
    // Arrange
    const trace = [
      { status: 'failed', output: 'ignored' },
      { status: 'pending', output: 'ignored' },
    ];

    // Act
    const result = extractFinalOutput(trace);

    // Assert
    expect(result).toBeNull();
  });

  it('returns the last completed entry output from a mixed-status array', () => {
    // Arrange — two completed entries; the last one wins
    const trace = [
      { status: 'completed', output: 'A' },
      { status: 'failed' },
      { status: 'completed', output: 'B' },
    ];

    // Act
    const result = extractFinalOutput(trace);

    // Assert: last completed entry's output
    expect(result).toBe('B');
  });

  it('returns null when the last completed entry has output: undefined', () => {
    // Arrange — completed entry with no output property — tests the ?? null branch
    const trace = [{ status: 'completed' }];

    // Act
    const result = extractFinalOutput(trace);

    // Assert
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// safeStringify
// ---------------------------------------------------------------------------

describe('safeStringify', () => {
  it('returns empty string for null', () => {
    expect(safeStringify(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(safeStringify(undefined)).toBe('');
  });

  it('returns the string unchanged when it is within the char limit', () => {
    // Arrange
    const input = 'hello world';

    // Act
    const result = safeStringify(input);

    // Assert: no truncation applied
    expect(result).toBe('hello world');
  });

  it('serialises an object to a JSON string', () => {
    // Arrange
    const input = { refundId: 'r-99', amount: 42.5 };

    // Act
    const result = safeStringify(input);

    // Assert: the result is valid JSON matching the object
    expect(JSON.parse(result)).toEqual(input);
  });

  it('truncates a string longer than MAX_FOLLOWUP_RENDER_CHARS and appends the advisory suffix', () => {
    // Arrange: construct a string that exceeds the limit
    const longString = 'x'.repeat(MAX_FOLLOWUP_RENDER_CHARS + 1);

    // Act
    const result = safeStringify(longString);

    // Assert: result starts with the first MAX chars and ends with the truncation notice
    expect(result).toContain('… [truncated;');
    expect(result).toContain(`${MAX_FOLLOWUP_RENDER_CHARS + 1} chars total`);
    expect(result.startsWith('x'.repeat(MAX_FOLLOWUP_RENDER_CHARS))).toBe(true);
  });

  it('returns "[unserializable]" for values that cannot be JSON-serialised (e.g. BigInt)', () => {
    // Arrange: BigInt cannot be serialised via JSON.stringify
    const unserializable = BigInt(1);

    // Act
    const result = safeStringify(unserializable);

    // Assert
    expect(result).toBe('[unserializable]');
  });
});

// ---------------------------------------------------------------------------
// reducer — guard branches (no-op transitions)
// ---------------------------------------------------------------------------

describe('reducer — no-op guard branches', () => {
  it('submit_ok dispatched when not in submitting state returns the same state', () => {
    // Arrange: state is idle, not submitting
    const state: CardState = { kind: 'idle' };
    const event: ReducerEvent = { type: 'submit_ok' };

    // Act
    const next = reducer(state, event);

    // Assert: guard returns state unchanged (same reference)
    expect(next).toBe(state);
  });

  it('poll_completed dispatched when not in waiting state returns the same state', () => {
    // Arrange: state is idle, not waiting
    const state: CardState = { kind: 'idle' };
    const event: ReducerEvent = { type: 'poll_completed' };

    // Act
    const next = reducer(state, event);

    // Assert: guard returns state unchanged (same reference)
    expect(next).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// reducer — fallback message branches
// ---------------------------------------------------------------------------

describe('reducer — fallback message branches', () => {
  it('falls back to "Workflow failed" when poll_failed has no payload message', () => {
    // Arrange: waiting state — poll_failed dispatched without a payload message
    const waitingState: CardState = { kind: 'waiting', action: 'approve' };
    const event: ReducerEvent = { type: 'poll_failed' };

    // Act
    const next = reducer(waitingState, event);

    // Assert: fallback ?? 'Workflow failed' at source L44
    expect(next).toEqual({ kind: 'failed', message: 'Workflow failed' });
  });

  it('falls back to "Action failed" when failure has no payload message', () => {
    // Arrange: idle state — generic failure event with no payload
    const state: CardState = { kind: 'idle' };
    const event: ReducerEvent = { type: 'failure' };

    // Act
    const next = reducer(state, event);

    // Assert: fallback ?? 'Action failed' at source L48
    expect(next).toEqual({ kind: 'failed', message: 'Action failed' });
  });
});
