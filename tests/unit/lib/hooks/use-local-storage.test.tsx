/**
 * useLocalStorage Hook Tests
 *
 * Covers SSR safety, JSON round-trip, updater-form, parse-failure fallback,
 * cross-tab storage events, and the remove() path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useLocalStorage } from '@/lib/hooks/use-local-storage';

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

  it('remove() swallows localStorage.removeItem errors', () => {
    const removeSpy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });

    const { result } = renderHook(() => useLocalStorage<string>('k.remove-throws', 'a'));

    expect(() => {
      act(() => {
        result.current[2]();
      });
    }).not.toThrow();
    expect(result.current[0]).toBe('a');
    expect(removeSpy).toHaveBeenCalled();
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
});
