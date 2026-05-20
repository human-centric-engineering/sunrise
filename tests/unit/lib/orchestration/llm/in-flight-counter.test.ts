/**
 * Tests for `lib/orchestration/llm/in-flight-counter.ts`.
 *
 * All tests are pure in-memory — no mocks, no DB, no timers.
 * Real async / async iterators are used throughout.
 *
 * Covers:
 *   - track() increments on entry and decrements on resolve
 *   - track() decrements on reject (try/finally guarantee)
 *   - track() handles concurrent calls per slug
 *   - track() keeps per-slug counts independent
 *   - trackStream() holds the count for the full iteration lifetime
 *   - trackStream() releases on early break
 *   - trackStream() releases when the generator throws mid-iteration
 *   - trackStream() releases when the factory function throws synchronously
 *   - getInFlightCounts() sort order: descending count, alpha for ties
 *   - getInFlightCounts() snapshot is stable under concurrent modification
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  track,
  trackStream,
  getInFlightCounts,
  __resetInFlightCountersForTests,
} from '@/lib/orchestration/llm/in-flight-counter';

beforeEach(() => {
  __resetInFlightCountersForTests();
});

// ---------------------------------------------------------------------------
// track()
// ---------------------------------------------------------------------------

describe('track()', () => {
  it('increments the count while the promise is in flight and removes the entry on resolve', async () => {
    // Arrange: a promise that yields control so we can observe the count mid-flight
    let resolveOuter!: (v: number) => void;
    const inner = new Promise<number>((resolve) => {
      resolveOuter = resolve;
    });

    // Act: start tracking without awaiting yet
    const tracked = track('a', () => inner);

    // Assert: count is 1 while the promise is pending
    expect(getInFlightCounts()).toEqual([{ provider: 'a', inFlight: 1 }]);

    // Settle and await
    resolveOuter(42);
    const result = await tracked;

    // Assert: return value propagated and entry pruned (not shown as 0)
    expect(result).toBe(42);
    expect(getInFlightCounts()).toEqual([]);
  });

  it('decrements on reject so the counter never leaks', async () => {
    // Arrange: a promise that rejects
    const boom = new Error('boom');

    // Act & Assert: rejection bubbles to the caller
    await expect(track('a', () => Promise.reject(boom))).rejects.toThrow('boom');

    // Assert: count cleaned up despite the error
    expect(getInFlightCounts()).toEqual([]);
  });

  it('counts three concurrent calls for the same slug correctly and clears on completion', async () => {
    // Arrange: three resolvers to release in a controlled order
    const resolvers: Array<() => void> = [];

    const makePromise = () =>
      new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });

    // Act: start all three — do not await yet
    const p1 = track('p', makePromise);
    const p2 = track('p', makePromise);
    const p3 = track('p', makePromise);

    // Assert: all three are in flight simultaneously
    expect(getInFlightCounts()).toEqual([{ provider: 'p', inFlight: 3 }]);

    // Settle all
    resolvers.forEach((r) => r());
    await Promise.all([p1, p2, p3]);

    // Assert: entry removed after all settle
    expect(getInFlightCounts()).toEqual([]);
  });

  it('tracks two slugs independently without bleeding into each other', async () => {
    // Arrange: one resolver per slug
    let resolveX!: () => void;
    let resolveY!: () => void;

    const px = track('x', () => new Promise<void>((r) => (resolveX = r)));
    const py = track('y', () => new Promise<void>((r) => (resolveY = r)));

    // Assert: both slugs present at the correct count
    const counts = getInFlightCounts();
    expect(counts).toHaveLength(2);
    expect(counts.find((c) => c.provider === 'x')).toEqual({ provider: 'x', inFlight: 1 });
    expect(counts.find((c) => c.provider === 'y')).toEqual({ provider: 'y', inFlight: 1 });

    // Settle x first — y should remain
    resolveX();
    await px;
    expect(getInFlightCounts()).toEqual([{ provider: 'y', inFlight: 1 }]);

    // Settle y — everything clear
    resolveY();
    await py;
    expect(getInFlightCounts()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// trackStream()
// ---------------------------------------------------------------------------

describe('trackStream()', () => {
  it('holds the count for the full lifetime of a streaming iteration', async () => {
    // Arrange: generator that yields three values, pausing between each with setImmediate
    async function* source() {
      yield 1;
      await new Promise<void>((r) => setImmediate(r));
      yield 2;
      await new Promise<void>((r) => setImmediate(r));
      yield 3;
    }

    const stream = trackStream('s', source);
    const iter = stream[Symbol.asyncIterator]();

    // Count is 1 once the iterator is created (increment happens in [Symbol.asyncIterator])
    expect(getInFlightCounts()).toEqual([{ provider: 's', inFlight: 1 }]);

    // Consume first value — still in flight
    await iter.next();
    expect(getInFlightCounts()).toEqual([{ provider: 's', inFlight: 1 }]);

    // Consume remaining values until done
    await iter.next();
    await iter.next();
    await iter.next(); // receives { done: true }

    // Assert: count released after natural completion
    expect(getInFlightCounts()).toEqual([]);
  });

  it('releases the count when the caller breaks out of the loop early', async () => {
    // Arrange: infinite generator so the only exit is a break
    async function* infinite() {
      let i = 0;
      while (true) {
        yield i++;
      }
    }

    const values: number[] = [];

    // Act: iterate and break after the first value
    for await (const v of trackStream('s', infinite)) {
      values.push(v);
      break;
    }

    // Assert: one value consumed, count back to zero
    expect(values).toEqual([0]);
    expect(getInFlightCounts()).toEqual([]);
  });

  it('releases the count when the generator throws mid-iteration', async () => {
    // Arrange: generator that throws on the second next()
    async function* faultySource() {
      yield 'first';
      throw new Error('stream error');
    }

    let caughtError: Error | undefined;

    // Act: iterate, expect the error on the second iteration
    try {
      for await (const _ of trackStream('s', faultySource)) {
        // first yield consumed fine
      }
    } catch (err) {
      caughtError = err as Error;
    }

    // Assert: error propagated and count cleaned up
    expect(caughtError?.message).toBe('stream error');
    expect(getInFlightCounts()).toEqual([]);
  });

  it('releases the count when the iterator factory throws synchronously', async () => {
    // Arrange: fn that throws before returning an iterable
    const factoryError = new Error('factory threw');
    const throwingFactory = (): AsyncIterable<never> => {
      throw factoryError;
    };

    let caughtError: Error | undefined;

    // Act: obtain the iterable (no throw yet) then start iteration (throws here)
    const iterable = trackStream('s', throwingFactory);
    try {
      // The increment happens inside [Symbol.asyncIterator](), which is also
      // where the factory call is attempted. Materialising the iterator is
      // enough — we don't need to assign it.
      iterable[Symbol.asyncIterator]();
    } catch (err) {
      caughtError = err as Error;
    }

    // Assert: factory error propagated and no counter leaked
    expect(caughtError?.message).toBe('factory threw');
    expect(getInFlightCounts()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getInFlightCounts()
// ---------------------------------------------------------------------------

describe('getInFlightCounts()', () => {
  it('sorts descending by count then alphabetically for equal counts', async () => {
    // Arrange: three in-flight groups — b:1, a:2, c:2
    // Use unresolved promises so all stay in flight during the assertion
    let resolveA1!: () => void;
    let resolveA2!: () => void;
    let resolveB!: () => void;
    let resolveC1!: () => void;
    let resolveC2!: () => void;

    const makeP = (setter: (r: () => void) => void) => new Promise<void>((r) => setter(r));

    // a=2: two concurrent calls
    const pa1 = track('a', () => makeP((s) => (resolveA1 = s)));
    const pa2 = track('a', () => makeP((s) => (resolveA2 = s)));
    // b=1: one call
    const pb = track('b', () => makeP((s) => (resolveB = s)));
    // c=2: two concurrent calls
    const pc1 = track('c', () => makeP((s) => (resolveC1 = s)));
    const pc2 = track('c', () => makeP((s) => (resolveC2 = s)));

    // Act: snapshot while all are in flight
    const counts = getInFlightCounts();

    // Assert: desc by count, alpha for ties → [a:2, c:2, b:1]
    expect(counts).toEqual([
      { provider: 'a', inFlight: 2 },
      { provider: 'c', inFlight: 2 },
      { provider: 'b', inFlight: 1 },
    ]);

    // Cleanup
    resolveA1();
    resolveA2();
    resolveB();
    resolveC1();
    resolveC2();
    await Promise.all([pa1, pa2, pb, pc1, pc2]);
  });

  it('snapshot is a new array each call and is not mutated by subsequent in-flight additions', async () => {
    // Arrange: one call already in flight
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;

    const pFirst = track('x', () => new Promise<void>((r) => (resolveFirst = r)));

    // Act: take first snapshot
    const snapshot1 = getInFlightCounts();
    expect(snapshot1).toEqual([{ provider: 'x', inFlight: 1 }]);

    // Start another call — this modifies the internal map
    const pSecond = track('x', () => new Promise<void>((r) => (resolveSecond = r)));

    // Assert: original snapshot reference is unchanged
    expect(snapshot1).toEqual([{ provider: 'x', inFlight: 1 }]);

    // New snapshot reflects the updated count
    const snapshot2 = getInFlightCounts();
    expect(snapshot2).toEqual([{ provider: 'x', inFlight: 2 }]);

    // Cleanup
    resolveFirst();
    resolveSecond();
    await Promise.all([pFirst, pSecond]);
  });
});
