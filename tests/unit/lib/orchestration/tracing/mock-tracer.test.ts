/**
 * Targeted regression tests for MockTracer's AsyncLocalStorage-based parent
 * tracking.
 *
 * Background: MockTracer switched from a synchronous _activeStack to
 * AsyncLocalStorage<RecordedSpan> so concurrent Promise.all branches each see
 * the outer parent without entanglement. These tests lock in that property at
 * the MockTracer level so a refactor back to a sync stack fails here — fast —
 * rather than buried inside an engine integration test.
 *
 * Suspicions probed (each has its own describe block):
 *  1. Parallel siblings: two withSpan branches under Promise.all each parent to
 *     the outer span, not to each other.
 *  2. Three-deep nesting: outer > middle > inner; each level has the immediate
 *     parent via ALS propagation through awaits.
 *  3. startSpan at top level: no withSpan wrap → no ALS store → root span with
 *     parentSpanId === null.
 *  4. startSpan inside withSpan: manual lifecycle mixed with withSpan; the
 *     startSpan sees the withSpan as parent.
 *  5. reset() inside withSpan callback: clears spans + counter but NOT the ALS
 *     store; subsequent startSpan still sees the outer recorded span as parent
 *     (the recorded span itself no longer exists in tracer.spans).
 *  6. withActiveContext with a foreign NOOP_SPAN (not in tracer.spans): falls
 *     through to fn() without ALS run; inner startSpan sees no parent.
 *  7. ALS isolation across tests: ALS store should be empty at the start of
 *     each test; first span produced has parentSpanId === null.
 *  8. Concurrent siblings get distinct, monotonically increasing spanIds.
 *  9. assertSpanTree against a tree built via withSpan / Promise.all.
 * 10. startSpan called concurrently: one from within withActiveContext, one
 *     from outside — both succeed with correct parent linkage.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { NOOP_SPAN } from '@/lib/orchestration/tracing/noop-tracer';
import { MockTracer, ThrowingTracer, assertSpanTree, findSpan } from '@/tests/helpers/mock-tracer';

// ---------------------------------------------------------------------------
// Shared tracer; reset before every test for isolation.
// ---------------------------------------------------------------------------

const tracer = new MockTracer();

beforeEach(() => {
  tracer.reset();
});

// ---------------------------------------------------------------------------
// 1. Parallel siblings under Promise.all
// ---------------------------------------------------------------------------

describe('parallel siblings under Promise.all', () => {
  it('both branches parent to the outer span, not to each other', async () => {
    // Arrange / Act: outer withSpan wraps a Promise.all of two sibling branches
    await tracer.withSpan('outer', {}, async () => {
      await Promise.all([
        tracer.withSpan('branch-a', {}, async () => undefined),
        tracer.withSpan('branch-b', {}, async () => undefined),
      ]);
    });

    // Assert: three spans recorded (outer + branch-a + branch-b)
    expect(tracer.spans).toHaveLength(3);

    const outer = findSpan(tracer.spans, 'outer');
    const branchA = findSpan(tracer.spans, 'branch-a');
    const branchB = findSpan(tracer.spans, 'branch-b');

    // Core regression: both siblings parent to outer, not to each other.
    expect(branchA.parentSpanId).toBe(outer.spanId);
    expect(branchB.parentSpanId).toBe(outer.spanId);

    // Explicit sibling-not-parent check (the bug this test is designed to catch):
    // If the sync stack was re-introduced, branchA would become branchB's parent.
    expect(branchA.spanId).not.toBe(branchB.parentSpanId);
    expect(branchB.spanId).not.toBe(branchA.parentSpanId);

    // Outer is a root span.
    expect(outer.parentSpanId).toBeNull();
  });

  it('three concurrent siblings all parent to outer', async () => {
    // Arrange / Act
    await tracer.withSpan('outer', {}, async () => {
      await Promise.all([
        tracer.withSpan('c1', {}, async () => undefined),
        tracer.withSpan('c2', {}, async () => undefined),
        tracer.withSpan('c3', {}, async () => undefined),
      ]);
    });

    const outer = findSpan(tracer.spans, 'outer');
    const children = tracer.spans.filter((s) => s.parentSpanId === outer.spanId);

    // All three siblings are direct children of outer.
    expect(children).toHaveLength(3);
    expect(children.map((c) => c.name).sort()).toEqual(['c1', 'c2', 'c3']);

    // No child is a parent of another child.
    const childIds = new Set(children.map((c) => c.spanId));
    for (const child of children) {
      // parentSpanId points to outer, not to another sibling.
      expect(childIds.has(child.parentSpanId!)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Three-deep nesting (ALS propagates through awaits)
// ---------------------------------------------------------------------------

describe('three-deep nesting', () => {
  it('each level has the immediate parent — not the grandparent or null', async () => {
    let outerSpanId: string | undefined;
    let middleSpanId: string | undefined;

    await tracer.withSpan('outer', {}, async () => {
      outerSpanId = findSpan(tracer.spans, 'outer').spanId;

      await tracer.withSpan('middle', {}, async () => {
        middleSpanId = findSpan(tracer.spans, 'middle').spanId;

        await tracer.withSpan('inner', {}, async () => {
          // nothing further
        });
      });
    });

    const outer = findSpan(tracer.spans, 'outer');
    const middle = findSpan(tracer.spans, 'middle');
    const inner = findSpan(tracer.spans, 'inner');

    expect(outer.parentSpanId).toBeNull();
    expect(middle.parentSpanId).toBe(outerSpanId);
    expect(inner.parentSpanId).toBe(middleSpanId);

    // Sanity: inner does NOT parent directly to outer (would happen if ALS
    // was leaking the wrong level).
    expect(inner.parentSpanId).not.toBe(outer.spanId);
  });
});

// ---------------------------------------------------------------------------
// 3. startSpan at top level → root span
// ---------------------------------------------------------------------------

describe('startSpan at top level (no withSpan wrap)', () => {
  it('produces a root span with parentSpanId === null', () => {
    // No withSpan around this — ALS store should be empty.
    const span = tracer.startSpan('bare-root');

    expect(tracer.spans).toHaveLength(1);
    const recorded = tracer.spans[0];

    // The span's spanId() matches the recorded id (via MockSpan).
    expect(span.spanId()).toBe(recorded.spanId);
    expect(recorded.name).toBe('bare-root');
    expect(recorded.parentSpanId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. startSpan inside withSpan → sees withSpan as parent
// ---------------------------------------------------------------------------

describe('startSpan inside withSpan (mixed manual + automatic)', () => {
  it('manual startSpan inside a withSpan callback picks up the withSpan as parent', async () => {
    let innerSpan: ReturnType<typeof tracer.startSpan> | undefined;

    await tracer.withSpan('wrapper', {}, async () => {
      innerSpan = tracer.startSpan('manual-child');
      innerSpan.end();
    });

    const wrapper = findSpan(tracer.spans, 'wrapper');
    const child = findSpan(tracer.spans, 'manual-child');

    expect(innerSpan).toBeDefined();
    expect(child.parentSpanId).toBe(wrapper.spanId);
    expect(wrapper.parentSpanId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. reset() inside withSpan callback
// ---------------------------------------------------------------------------

describe('reset() inside withSpan callback', () => {
  it('clears spans and counter but ALS store still holds the outer recorded span', async () => {
    let postResetParentSpanId: string | null | undefined;
    let postResetSpanIdValue: string | undefined;
    let capturedOuterSpanId: string | undefined;
    let spanCountAfterReset: number | undefined;

    await tracer.withSpan('outer', {}, async (outerSpan) => {
      capturedOuterSpanId = outerSpan.spanId();

      // Reset clears the spans array and counter. The ALS store still
      // holds the RecordedSpan object that was recorded before reset().
      tracer.reset();

      // After reset the spans array is empty.
      spanCountAfterReset = tracer.spans.length;

      // Start a new span. The ALS store still references the pre-reset
      // RecordedSpan (which is no longer in tracer.spans). The counter
      // was reset to 0, so this span is "span-1" again.
      const postReset = tracer.startSpan('post-reset');
      postResetParentSpanId = tracer.spans[0].parentSpanId;
      postResetSpanIdValue = postReset.spanId();
    });

    // The reset wiped the spans array.
    expect(spanCountAfterReset).toBe(0);

    // The counter was reset so the new span gets span-1.
    expect(postResetSpanIdValue).toBe('span-1');

    // The ALS store was NOT cleared — the outer RecordedSpan object is
    // still the active context. So post-reset startSpan still links to
    // capturedOuterSpanId (which was also 'span-1' before reset).
    //
    // NOTE: This reveals a subtle hazard. The pre-reset outer span's
    // spanId was 'span-1'. After reset(), the counter restarts at 0, so
    // the new 'post-reset' span also gets spanId 'span-1'. Its
    // parentSpanId is 'span-1' (pointing to the pre-reset span object in
    // the ALS store). This means parentSpanId === spanId — a self-referential
    // link in the recorded data. The parent RecordedSpan object no longer
    // exists in tracer.spans after reset(), and the new span occupies the
    // same spanId slot.
    //
    // This is a known limitation: reset() intentionally does NOT clear the
    // ALS store ("ALS is request-scoped"). Tests must not call reset() from
    // inside an active withSpan callback. If they do, the spanId namespace
    // is re-used from 'span-1' and the resulting parentSpanId links are
    // confusing (they coincidentally match the new span's own spanId).
    expect(postResetParentSpanId).toBe(capturedOuterSpanId);

    // The only span in tracer.spans after reset is the post-reset span —
    // the pre-reset outer span was wiped. The post-reset span's spanId is
    // 'span-1', same as the outer span's id was before reset.
    expect(tracer.spans).toHaveLength(1);
    expect(tracer.spans[0].name).toBe('post-reset');
  });
});

// ---------------------------------------------------------------------------
// 6. withActiveContext with a foreign NOOP_SPAN (not in tracer.spans)
// ---------------------------------------------------------------------------

describe('withActiveContext with a foreign span not in tracer.spans', () => {
  it('falls through to fn() without setting ALS; inner startSpan sees no parent', async () => {
    // NOOP_SPAN.spanId() returns '' — find() over tracer.spans will return undefined.
    let innerParentSpanId: string | null | undefined;

    await tracer.withActiveContext(NOOP_SPAN, async () => {
      tracer.startSpan('inner-after-foreign-ctx');
      innerParentSpanId = tracer.spans[0].parentSpanId;
    });

    // Inner span has no parent (ALS was not set because NOOP_SPAN is foreign).
    expect(innerParentSpanId).toBeNull();
    expect(tracer.spans).toHaveLength(1);
  });

  it('does not throw — fn runs to completion', async () => {
    let ran = false;

    await tracer.withActiveContext(NOOP_SPAN, async () => {
      ran = true;
    });

    expect(ran).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. ALS isolation across tests
// ---------------------------------------------------------------------------

describe('ALS isolation across tests', () => {
  // These tests verify that the ALS store does not bleed from a previous test.
  // Each it() runs in a fresh async chain; beforeEach calls tracer.reset()
  // which clears spans but NOT the ALS store. As long as each test starts
  // outside any withSpan callback, the ALS store should be empty.

  it('first span in a fresh test has parentSpanId === null (ALS store empty)', () => {
    tracer.startSpan('isolation-check-1');
    expect(tracer.spans[0].parentSpanId).toBeNull();
  });

  it('second independent test also starts with empty ALS store', () => {
    tracer.startSpan('isolation-check-2');
    expect(tracer.spans[0].parentSpanId).toBeNull();
  });

  it('third independent test: withSpan outer is still a root span', async () => {
    await tracer.withSpan('isolation-root', {}, async () => undefined);
    const root = findSpan(tracer.spans, 'isolation-root');
    expect(root.parentSpanId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. Concurrent siblings get distinct, monotonically increasing spanIds
// ---------------------------------------------------------------------------

describe('concurrent siblings get distinct monotonically increasing spanIds', () => {
  it('span counter is shared — concurrent branches get span-N / span-N+1', async () => {
    await tracer.withSpan('outer', {}, async () => {
      await Promise.all([
        tracer.withSpan('branch-a', {}, async () => undefined),
        tracer.withSpan('branch-b', {}, async () => undefined),
      ]);
    });

    const ids = tracer.spans.map((s) => s.spanId);

    // All three ids must be unique.
    expect(new Set(ids).size).toBe(3);

    // Counter is strictly increasing; ids are 'span-1', 'span-2', 'span-3'.
    // (The outer starts first, then branch-a and branch-b are started in
    // microtask order determined by Promise.all).
    expect(ids).toEqual(['span-1', 'span-2', 'span-3']);

    // Branches' ids are distinguishable — no aliasing.
    const branchA = findSpan(tracer.spans, 'branch-a');
    const branchB = findSpan(tracer.spans, 'branch-b');
    expect(branchA.spanId).not.toBe(branchB.spanId);
  });

  it('after reset, counter restarts at span-1 — new spans do not collide with pre-reset spans', () => {
    // Arrange: create one span, then reset.
    tracer.startSpan('before-reset');
    expect(tracer.spans[0].spanId).toBe('span-1');

    tracer.reset();

    // After reset, counter is 0 again — next span is span-1 again.
    tracer.startSpan('after-reset');
    expect(tracer.spans[0].spanId).toBe('span-1');
    // Only one span in the array (reset wiped the previous one).
    expect(tracer.spans).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 9. assertSpanTree with a Promise.all-built tree
// ---------------------------------------------------------------------------

describe('assertSpanTree with a parallel-branch tree', () => {
  it('correctly validates a two-level tree where children are parallel siblings', async () => {
    // Act: build a tree via withSpan + Promise.all
    await tracer.withSpan('root', { attributes: { 'step.kind': 'entry' } }, async () => {
      await Promise.all([
        tracer.withSpan('left', {}, async () => undefined),
        tracer.withSpan('right', {}, async () => undefined),
      ]);
    });

    // Assert: assertSpanTree validates the tree shape without throwing.
    // Children are sorted by startTime, so left and right may come in any order;
    // assertSpanTree sorts them and the expected tree is declared in the same
    // order — if startTime ordering varies, the test would fail with a name
    // mismatch rather than silently pass.
    //
    // Because Promise.all starts both promises concurrently and their startSpan
    // calls happen synchronously in JS event loop order, left is always started
    // before right (Promise.all iterates the array in order).
    assertSpanTree(tracer.spans, {
      name: 'root',
      status: 'ok',
      children: [
        { name: 'left', status: 'ok' },
        { name: 'right', status: 'ok' },
      ],
    });
  });

  it('assertSpanTree throws with a descriptive error when span name does not match', async () => {
    // Arrange: build a simple one-level tree.
    await tracer.withSpan('actual-root', {}, async () => {
      await tracer.withSpan('actual-child', {}, async () => undefined);
    });

    // Act / Assert: providing a wrong expected child name should throw with
    // a readable message (not a cryptic assertion failure).
    expect(() =>
      assertSpanTree(tracer.spans, {
        name: 'actual-root',
        children: [{ name: 'wrong-child-name' }],
      })
    ).toThrow(/expected span name 'wrong-child-name'/);
  });

  it('assertSpanTree throws when child count mismatches', async () => {
    // Arrange: one child but expected two.
    await tracer.withSpan('root', {}, async () => {
      await tracer.withSpan('only-child', {}, async () => undefined);
    });

    expect(() =>
      assertSpanTree(tracer.spans, {
        name: 'root',
        children: [{ name: 'only-child' }, { name: 'missing-second' }],
      })
    ).toThrow(/expected 2 children but got 1/);
  });

  it('assertSpanTree validates a three-level deep tree', async () => {
    // Act: build outer > middle > inner
    await tracer.withSpan('outer', {}, async () => {
      await tracer.withSpan('middle', {}, async () => {
        await tracer.withSpan('inner', {}, async () => undefined);
      });
    });

    // Assert: tree traversal covers all three levels without throwing.
    assertSpanTree(tracer.spans, {
      name: 'outer',
      status: 'ok',
      children: [
        {
          name: 'middle',
          status: 'ok',
          children: [{ name: 'inner', status: 'ok' }],
        },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// 10. startSpan concurrent — inside withActiveContext and outside simultaneously
// ---------------------------------------------------------------------------

describe('startSpan concurrent: within withActiveContext and from outside', () => {
  it('in-context startSpan gets the active parent; out-of-context startSpan gets null', async () => {
    // Arrange: create an outer span to use as the active context.
    const contextSpan = tracer.startSpan('context-holder');

    // Now run: inside withActiveContext (sets ALS), simultaneously (simulated via
    // sequential microtasks in JS) call startSpan from outside.
    let insideParent: string | null | undefined;
    let outsideParent: string | null | undefined;

    await Promise.all([
      // Inside: withActiveContext sets the ALS store to contextSpan's RecordedSpan.
      tracer.withActiveContext(contextSpan, async () => {
        const inside = tracer.startSpan('inside-child');
        insideParent = tracer.spans.find((s) => s.spanId === inside.spanId())?.parentSpanId;
      }),
      // Outside: no ALS store active in this branch's async chain.
      (async () => {
        const outside = tracer.startSpan('outside-root');
        outsideParent = tracer.spans.find((s) => s.spanId === outside.spanId())?.parentSpanId;
      })(),
    ]);

    const contextHolder = findSpan(tracer.spans, 'context-holder');

    // inside-child saw context-holder as parent.
    expect(insideParent).toBe(contextHolder.spanId);

    // outside-root had no active ALS store in its branch.
    expect(outsideParent).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Bonus: findSpan helper validation
// ---------------------------------------------------------------------------

describe('findSpan helper', () => {
  it('returns the matching span', () => {
    tracer.startSpan('target');
    const found = findSpan(tracer.spans, 'target');
    expect(found.name).toBe('target');
  });

  it('throws with a diagnostic list when span is not found', () => {
    tracer.startSpan('span-a');
    tracer.startSpan('span-b');

    expect(() => findSpan(tracer.spans, 'span-c')).toThrow(
      /Span not found: 'span-c'. Recorded spans: \[span-a, span-b\]/
    );
  });

  it('uses the attributesPredicate to disambiguate spans with the same name', () => {
    const s1 = tracer.startSpan('duplicate', { attributes: { id: 'first' } });
    const s2 = tracer.startSpan('duplicate', { attributes: { id: 'second' } });

    const found = findSpan(tracer.spans, 'duplicate', (attrs) => attrs['id'] === 'second');
    // Assert that we got the second span, not the first.
    expect(found.spanId).toBe(s2.spanId());
    expect(found.spanId).not.toBe(s1.spanId());
  });
});

// ---------------------------------------------------------------------------
// Bonus: ThrowingTracer basic contract
// ---------------------------------------------------------------------------

describe('ThrowingTracer', () => {
  it('startSpan always throws', () => {
    const t = new ThrowingTracer();
    // ThrowingTracer.startSpan() takes no parameters — it throws unconditionally.
    expect(() => t.startSpan()).toThrow('mock tracer broken');
  });

  it('withSpan bypasses the throw and invokes fn(NOOP_SPAN) directly', async () => {
    const t = new ThrowingTracer();

    let received: unknown;
    const result = await t.withSpan('anything', {}, async (span) => {
      received = span;
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(received).toBe(NOOP_SPAN);
  });

  it('withActiveContext runs fn directly', async () => {
    const t = new ThrowingTracer();

    let ran = false;
    await t.withActiveContext(NOOP_SPAN, async () => {
      ran = true;
    });

    expect(ran).toBe(true);
  });
});
