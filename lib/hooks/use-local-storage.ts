'use client';

/**
 * useLocalStorage — SSR-safe localStorage state hook.
 *
 * Syncs a piece of state with `window.localStorage` under a given key.
 * Handles SSR gracefully (returns the initial value and makes the setter a
 * no-op when `window` is not available), JSON-serialises reads and writes,
 * and subscribes to `storage` events so two tabs stay in sync.
 *
 * Caveats:
 * - Values are round-tripped through `JSON.stringify` / `JSON.parse` — so
 *   `Date`, `Map`, `Set`, and class instances are NOT preserved. Store
 *   plain data only.
 * - If `JSON.parse` throws (e.g. because another process wrote an invalid
 *   value), the hook falls back to `initial` and logs a warning.
 *
 * @example
 * ```tsx
 * const [draft, setDraft, clear] = useLocalStorage('my.draft.v1', {
 *   title: '',
 *   body: '',
 * });
 * ```
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { logger } from '@/lib/logging';

export type SetValue<T> = (value: T | ((prev: T) => T)) => void;

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

function readFromStorage<T>(key: string, initial: T): T {
  if (!isBrowser()) return initial;

  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return initial;
    return JSON.parse(raw) as T;
  } catch (err) {
    logger.warn('useLocalStorage: failed to parse stored value, using initial', {
      key,
      err: String(err),
    });
    return initial;
  }
}

export function useLocalStorage<T>(key: string, initial: T): [T, SetValue<T>, () => void] {
  // Always start with `initial`, even in the browser. The client's first render
  // happens during hydration and MUST match the server's HTML — but server
  // can't read localStorage, so it always sent HTML built from `initial`. If
  // we read storage in the lazy init, the first client render diverges from
  // the server and React tears the tree down with a hydration mismatch (seen
  // on the knowledge admin's setup panel where aria-expanded flipped between
  // server and client). The post-mount effect below picks up the stored value
  // after hydration completes.
  const [value, setInternalValue] = useState<T>(initial);

  // Keep a ref to the latest value so the setter's updater form can read it
  // without stale closures when `value` dependencies change.
  const valueRef = useRef(value);
  valueRef.current = value;

  // Hydrate from storage after mount — covers the SSR render path where the
  // initial state was `initial` instead of the stored value.
  useEffect(() => {
    if (!isBrowser()) return;
    const stored = readFromStorage(key, initial);
    setInternalValue(stored);
    valueRef.current = stored;
    // Intentionally omit `initial` from deps: it's expected to be referentially
    // unstable (inline objects are common) and we only want to read it once on
    // mount / when the key changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Cross-tab sync: when another tab writes to `key`, update our state.
  useEffect(() => {
    if (!isBrowser()) return;

    function onStorage(event: StorageEvent) {
      if (event.key !== key || event.storageArea !== window.localStorage) return;
      if (event.newValue === null) {
        setInternalValue(initial);
        valueRef.current = initial;
        return;
      }
      try {
        const parsed = JSON.parse(event.newValue) as T;
        setInternalValue(parsed);
        valueRef.current = parsed;
      } catch (err) {
        logger.warn('useLocalStorage: failed to parse storage-event value', {
          key,
          err: String(err),
        });
      }
    }

    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const setValue = useCallback<SetValue<T>>(
    (next) => {
      const resolved =
        typeof next === 'function' ? (next as (prev: T) => T)(valueRef.current) : next;

      setInternalValue(resolved);
      valueRef.current = resolved;

      if (!isBrowser()) return;
      try {
        window.localStorage.setItem(key, JSON.stringify(resolved));
      } catch (err) {
        logger.warn('useLocalStorage: failed to write value', { key, err: String(err) });
      }
    },
    [key]
  );

  const remove = useCallback(() => {
    setInternalValue(initial);
    valueRef.current = initial;
    if (!isBrowser()) return;
    try {
      window.localStorage.removeItem(key);
    } catch (err) {
      logger.warn('useLocalStorage: failed to remove value', { key, err: String(err) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return [value, setValue, remove];
}
