/**
 * Tests for the shared router mock factory.
 *
 * WHY THIS FILE EXISTS: `createMockRouter()` is the one place that knows the
 * full shape of `AppRouterInstance`, and the suite-wide `next/navigation` mock
 * in `tests/setup.ts` is the router that most component tests actually render
 * against. Nothing type-checks a `vi.mock` factory — that is exactly why an
 * incomplete literal there survived the 16.3.0 break in silence while the
 * typed call sites failed loudly. These assertions are the only guard on that
 * default staying complete.
 *
 * @see tests/types/mocks.ts
 * @see tests/setup.ts
 */

import { describe, it, expect, vi, type Mock } from 'vitest';
import { useRouter } from 'next/navigation';
import { createMockRouter } from '@/tests/types/mocks';

const ROUTER_METHODS = ['push', 'replace', 'refresh', 'back', 'forward', 'prefetch'] as const;

describe('createMockRouter', () => {
  it('provides every router method as a callable spy', () => {
    const router = createMockRouter();

    for (const method of ROUTER_METHODS) {
      expect(typeof router[method]).toBe('function');
      expect(vi.isMockFunction(router[method])).toBe(true);
    }
  });

  it('provides bfcacheId, which Next 16.3.0 made required', () => {
    // Not merely "is defined" — a component may pass it to a React `key`,
    // where `undefined` silently degrades to a stable key rather than erroring.
    expect(typeof createMockRouter().bfcacheId).toBe('string');
    expect(createMockRouter().bfcacheId).not.toBe('');
  });

  it('uses the caller-supplied spy for overridden members', () => {
    const push = vi.fn();
    const router = createMockRouter({ push });

    router.push('/dashboard');

    expect(push).toHaveBeenCalledWith('/dashboard');
    expect(router.push).toBe(push);
  });

  it('leaves non-overridden members as independent spies', () => {
    const push = vi.fn();
    const router = createMockRouter({ push });

    router.replace('/elsewhere');

    expect(router.replace).toHaveBeenCalledWith('/elsewhere');
    expect(push).not.toHaveBeenCalled(); // test-review:accept no_arg_called — isolation guard: the override must not absorb other calls
  });

  it('ignores an undefined override rather than punching a hole in the default', () => {
    // `Partial<MockRouter>` accepts `Mock | undefined` (exactOptionalPropertyTypes
    // is off), so a plain spread would leave `push` undefined — type-checking as
    // a complete router and throwing at render.
    const maybeSpy: Mock | undefined = undefined;
    const router = createMockRouter({ push: maybeSpy });

    expect(typeof router.push).toBe('function');
    expect(() => router.push('/somewhere')).not.toThrow();
  });

  it('returns a fresh set of spies per call, so tests cannot leak into each other', () => {
    const first = createMockRouter();
    const second = createMockRouter();

    first.push('/a');

    expect(second.push).not.toHaveBeenCalled(); // test-review:accept no_arg_called — isolation guard
    expect(first.push).not.toBe(second.push);
  });
});

describe('suite-wide next/navigation mock (tests/setup.ts)', () => {
  it('exposes exactly the member set the factory does', () => {
    // The real assertion: `tests/setup.ts` must keep building its default
    // router from `createMockRouter()`. Re-inlining an object literal there
    // would pass type-check — a mock factory is untyped — and quietly hand
    // every component in the suite a router missing whatever member Next
    // added most recently. This is what catches that.
    expect(Object.keys(useRouter()).sort()).toEqual(Object.keys(createMockRouter()).sort());
  });

  it('includes bfcacheId on the default router', () => {
    expect(typeof useRouter().bfcacheId).toBe('string');
  });
});
