/**
 * Unit Tests: route-module import helpers (test helper)
 *
 * `tests/unit/app/layout-metadata.test.ts` imports every route module through
 * these. If the timeout stops scaling, a large fork's coverage run aborts again
 * (#969); if a failed import stops rejecting, that brand-leak guard passes while
 * checking less.
 *
 * @see tests/helpers/route-module-imports.ts
 */

import { describe, it, expect } from 'vitest';

import {
  mapWithConcurrency,
  ROUTE_IMPORT_TIMEOUT_FLOOR_MS,
  routeImportTimeoutMs,
} from '@/tests/helpers/route-module-imports';

/** Resolves on the next macrotask, so calls genuinely overlap. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('routeImportTimeoutMs', () => {
  it('never drops below the old fixed limit', () => {
    // A fork that deleted most of its routes keeps the budget it always had.
    expect(routeImportTimeoutMs(0)).toBe(ROUTE_IMPORT_TIMEOUT_FLOOR_MS);
    expect(routeImportTimeoutMs(10)).toBe(ROUTE_IMPORT_TIMEOUT_FLOOR_MS);
  });

  it('gives Sunrise its own 91 modules more than the fixed limit that ran out', () => {
    expect(routeImportTimeoutMs(91)).toBeGreaterThan(ROUTE_IMPORT_TIMEOUT_FLOOR_MS);
  });

  it('grows past the fixed limit for the fork size reported in #969', () => {
    // 191 modules overran a fixed 120s. A limit that does not grow with the
    // count is the defect, so the 191-module budget must exceed it.
    expect(routeImportTimeoutMs(191)).toBeGreaterThan(ROUTE_IMPORT_TIMEOUT_FLOOR_MS);
    expect(routeImportTimeoutMs(400)).toBeGreaterThan(routeImportTimeoutMs(191));
  });
});

describe('mapWithConcurrency', () => {
  it('runs more than one call at a time, never more than the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);

    await mapWithConcurrency(items, 4, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
    });

    // Both bounds: 1 would be the old sequential loop, >4 an unbounded fan-out.
    expect(peak).toBe(4);
  });

  it('returns results in input order, whatever order they settle in', async () => {
    const items = [30, 0, 20, 10];
    const out = await mapWithConcurrency(items, 4, async (ms, i) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return `${i}:${ms}`;
    });
    expect(out).toEqual(['0:30', '1:0', '2:20', '3:10']);
  });

  it('rejects when any call rejects, and starts nothing after it', async () => {
    const started: number[] = [];
    const items = Array.from({ length: 10 }, (_, i) => i);

    await expect(
      mapWithConcurrency(items, 2, async (i) => {
        started.push(i);
        // Item 1 fails before yielding, so the failure is recorded before item 0
        // finishes and its worker looks for the next item.
        if (i === 1) throw new Error('Cannot find module @/app/(public)/gone/page');
        await tick();
        return i;
      })
    ).rejects.toThrow('Cannot find module');

    expect(started).toEqual([0, 1]);
  });

  it('lets calls already in flight settle before it rejects', async () => {
    let settled = 0;
    const out = mapWithConcurrency([0, 1, 2], 3, async (i) => {
      if (i === 0) throw new Error('first');
      await new Promise((resolve) => setTimeout(resolve, 20));
      settled++;
    });

    await expect(out).rejects.toThrow('first');
    // Both slow calls finished before the rejection was delivered; with a plain
    // `Promise.all` this would read 0 and they would still be running.
    expect(settled).toBe(2);
  });

  it('handles an empty list and a limit larger than the list', async () => {
    expect(await mapWithConcurrency([], 8, async () => 1)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 8, async (n) => n * 2)).toEqual([2, 4]);
  });

  it('refuses a limit that would run nothing or loop forever', async () => {
    await expect(mapWithConcurrency([1], 0, async (n) => n)).rejects.toThrow(RangeError);
    await expect(mapWithConcurrency([1], 1.5, async (n) => n)).rejects.toThrow(RangeError);
  });
});
