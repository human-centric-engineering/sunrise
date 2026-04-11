/**
 * BudgetAlertsList Component Tests
 *
 * Test Coverage:
 * - Empty alerts → empty state copy
 * - Clicking "Pause agent" calls apiClient.patch with { isActive: false } and
 *   the row flips to "paused" state (optimistic)
 * - When apiClient.patch rejects with APIClientError, the row reverts and shows an error
 *
 * @see components/admin/orchestration/costs/budget-alerts-list.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { BudgetAlertsList } from '@/components/admin/orchestration/costs/budget-alerts-list';
import type { BudgetAlert } from '@/lib/orchestration/llm/cost-reports';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  APIClientError: class APIClientError extends Error {
    constructor(
      message: string,
      public code = 'INTERNAL_ERROR',
      public status = 500
    ) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  }),
}));

import { apiClient, APIClientError } from '@/lib/api/client';

const mockedPatch = apiClient.patch as unknown as ReturnType<typeof vi.fn>;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeAlert(overrides: Partial<BudgetAlert> = {}): BudgetAlert {
  return {
    agentId: 'agent-1',
    name: 'Test Agent',
    slug: 'test-agent',
    monthlyBudgetUsd: 100,
    spent: 85,
    utilisation: 0.85,
    severity: 'warning',
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('BudgetAlertsList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('empty state', () => {
    it('renders empty state copy when alerts is null', () => {
      render(<BudgetAlertsList alerts={null} />);
      expect(
        screen.getByText('No agents are currently over 80% of their monthly budget.')
      ).toBeInTheDocument();
    });

    it('renders empty state copy when alerts is empty array', () => {
      render(<BudgetAlertsList alerts={[]} />);
      expect(
        screen.getByText('No agents are currently over 80% of their monthly budget.')
      ).toBeInTheDocument();
    });

    it('renders the card wrapper with test id', () => {
      render(<BudgetAlertsList alerts={null} />);
      expect(screen.getByTestId('budget-alerts-list')).toBeInTheDocument();
    });
  });

  describe('pause agent — happy path (optimistic)', () => {
    it('calls PATCH /agents/:id with isActive: false and shows Paused badge', async () => {
      // Arrange
      const user = userEvent.setup();
      const alert = makeAlert({ agentId: 'agent-abc' });
      mockedPatch.mockResolvedValueOnce({ success: true, data: {} });

      // Act
      render(<BudgetAlertsList alerts={[alert]} />);

      const pauseBtn = screen.getByRole('button', { name: /pause agent/i });
      await user.click(pauseBtn);

      // Assert: API call made with correct args
      await waitFor(() => {
        expect(mockedPatch).toHaveBeenCalledWith(
          expect.stringContaining('agent-abc'),
          expect.objectContaining({ body: { isActive: false } })
        );
      });

      // Assert: Paused badge/text appears (optimistic update)
      // Note: "Paused" may appear in both the badge and the button text,
      // so use getAllByText instead of getByText.
      await waitFor(() => {
        const pausedElements = screen.getAllByText('Paused');
        expect(pausedElements.length).toBeGreaterThanOrEqual(1);
      });
    });

    it('disables the Pause agent button after pausing', async () => {
      // Arrange
      const user = userEvent.setup();
      const alert = makeAlert();
      mockedPatch.mockResolvedValueOnce({ success: true, data: {} });

      render(<BudgetAlertsList alerts={[alert]} />);

      const pauseBtn = screen.getByRole('button', { name: /pause agent/i });
      await user.click(pauseBtn);

      // Assert: button is disabled once paused
      await waitFor(() => {
        // After pausing, the button shows "Paused" text and is disabled
        expect(pauseBtn).toBeDisabled();
      });
    });
  });

  describe('pause agent — API error (revert and show error)', () => {
    it('reverts to non-paused state and shows error when PATCH rejects with APIClientError', async () => {
      // Arrange
      const user = userEvent.setup();
      const alert = makeAlert({ agentId: 'agent-err' });
      mockedPatch.mockRejectedValueOnce(
        new APIClientError('Budget limit exceeded', 'BUDGET_EXCEEDED', 402)
      );

      render(<BudgetAlertsList alerts={[alert]} />);

      // Act
      const pauseBtn = screen.getByRole('button', { name: /pause agent/i });
      await user.click(pauseBtn);

      // Assert: error message shows APIClientError message
      await waitFor(() => {
        expect(screen.getByText('Budget limit exceeded')).toBeInTheDocument();
      });

      // Assert: Paused badge is gone (reverted)
      expect(screen.queryByText('Paused')).not.toBeInTheDocument();
    });

    it('reverts and shows generic error message for non-APIClientError rejections', async () => {
      // Arrange
      const user = userEvent.setup();
      const alert = makeAlert();
      mockedPatch.mockRejectedValueOnce(new Error('Network failure'));

      render(<BudgetAlertsList alerts={[alert]} />);

      // Act
      await user.click(screen.getByRole('button', { name: /pause agent/i }));

      // Assert: generic fallback message
      await waitFor(() => {
        expect(screen.getByText('Could not pause agent. Try again.')).toBeInTheDocument();
      });
    });
  });

  describe('alert list rendering', () => {
    it('renders agent name and budget alert count in the title', () => {
      const alerts = [
        makeAlert({ name: 'Alpha Bot' }),
        makeAlert({ agentId: 'a2', name: 'Beta Bot' }),
      ];

      render(<BudgetAlertsList alerts={alerts} />);

      expect(screen.getByText('Alpha Bot')).toBeInTheDocument();
      expect(screen.getByText('Beta Bot')).toBeInTheDocument();
      expect(screen.getByText('Budget alerts (2)')).toBeInTheDocument();
    });

    it('renders the Adjust budget link for each alert', () => {
      const alerts = [makeAlert({ agentId: 'agent-123', name: 'My Bot' })];
      render(<BudgetAlertsList alerts={alerts} />);

      const adjustLinks = screen.getAllByRole('link', { name: /adjust budget/i });
      expect(adjustLinks.length).toBeGreaterThanOrEqual(1);
      expect(adjustLinks[0]).toHaveAttribute('href', expect.stringContaining('agent-123'));
    });
  });
});
