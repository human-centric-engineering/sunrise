'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { HealthCheckResponse } from '@/lib/monitoring';
import { healthCheckResponseSchema } from '@/lib/validations/monitoring';
import { useAutoRefresh } from '@/lib/hooks/use-auto-refresh';

/**
 * Health check state
 */
export interface HealthCheckState {
  /** Current health data */
  data: HealthCheckResponse | null;
  /** Loading state for initial fetch */
  isLoading: boolean;
  /** Error state */
  error: Error | null;
  /** Whether the hook is currently polling */
  isPolling: boolean;
  /** Timestamp of last successful fetch */
  lastUpdated: Date | null;
}

/**
 * Options for the useHealthCheck hook
 */
export interface UseHealthCheckOptions {
  /** Polling interval in milliseconds (default: 30000 = 30 seconds) */
  pollingInterval?: number;
  /** Health check endpoint URL (default: /api/health) */
  endpoint?: string;
  /** Whether to start polling immediately (default: true) */
  autoStart?: boolean;
  /** Callback when status changes */
  onStatusChange?: (status: 'ok' | 'error') => void;
}

/**
 * Return type for useHealthCheck hook
 */
export interface UseHealthCheckReturn extends HealthCheckState {
  /** Manually trigger a health check */
  refresh: () => Promise<void>;
  /** Start polling */
  startPolling: () => void;
  /** Stop polling */
  stopPolling: () => void;
}

/**
 * useHealthCheck Hook
 *
 * React hook for polling the health check endpoint and managing health state.
 * Automatically handles polling, error states, and status change notifications.
 *
 * Polling runs through `useAutoRefresh`, so it **pauses while the tab is
 * hidden**. `/api/health` runs `SELECT 1` against the database, and a forgotten
 * admin tab used to issue one every 30 seconds forever — enough on its own to
 * keep a scale-to-zero Postgres awake, independent of the maintenance tick
 * (#442).
 *
 * `isPolling` therefore means "polling is enabled", not "a timer is armed right
 * now": it stays `true` across a visibility pause, which is what the status
 * page's Resume affordance should key off.
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { data, isLoading, error, refresh } = useHealthCheck({
 *     pollingInterval: 60000,
 *     onStatusChange: (status) => console.log('Status changed:', status),
 *   });
 *
 *   if (isLoading) return <p>Loading...</p>;
 *   if (error) return <p>Error: {error.message}</p>;
 *   if (!data) return null;
 *
 *   return <p>Status: {data.status}</p>;
 * }
 * ```
 */
export function useHealthCheck(options: UseHealthCheckOptions = {}): UseHealthCheckReturn {
  const {
    pollingInterval = 30000,
    endpoint = '/api/health',
    autoStart = true,
    onStatusChange,
  } = options;

  const [state, setState] = useState<HealthCheckState>({
    data: null,
    isLoading: true,
    error: null,
    isPolling: autoStart,
    lastUpdated: null,
  });

  // Track previous status for change detection
  const previousStatus = useRef<'ok' | 'error' | null>(null);

  // Track if mounted to avoid state updates after unmount
  const mountedRef = useRef(true);

  // Store onStatusChange in ref to avoid effect dependency issues
  const onStatusChangeRef = useRef(onStatusChange);

  // Update ref in effect to comply with React Compiler rules
  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  /**
   * Fetch health data from the endpoint
   * Uses refs to avoid recreating on every render
   */
  const fetchHealth = useCallback(async () => {
    try {
      const response = await fetch(endpoint);
      // Validate the response body against the documented shape rather than
      // a bare `as HealthCheckResponse` cast. A server returning a payload
      // that doesn't match the contract (e.g. an older deployment missing
      // `version`, or a stripping proxy) becomes a clear fetch error here
      // instead of a silent `undefined` rendered in the UI.
      //
      // The schema deliberately does NOT reject a payload carrying extra keys
      // — Zod strips them. That is what lets this hook keep working against a
      // fork that kept `sunrise` on its own health route, and across a rolling
      // upgrade serving both shapes at once (#531).
      const parsed = healthCheckResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new Error(`Invalid /api/health response shape: ${parsed.error.message}`);
      }
      const data: HealthCheckResponse = parsed.data;

      if (!mountedRef.current) return;

      // Detect status change
      if (
        onStatusChangeRef.current &&
        previousStatus.current !== null &&
        previousStatus.current !== data.status
      ) {
        onStatusChangeRef.current(data.status);
      }
      previousStatus.current = data.status;

      setState((prev) => ({
        ...prev,
        data,
        isLoading: false,
        error: null,
        lastUpdated: new Date(),
      }));
    } catch (err) {
      if (!mountedRef.current) return;

      const error = err instanceof Error ? err : new Error('Failed to fetch health status');

      // Detect status change to error
      if (onStatusChangeRef.current && previousStatus.current !== 'error') {
        onStatusChangeRef.current('error');
      }
      previousStatus.current = 'error';

      setState((prev) => ({
        ...prev,
        isLoading: false,
        error,
      }));
    }
  }, [endpoint]);

  /**
   * Manual refresh function
   */
  const refresh = useCallback(async () => {
    setState((prev) => ({ ...prev, isLoading: true }));
    await fetchHealth();
  }, [fetchHealth]);

  /** Resume polling. Also refreshes immediately, so "Resume" feels instant. */
  const startPolling = useCallback(() => {
    setState((prev) => ({ ...prev, isPolling: true }));
  }, []);

  /** Pause polling. */
  const stopPolling = useCallback(() => {
    setState((prev) => ({ ...prev, isPolling: false }));
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Polling, the visibility pause, and the mount fetch all come from the shared
  // hook — see the module docstring for why this is not a bare setInterval.
  useAutoRefresh(fetchHealth, pollingInterval, { enabled: state.isPolling });

  // `useAutoRefresh` does nothing while disabled, so `autoStart: false` would
  // otherwise leave a consumer rendering "loading" forever.
  useEffect(() => {
    if (autoStart) return;
    void fetchHealth();
  }, [autoStart, fetchHealth]);

  return {
    ...state,
    refresh,
    startPolling,
    stopPolling,
  };
}
