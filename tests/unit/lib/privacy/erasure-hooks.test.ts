/**
 * Unit tests for lib/privacy/erasure-hooks.ts
 *
 * Contract under test:
 *   registerErasureCleanupHook(hook) — stores by hook.name in a module-level Map
 *   getErasureCleanupHooks()         — returns [...map.values()] (first-registration order)
 *   __resetErasureCleanupHooksForTests() — clears the map
 *
 * Key invariant: re-registering the same name REPLACES the prior hook (name-dedup).
 *
 * @see lib/privacy/erasure-hooks.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  registerErasureCleanupHook,
  getErasureCleanupHooks,
  __resetErasureCleanupHooksForTests,
} from '@/lib/privacy/erasure-hooks';

// ---------------------------------------------------------------------------
// Reset the module-level Map before and after every test so state never leaks
// ---------------------------------------------------------------------------

beforeEach(() => {
  __resetErasureCleanupHooksForTests();
});

afterEach(() => {
  __resetErasureCleanupHooksForTests();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('erasure-hooks registry', () => {
  // -------------------------------------------------------------------------
  // Case 1: register → get round-trip
  // -------------------------------------------------------------------------

  describe('registerErasureCleanupHook / getErasureCleanupHooks', () => {
    it('round-trip — a registered hook is returned by getErasureCleanupHooks', () => {
      // Arrange
      const hook = {
        name: 'my-hook',
        cleanupExternal: vi.fn(),
        scrubInTransaction: vi.fn(),
      };

      // Act
      registerErasureCleanupHook(hook);
      const hooks = getErasureCleanupHooks();

      // Assert — the registry returned the hook we registered, not a copy or empty list
      expect(hooks).toHaveLength(1);
      expect(hooks[0]).toBe(hook);
    });

    it('ordering — hooks are returned in first-registration order across distinct names', () => {
      // Arrange
      const hookA = { name: 'alpha', cleanupExternal: vi.fn() };
      const hookB = { name: 'beta', cleanupExternal: vi.fn() };
      const hookC = { name: 'gamma', cleanupExternal: vi.fn() };

      // Act — register in A → B → C order
      registerErasureCleanupHook(hookA);
      registerErasureCleanupHook(hookB);
      registerErasureCleanupHook(hookC);
      const hooks = getErasureCleanupHooks();

      // Assert — order preserved; the registry did not sort or reverse
      expect(hooks).toHaveLength(3);
      expect(hooks[0].name).toBe('alpha');
      expect(hooks[1].name).toBe('beta');
      expect(hooks[2].name).toBe('gamma');
    });
  });

  // -------------------------------------------------------------------------
  // Case 2: name-dedup — re-registering the same name REPLACES the first hook
  // -------------------------------------------------------------------------

  describe('name-dedup', () => {
    it('replacing a hook — map size stays 1 after re-registration under the same name', () => {
      // Arrange
      const firstHook = { name: 'dupe', cleanupExternal: vi.fn() };
      const secondHook = { name: 'dupe', cleanupExternal: vi.fn() };

      // Act
      registerErasureCleanupHook(firstHook);
      registerErasureCleanupHook(secondHook);
      const hooks = getErasureCleanupHooks();

      // Assert — replacement happened, not accumulation
      expect(hooks).toHaveLength(1);
    });

    it('replacing a hook — the SECOND hook is what getErasureCleanupHooks returns (not the first)', () => {
      // Arrange
      const firstCleanup = vi.fn().mockResolvedValue(undefined);
      const secondCleanup = vi.fn().mockResolvedValue(undefined);
      const firstHook = { name: 'dupe', cleanupExternal: firstCleanup };
      const secondHook = { name: 'dupe', cleanupExternal: secondCleanup };

      // Act
      registerErasureCleanupHook(firstHook);
      registerErasureCleanupHook(secondHook);
      const [returnedHook] = getErasureCleanupHooks();

      // Assert — the RETURNED hook's cleanupExternal is the second one, proving replacement
      // This is the key invariant: do not assert just that length is 1 — assert WHICH hook survived
      expect(returnedHook.cleanupExternal).toBe(secondCleanup);
      expect(returnedHook.cleanupExternal).not.toBe(firstCleanup);
    });

    it('replacing a hook — the second hook is callable and behaves as the replacement', async () => {
      // Arrange
      const firstScrub = vi.fn().mockResolvedValue(undefined);
      const secondScrub = vi.fn().mockResolvedValue(undefined);
      const firstHook = { name: 'dupe', scrubInTransaction: firstScrub };
      const secondHook = { name: 'dupe', scrubInTransaction: secondScrub };

      // Act — register both, then invoke the survivor
      registerErasureCleanupHook(firstHook);
      registerErasureCleanupHook(secondHook);
      const [survivor] = getErasureCleanupHooks();
      await survivor.scrubInTransaction?.({ tx: {} as never, userId: 'u-1' });

      // Assert — only the second scrub ran, proving the first was fully replaced
      expect(secondScrub).toHaveBeenCalledTimes(1);
      expect(firstScrub).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Case 3: __resetErasureCleanupHooksForTests empties the registry
  // -------------------------------------------------------------------------

  describe('__resetErasureCleanupHooksForTests', () => {
    it('empties the registry — getErasureCleanupHooks returns [] after reset', () => {
      // Arrange — register hooks so there is something to clear
      registerErasureCleanupHook({ name: 'hook-a' });
      registerErasureCleanupHook({ name: 'hook-b' });
      expect(getErasureCleanupHooks()).toHaveLength(2); // sanity check before reset

      // Act
      __resetErasureCleanupHooksForTests();

      // Assert — the registry is empty after reset, proving the function does clear
      expect(getErasureCleanupHooks()).toHaveLength(0);
    });

    it('empties the registry — a subsequent registration after reset is the only hook', () => {
      // Arrange — populate, then reset, then register a new hook
      registerErasureCleanupHook({ name: 'old-hook' });
      __resetErasureCleanupHooksForTests();
      const newHook = { name: 'new-hook', cleanupExternal: vi.fn() };

      // Act
      registerErasureCleanupHook(newHook);
      const hooks = getErasureCleanupHooks();

      // Assert — only the post-reset hook is present (old-hook was cleared)
      expect(hooks).toHaveLength(1);
      expect(hooks[0].name).toBe('new-hook');
    });
  });
});
