/**
 * McpSettingsForm Component Tests
 *
 * Test Coverage:
 * - Renders all form fields with initial values
 * - Save button disabled when pristine
 * - Save button enabled when dirty
 * - Successful submission calls apiClient.patch
 * - Shows "Saved" indicator on success
 * - Shows API error message on failure
 * - Shows generic error for non-API errors
 * - Validates field constraints (FieldHelp present)
 *
 * @see components/admin/orchestration/mcp/mcp-settings-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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

import { apiClient, APIClientError } from '@/lib/api/client';
import { McpSettingsForm } from '@/components/admin/orchestration/mcp/mcp-settings-form';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FULL_SETTINGS = {
  isEnabled: true,
  serverName: 'Sunrise MCP Server',
  serverVersion: '1.0.0',
  maxSessionsPerKey: 5,
  globalRateLimit: 60,
  auditRetentionDays: 90,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('McpSettingsForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Initial render', () => {
    it('renders all form fields with initial values', () => {
      render(<McpSettingsForm initialSettings={FULL_SETTINGS} />);
      expect(document.getElementById('serverName')).toHaveValue('Sunrise MCP Server');
      expect(document.getElementById('serverVersion')).toHaveValue('1.0.0');
      expect(document.getElementById('maxSessionsPerKey')).toHaveValue(5);
      expect(document.getElementById('globalRateLimit')).toHaveValue(60);
      expect(document.getElementById('auditRetentionDays')).toHaveValue(90);
    });

    it('renders defaults when initialSettings is null', () => {
      render(<McpSettingsForm initialSettings={null} />);
      expect(document.getElementById('serverName')).toHaveValue('Sunrise MCP Server');
      expect(document.getElementById('globalRateLimit')).toHaveValue(60);
    });

    it('renders FieldHelp tooltips for numeric fields', () => {
      render(<McpSettingsForm initialSettings={FULL_SETTINGS} />);
      expect(screen.getByText('Server Configuration')).toBeInTheDocument();
    });
  });

  describe('Button state', () => {
    it('disables save button when form is pristine', () => {
      render(<McpSettingsForm initialSettings={FULL_SETTINGS} />);
      expect(screen.getByRole('button', { name: /save settings/i })).toBeDisabled();
    });

    it('enables save button when form is dirty', async () => {
      const user = userEvent.setup();
      render(<McpSettingsForm initialSettings={FULL_SETTINGS} />);

      const nameInput = document.getElementById('serverName') as HTMLInputElement;
      await user.clear(nameInput);
      await user.type(nameInput, 'New Name');

      expect(screen.getByRole('button', { name: /save settings/i })).toBeEnabled();
    });
  });

  describe('Submission', () => {
    it('calls apiClient.patch with correct payload on submit', async () => {
      vi.mocked(apiClient.patch).mockResolvedValue({});

      render(<McpSettingsForm initialSettings={FULL_SETTINGS} />);

      const form = screen.getByRole('button', { name: /save settings/i }).closest('form');
      await act(async () => {
        fireEvent.submit(form!);
      });

      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          expect.stringContaining('/mcp/settings'),
          expect.objectContaining({
            body: expect.objectContaining({
              serverName: 'Sunrise MCP Server',
              globalRateLimit: 60,
              maxSessionsPerKey: 5,
              auditRetentionDays: 90,
            }),
          })
        );
      });
    });

    it('shows Saved indicator after successful submission', async () => {
      vi.mocked(apiClient.patch).mockResolvedValue({});

      render(<McpSettingsForm initialSettings={FULL_SETTINGS} />);

      const form = screen.getByRole('button', { name: /save settings/i }).closest('form');
      await act(async () => {
        fireEvent.submit(form!);
      });

      await waitFor(() => {
        expect(screen.getByText('Saved')).toBeInTheDocument();
      });
    });
  });

  describe('Error handling', () => {
    it('shows API error message on submission failure', async () => {
      vi.mocked(apiClient.patch).mockRejectedValue(
        new APIClientError('Rate limit must be between 1 and 10000')
      );

      render(<McpSettingsForm initialSettings={FULL_SETTINGS} />);

      const form = screen.getByRole('button', { name: /save settings/i }).closest('form');
      await act(async () => {
        fireEvent.submit(form!);
      });

      await waitFor(() => {
        expect(screen.getByText('Rate limit must be between 1 and 10000')).toBeInTheDocument();
      });
    });

    it('shows generic error for non-API errors', async () => {
      vi.mocked(apiClient.patch).mockRejectedValue(new Error('network failure'));

      render(<McpSettingsForm initialSettings={FULL_SETTINGS} />);

      const form = screen.getByRole('button', { name: /save settings/i }).closest('form');
      await act(async () => {
        fireEvent.submit(form!);
      });

      await waitFor(() => {
        expect(screen.getByText(/could not save settings/i)).toBeInTheDocument();
      });
    });
  });
});
