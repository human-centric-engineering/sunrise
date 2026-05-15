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

/**
 * Custom-event name used to broadcast same-tab localStorage writes.
 * The browser's built-in `storage` event only fires across tabs, so
 * two `useLocalStorage` instances in the SAME tab (e.g. a dialog
 * writing while a layout-mounted banner reads) need a second channel
 * to stay in sync. The payload carries the key and the JSON-stringified
 * value, mirroring the native StorageEvent shape closely enough that
 * a single handler can dispatch on either source.
 */
const SAME_TAB_EVENT = 'sunrise:local-storage-write';

interface SameTabPayload {
  key: string;
  newValue: string | null;
}

function readFromStorage<T>(key: string, initial: T): T {
  /* v8 ignore start */
  if (!isBrowser()) return initial;
  /* v8 ignore stop */

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
    /* v8 ignore start */
    if (!isBrowser()) return;
    /* v8 ignore stop */
    const stored = readFromStorage(key, initial);
    setInternalValue(stored);
    valueRef.current = stored;
    // Intentionally omit `initial` from deps: it's expected to be referentially
    // unstable (inline objects are common) and we only want to read it once on
    // mount / when the key changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Cross-tab sync: when another tab writes to `key`, update our state.
  // Same-tab sync: another `useLocalStorage` instance in the same tab
  // dispatches a custom event (the browser's `storage` event only
  // fires cross-tab). Both go through one handler so logic stays in
  // lockstep.
  useEffect(() => {
    /* v8 ignore start */
    if (!isBrowser()) return;
    /* v8 ignore stop */

    function applyChange(newValue: string | null): void {
      if (newValue === null) {
        setInternalValue(initial);
        valueRef.current = initial;
        return;
      }
      try {
        const parsed = JSON.parse(newValue) as T;
        setInternalValue(parsed);
        valueRef.current = parsed;
      } catch (err) {
        logger.warn('useLocalStorage: failed to parse storage-event value', {
          key,
          err: String(err),
        });
      }
    }

    function onStorage(event: StorageEvent) {
      if (event.key !== key || event.storageArea !== window.localStorage) return;
      applyChange(event.newValue);
    }

    function onSameTab(event: Event) {
      const detail = (event as CustomEvent<SameTabPayload>).detail;
      if (!detail || detail.key !== key) return;
      applyChange(detail.newValue);
    }

    window.addEventListener('storage', onStorage);
    window.addEventListener(SAME_TAB_EVENT, onSameTab);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(SAME_TAB_EVENT, onSameTab);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const setValue = useCallback<SetValue<T>>(
    (next) => {
      const resolved =
        typeof next === 'function' ? (next as (prev: T) => T)(valueRef.current) : next;

      setInternalValue(resolved);
      valueRef.current = resolved;

      /* v8 ignore start */
      if (!isBrowser()) return;
      /* v8 ignore stop */
      const serialized = JSON.stringify(resolved);
      try {
        window.localStorage.setItem(key, serialized);
      } catch (err) {
        logger.warn('useLocalStorage: failed to write value', { key, err: String(err) });
        return;
      }
      // Same-tab broadcast — other instances of this hook in the same
      // tab don't get the native `storage` event, so we nudge them
      // ourselves. Cross-tab still rides on the native event.
      window.dispatchEvent(
        new CustomEvent<SameTabPayload>(SAME_TAB_EVENT, {
          detail: { key, newValue: serialized },
        })
      );
    },
    [key]
  );

  const remove = useCallback(() => {
    setInternalValue(initial);
    valueRef.current = initial;
    /* v8 ignore start */
    if (!isBrowser()) return;
    /* v8 ignore stop */
    try {
      window.localStorage.removeItem(key);
    } catch (err) {
      logger.warn('useLocalStorage: failed to remove value', { key, err: String(err) });
      return;
    }
    window.dispatchEvent(
      new CustomEvent<SameTabPayload>(SAME_TAB_EVENT, {
        detail: { key, newValue: null },
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return [value, setValue, remove];
}
