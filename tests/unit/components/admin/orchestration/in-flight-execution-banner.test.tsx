/**
 * Unit Test: InFlightExecutionBanner
 *
 * @see components/admin/orchestration/in-flight-execution-banner.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { InFlightExecutionBanner } from '@/components/admin/orchestration/in-flight-execution-banner';
import { IN_FLIGHT_EXECUTION_STORAGE_KEY } from '@/lib/orchestration/in-flight-execution';
import type { ExecutionStatusSnapshot } from '@/lib/hooks/use-execution-status-poller';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockGet = vi.fn();
vi.mock('@/lib/api/client', () => {
  class APIClientError extends Error {
    constructor(
      message: string,
      public code?: string,
      public status?: number
    ) {
      super(message);
      this.name = 'APIClientError';
    }
  }
  return {
    apiClient: { get: (...args: unknown[]) => mockGet(...args) },
    APIClientError,
  };
});

// Pass the seed straight through so the banner's render is deterministic.
vi.mock('@/lib/hooks/use-execution-status-poller', () => ({
  useExecutionStatusPoller: <T extends { status: string }>(_id: string, initial: T) => initial,
  isTerminalStatus: (s: string) => s === 'completed' || s === 'failed' || s === 'cancelled',
  EXECUTION_STATUS_POLL_INTERVAL_MS: 3000,
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

// ─── Fixtures ────────────────────────────────────────────────────────────────

const EXEC_ID = 'cmjbv4i3x00003wsloputgwu1';

function setEntry(label = 'Provider Model Audit'): void {
  window.localStorage.setItem(
    IN_FLIGHT_EXECUTION_STORAGE_KEY,
    JSON.stringify({
      executionId: EXEC_ID,
      label,
      startedAt: '2026-05-15T10:00:00.000Z',
    })
  );
}

function snapshot(overrides: Partial<ExecutionStatusSnapshot> = {}): ExecutionStatusSnapshot {
  return {
    id: EXEC_ID,
    status: 'running',
    currentStep: 'analyse_chat',
    errorMessage: null,
    totalTokensUsed: 0,
    totalCostUsd: 0,
    startedAt: '2026-05-15T10:00:00.000Z',
    completedAt: null,
    createdAt: '2026-05-15T10:00:00.000Z',
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('InFlightExecutionBanner', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing when no in-flight execution is in localStorage', () => {
    const { container } = render(<InFlightExecutionBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('fetches the seed snapshot then renders the running pill', async () => {
    setEntry();
    mockGet.mockResolvedValueOnce(snapshot());

    render(<InFlightExecutionBanner />);

    const banner = await screen.findByTestId('in-flight-execution-banner');
    expect(banner).toHaveAttribute('data-execution-id', EXEC_ID);
    expect(banner).toHaveAttribute('data-status', 'running');
    expect(banner).toHaveTextContent('Provider Model Audit');
    expect(banner).toHaveTextContent('Running');
    expect(banner).toHaveTextContent('analyse_chat');
  });

  it('linkifies through to the execution detail page', async () => {
    setEntry();
    mockGet.mockResolvedValueOnce(snapshot());

    render(<InFlightExecutionBanner />);
    const link = await screen.findByTestId('in-flight-execution-banner-link');
    expect(link).toHaveAttribute('href', `/admin/orchestration/executions/${EXEC_ID}`);
  });

  it('manual dismiss clears localStorage and unmounts the banner', async () => {
    setEntry();
    mockGet.mockResolvedValueOnce(snapshot());
    const user = userEvent.setup();

    render(<InFlightExecutionBanner />);
    await screen.findByTestId('in-flight-execution-banner');
    await user.click(screen.getByTestId('in-flight-execution-banner-dismiss'));

    expect(window.localStorage.getItem(IN_FLIGHT_EXECUTION_STORAGE_KEY)).toBeNull();
    expect(screen.queryByTestId('in-flight-execution-banner')).toBeNull();
  });

  it('auto-dismisses 5 s after the run reaches terminal status', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setEntry();
    mockGet.mockResolvedValueOnce(
      snapshot({ status: 'completed', completedAt: '2026-05-15T10:01:00.000Z' })
    );

    render(<InFlightExecutionBanner />);
    await screen.findByTestId('in-flight-execution-banner');
    // Terminal status shows briefly first.
    expect(screen.getByTestId('in-flight-execution-banner')).toHaveAttribute(
      'data-status',
      'completed'
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_001);
    });

    expect(window.localStorage.getItem(IN_FLIGHT_EXECUTION_STORAGE_KEY)).toBeNull();
    expect(screen.queryByTestId('in-flight-execution-banner')).toBeNull();
  });

  it('clears localStorage silently when the seed fetch returns an APIClientError (stale entry)', async () => {
    setEntry();
    const { APIClientError } = await import('@/lib/api/client');
    mockGet.mockRejectedValueOnce(new APIClientError('not found', 'NOT_FOUND', 404));

    render(<InFlightExecutionBanner />);

    await waitFor(() => {
      expect(window.localStorage.getItem(IN_FLIGHT_EXECUTION_STORAGE_KEY)).toBeNull();
    });
    expect(screen.queryByTestId('in-flight-execution-banner')).toBeNull();
  });

  it('picks up a same-tab localStorage write made after the banner has mounted', async () => {
    // The browser `storage` event only fires cross-tab. The dialog
    // writes to localStorage on the same tab, so the banner's
    // useLocalStorage instance has to learn about the write via the
    // hook's CustomEvent broadcast. This test simulates exactly that
    // sequence — banner mounts with no entry, then a write lands.
    mockGet.mockResolvedValueOnce(snapshot());
    render(<InFlightExecutionBanner />);
    expect(screen.queryByTestId('in-flight-execution-banner')).toBeNull();

    await act(async () => {
      // Mirror what the dialog's setValue does: write to localStorage
      // then dispatch the same-tab broadcast event the hook listens for.
      const payload = JSON.stringify({
        executionId: EXEC_ID,
        label: 'Provider Model Audit',
        startedAt: '2026-05-15T10:00:00.000Z',
      });
      window.localStorage.setItem(IN_FLIGHT_EXECUTION_STORAGE_KEY, payload);
      window.dispatchEvent(
        new CustomEvent('sunrise:local-storage-write', {
          detail: { key: IN_FLIGHT_EXECUTION_STORAGE_KEY, newValue: payload },
        })
      );
    });

    expect(await screen.findByTestId('in-flight-execution-banner')).toBeInTheDocument();
  });

  it('shows the failure message inline when the run terminates as failed', async () => {
    setEntry();
    mockGet.mockResolvedValueOnce(snapshot({ status: 'failed', errorMessage: 'Budget exceeded' }));

    render(<InFlightExecutionBanner />);
    const banner = await screen.findByTestId('in-flight-execution-banner');
    expect(banner).toHaveAttribute('data-status', 'failed');
    expect(banner).toHaveTextContent('Budget exceeded');
  });
});
