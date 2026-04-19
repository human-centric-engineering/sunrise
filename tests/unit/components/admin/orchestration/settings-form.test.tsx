/**
 * SettingsForm Tests
 *
 * Test Coverage:
 * - Renders guard mode select
 * - Renders global budget input
 * - Submits settings update
 *
 * @see components/admin/orchestration/settings-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SettingsForm } from '@/components/admin/orchestration/settings-form';

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

const DEFAULT_SETTINGS = {
  inputGuardMode: 'log_only',
  globalMonthlyBudgetUsd: null,
  defaultApprovalTimeoutMs: null,
  approvalDefaultAction: 'deny',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SettingsForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders guard mode select', () => {
    render(<SettingsForm initialSettings={DEFAULT_SETTINGS} />);
    expect(screen.getByRole('combobox', { name: /input guard/i })).toBeInTheDocument();
  });

  it('renders global budget input', () => {
    render(<SettingsForm initialSettings={DEFAULT_SETTINGS} />);
    expect(document.getElementById('globalBudget')).toBeInTheDocument();
  });

  it('renders approval action select', () => {
    render(<SettingsForm initialSettings={DEFAULT_SETTINGS} />);
    expect(screen.getByRole('combobox', { name: /approval default action/i })).toBeInTheDocument();
  });

  it('submits settings update', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockResolvedValue({ success: true });

    const user = userEvent.setup();
    render(<SettingsForm initialSettings={DEFAULT_SETTINGS} />);

    await user.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() => {
      expect(apiClient.patch).toHaveBeenCalledWith(
        expect.stringContaining('/settings'),
        expect.objectContaining({
          body: expect.objectContaining({
            inputGuardMode: 'log_only',
          }),
        })
      );
    });
  });
});
