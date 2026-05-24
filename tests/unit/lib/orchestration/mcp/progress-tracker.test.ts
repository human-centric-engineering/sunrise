import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const broadcastSpy = vi.fn();
vi.mock('@/lib/orchestration/mcp/singletons', () => ({
  getMcpSessionManager: vi.fn(() => ({
    broadcastNotification: broadcastSpy,
  })),
}));

import {
  createProgressReporter,
  extractProgressToken,
  NOOP_PROGRESS_REPORTER,
  _resetProgressTracker,
} from '@/lib/orchestration/mcp/progress-tracker';

beforeEach(() => {
  vi.clearAllMocks();
  _resetProgressTracker();
});

// ---------------------------------------------------------------------------
// extractProgressToken
// ---------------------------------------------------------------------------

describe('extractProgressToken', () => {
  it('returns null for absent meta', () => {
    expect(extractProgressToken(undefined)).toBeNull();
    expect(extractProgressToken({})).toBeNull();
  });

  it('returns null for explicit null token', () => {
    expect(extractProgressToken({ progressToken: null })).toBeNull();
  });

  it('round-trips a string token verbatim', () => {
    expect(extractProgressToken({ progressToken: 'tok-123' })).toBe('tok-123');
  });

  it('round-trips a finite number token verbatim', () => {
    expect(extractProgressToken({ progressToken: 42 })).toBe(42);
  });

  it('throws RangeError for an empty string token', () => {
    expect(() => extractProgressToken({ progressToken: '' })).toThrow(RangeError);
  });

  it('throws RangeError for a token > 256 chars', () => {
    expect(() => extractProgressToken({ progressToken: 'x'.repeat(257) })).toThrow(RangeError);
  });

  it('throws RangeError for NaN', () => {
    expect(() => extractProgressToken({ progressToken: NaN })).toThrow(RangeError);
  });

  it('throws RangeError for Infinity', () => {
    expect(() => extractProgressToken({ progressToken: Infinity })).toThrow(RangeError);
  });

  it('throws RangeError for non-primitive tokens (object, array)', () => {
    expect(() => extractProgressToken({ progressToken: { x: 1 } })).toThrow(RangeError);
    expect(() => extractProgressToken({ progressToken: [1, 2] })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// createProgressReporter
// ---------------------------------------------------------------------------

describe('createProgressReporter', () => {
  it('returns the no-op reporter when token is null', () => {
    expect(createProgressReporter('s-1', null)).toBe(NOOP_PROGRESS_REPORTER);
  });

  it('emits a notifications/progress only to the originating session', () => {
    const report = createProgressReporter('session-abc', 'tok-1');
    report(25, 100);

    expect(broadcastSpy).toHaveBeenCalledTimes(1);
    const [notification, targets] = broadcastSpy.mock.calls[0];
    expect(notification.method).toBe('notifications/progress');
    expect(notification.params).toEqual({ progressToken: 'tok-1', progress: 25, total: 100 });
    expect(targets).toEqual(['session-abc']);
  });

  it('omits total when not provided', () => {
    const report = createProgressReporter('s-1', 'tok');
    report(50);

    const [notification] = broadcastSpy.mock.calls[0];
    expect(notification.params).toEqual({ progressToken: 'tok', progress: 50 });
    expect(notification.params).not.toHaveProperty('total');
  });

  it('round-trips numeric tokens unchanged', () => {
    const report = createProgressReporter('s-1', 99);
    report(1);

    const [notification] = broadcastSpy.mock.calls[0];
    expect(notification.params.progressToken).toBe(99);
  });

  it('drops notifications above the 50/sec rate limit silently', () => {
    const report = createProgressReporter('s-1', 'tok');
    for (let i = 0; i < 75; i++) report(i);

    // First 50 should land; remaining 25 silently dropped — the operation
    // itself must never block on rate-limit backpressure.
    expect(broadcastSpy).toHaveBeenCalledTimes(50);
  });

  it('drops non-finite progress and total values', () => {
    const report = createProgressReporter('s-1', 'tok');
    report(NaN);
    report(Infinity);
    report(1, NaN);
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('rate limit is per-session — separate sessions get independent budgets', () => {
    const a = createProgressReporter('session-a', 'tok-a');
    const b = createProgressReporter('session-b', 'tok-b');
    for (let i = 0; i < 50; i++) a(i);
    b(1);
    expect(broadcastSpy).toHaveBeenCalledTimes(51);
  });
});
