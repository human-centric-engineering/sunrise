'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { HealthCheckResponse } from '@/lib/monitoring';

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

  // Polling interval ref
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

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
      const data = (await response.json()) as HealthCheckResponse;

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

  /**
   * Start polling
   */
  const startPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }

    intervalRef.current = setInterval(() => {
      void fetchHealth();
    }, pollingInterval);
    setState((prev) => ({ ...prev, isPolling: true }));
  }, [fetchHealth, pollingInterval]);

  /**
   * Stop polling
   */
  const stopPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setState((prev) => ({ ...prev, isPolling: false }));
  }, []);

  // Initial fetch and setup polling
  useEffect(() => {
    mountedRef.current = true;

    // Create an async function to handle initial fetch
    // This is called in a callback context (from an immediately-invoked async function)
    // which is the recommended pattern for effects that need async operations
    const initFetch = async () => {
      await fetchHealth();
    };

    void initFetch();

    if (autoStart) {
      // Start polling after initial fetch
      intervalRef.current = setInterval(() => {
        void fetchHealth();
      }, pollingInterval);
    }

    return () => {
      mountedRef.current = false;
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [fetchHealth, autoStart, pollingInterval]);

  return {
    ...state,
    refresh,
    startPolling,
    stopPolling,
  };
}
