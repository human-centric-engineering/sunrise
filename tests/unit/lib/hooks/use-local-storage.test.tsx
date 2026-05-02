/**
 * useLocalStorage Hook Tests
 *
 * Covers SSR safety, JSON round-trip, updater-form, parse-failure fallback,
 * cross-tab storage events, and the remove() path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useLocalStorage } from '@/lib/hooks/use-local-storage';
import { logger } from '@/lib/logging';

vi.mock('@/lib/logging', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

describe('useLocalStorage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('returns initial value when key is absent', () => {
    const { result } = renderHook(() => useLocalStorage('k.absent', { foo: 'bar' }));
    expect(result.current[0]).toEqual({ foo: 'bar' });
  });

  it('hydrates from storage when a value is already present', () => {
    window.localStorage.setItem('k.present', JSON.stringify({ hydrated: true }));
    const { result } = renderHook(() => useLocalStorage('k.present', { hydrated: false }));
    expect(result.current[0]).toEqual({ hydrated: true });
  });

  it('round-trips writes via the setter', () => {
    const { result } = renderHook(() => useLocalStorage<number>('k.counter', 0));

    act(() => {
      result.current[1](5);
    });

    expect(result.current[0]).toBe(5);
    expect(JSON.parse(window.localStorage.getItem('k.counter') ?? 'null')).toBe(5);
  });

  it('supports updater function form', () => {
    const { result } = renderHook(() => useLocalStorage<number>('k.updater', 1));

    act(() => {
      result.current[1]((prev) => prev + 10);
    });

    expect(result.current[0]).toBe(11);
  });

  it('falls back to initial when stored value is invalid JSON', () => {
    window.localStorage.setItem('k.invalid', '{not-json');
    const { result } = renderHook(() => useLocalStorage('k.invalid', 'fallback'));
    expect(result.current[0]).toBe('fallback');
  });

  it('syncs from cross-tab storage events', () => {
    const { result } = renderHook(() => useLocalStorage<string>('k.sync', 'a'));

    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'k.sync',
          newValue: JSON.stringify('b'),
          storageArea: window.localStorage,
        })
      );
    });

    expect(result.current[0]).toBe('b');
  });

  it('storage event with null newValue resets to initial', () => {
    const { result } = renderHook(() => useLocalStorage<string>('k.reset', 'initial'));

    act(() => {
      result.current[1]('changed');
    });
    expect(result.current[0]).toBe('changed');

    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'k.reset',
          newValue: null,
          storageArea: window.localStorage,
        })
      );
    });

    expect(result.current[0]).toBe('initial');
  });

  it('ignores storage events for other keys', () => {
    const { result } = renderHook(() => useLocalStorage<string>('k.mine', 'a'));

    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'k.other',
          newValue: JSON.stringify('b'),
          storageArea: window.localStorage,
        })
      );
    });

    expect(result.current[0]).toBe('a');
  });

  it('setValue swallows localStorage.setItem errors and keeps in-memory state', () => {
    const original = window.localStorage.setItem.bind(window.localStorage);
    const setSpy = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    const { result } = renderHook(() => useLocalStorage<string>('k.quota', 'a'));

    act(() => {
      result.current[1]('b');
    });

    // In-memory state still updates even if persistence failed
    expect(result.current[0]).toBe('b');
    expect(setSpy).toHaveBeenCalled();
    setSpy.mockRestore();
    // Sanity: storage still usable after restore
    original('k.quota.sanity', '1');
  });

  it('remove() swallows localStorage.removeItem errors and warns via logger', () => {
    const warnSpy = vi.mocked(logger.warn);
    const removeSpy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });

    const { result } = renderHook(() => useLocalStorage<string>('k.remove-throws', 'a'));

    act(() => {
      result.current[2]();
    });

    // Assert: hook did not throw and logger.warn was invoked with the correct context
    expect(result.current[0]).toBe('a');
    expect(removeSpy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to remove value'),
      expect.objectContaining({ key: 'k.remove-throws' })
    );
    removeSpy.mockRestore();
  });

  it('swallows storage events with unparseable newValue', () => {
    const { result } = renderHook(() => useLocalStorage<string>('k.badevent', 'a'));

    act(() => {
      result.current[1]('b');
    });
    expect(result.current[0]).toBe('b');

    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'k.badevent',
          newValue: '{not-json',
          storageArea: window.localStorage,
        })
      );
    });

    // Unchanged — the bad event was ignored, not applied
    expect(result.current[0]).toBe('b');
  });

  it('remove() clears storage and resets state', () => {
    const { result } = renderHook(() => useLocalStorage<string>('k.remove', 'initial'));

    act(() => {
      result.current[1]('written');
    });
    expect(window.localStorage.getItem('k.remove')).not.toBeNull();

    act(() => {
      result.current[2]();
    });

    expect(result.current[0]).toBe('initial');
    expect(window.localStorage.getItem('k.remove')).toBeNull();
  });

  // ─── SSR fallback ─────────────────────────────────────────────────
  // The isBrowser() guard in useLocalStorage returns false when `typeof window`
  // is `'undefined'`. In a Vitest/happy-dom environment `window` is always present,
  // so we test the SSR path by stubbing window.localStorage to simulate an
  // unavailable storage API (equivalent observable contract: no storage write).

  it('returns initial value when localStorage is unavailable (SSR-equivalent)', () => {
    // Arrange — remove localStorage from window to simulate a restricted/SSR context
    const originalLocalStorage = window.localStorage;
    Object.defineProperty(window, 'localStorage', {
      value: undefined,
      writable: true,
      configurable: true,
    });

    let value: string | undefined;
    try {
      // Act — render the hook; readFromStorage should fall back to 'ssr-initial'
      // because accessing window.localStorage throws or is undefined
      const { result } = renderHook(() => useLocalStorage<string>('k.ssr', 'ssr-initial'));
      value = result.current[0];
    } finally {
      // Restore before afterEach cleanup runs
      Object.defineProperty(window, 'localStorage', {
        value: originalLocalStorage,
        writable: true,
        configurable: true,
      });
    }

    // Assert — hook returned the initial value, not a stored value
    expect(value).toBe('ssr-initial');
  });

  // ─── Logger assertions for error paths ────────────────────────────

  it('logs a warning when stored value is malformed JSON', () => {
    // Arrange — poison the storage before the hook mounts so readFromStorage
    // hits the JSON.parse error path during the useState lazy initializer.
    window.localStorage.setItem('k.malformed-log', '{not-json');

    // Act
    renderHook(() => useLocalStorage('k.malformed-log', 'fallback-val'));

    // Assert — hook recovered gracefully AND the logger warned about the failure
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('failed to parse stored value'),
      expect.objectContaining({ key: 'k.malformed-log' })
    );
  });

  it('logs a warning when localStorage.setItem throws (e.g. quota exceeded)', () => {
    // Arrange
    const setSpy = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const { result } = renderHook(() => useLocalStorage<string>('k.quota-log', 'initial'));

    // Act — trigger the setValue path that calls setItem
    act(() => {
      result.current[1]('new-value');
    });

    // Assert — logger.warn was called describing the write failure
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('failed to write value'),
      expect.objectContaining({ key: 'k.quota-log' })
    );

    setSpy.mockRestore();
  });
});
