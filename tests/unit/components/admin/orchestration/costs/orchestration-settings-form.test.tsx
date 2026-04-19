/**
 * OrchestrationSettingsForm Component Tests
 *
 * Test Coverage:
 * - Renders 4 Select fields + budget Input populated from settings prop
 * - Save button disabled when !isDirty
 * - Typing into budget input enables Save
 * - Submitting calls apiClient.patch with expected payload
 * - 400 APIClientError → inline error banner shows message
 * - Saved state renders "Saved" text after successful submit
 *
 * @see components/admin/orchestration/costs/orchestration-settings-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { OrchestrationSettingsForm } from '@/components/admin/orchestration/costs/orchestration-settings-form';
import type { OrchestrationSettings } from '@/types/orchestration';
import type { ModelInfo } from '@/lib/orchestration/llm/types';

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

const mockedPatch = apiClient.patch as unknown as ReturnType<typeof vi.fn>;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_SETTINGS: OrchestrationSettings = {
  id: 'settings-1',
  slug: 'global',
  defaultModels: {
    routing: 'claude-haiku-4-5',
    chat: 'claude-sonnet-4-6',
    reasoning: 'claude-opus-4-6',
    embeddings: 'claude-haiku-4-5',
  },
  globalMonthlyBudgetUsd: 500,
  searchConfig: null,
  lastSeededAt: null,
  defaultApprovalTimeoutMs: null,
  approvalDefaultAction: 'deny',
  inputGuardMode: 'log_only',
  outputGuardMode: 'log_only',
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

const MOCK_MODELS: ModelInfo[] = [
  {
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic',
    tier: 'budget',
    inputCostPerMillion: 1,
    outputCostPerMillion: 5,
    maxContext: 200_000,
    supportsTools: true,
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    tier: 'mid',
    inputCostPerMillion: 3,
    outputCostPerMillion: 15,
    maxContext: 200_000,
    supportsTools: true,
  },
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    provider: 'anthropic',
    tier: 'frontier',
    inputCostPerMillion: 15,
    outputCostPerMillion: 75,
    maxContext: 200_000,
    supportsTools: true,
  },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('OrchestrationSettingsForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('initial render', () => {
    it('renders the form with 4 task-select triggers', () => {
      render(<OrchestrationSettingsForm settings={MOCK_SETTINGS} models={MOCK_MODELS} />);

      // 4 select triggers for routing, chat, reasoning, embeddings
      const combos = screen.getAllByRole('combobox');
      expect(combos.length).toBeGreaterThanOrEqual(4);
    });

    it('renders the budget input with existing value from settings', () => {
      render(<OrchestrationSettingsForm settings={MOCK_SETTINGS} models={MOCK_MODELS} />);

      const budgetInput = screen.getByRole('spinbutton');
      expect(budgetInput).toHaveValue(500);
    });

    it('renders the card with test id', () => {
      render(<OrchestrationSettingsForm settings={MOCK_SETTINGS} models={MOCK_MODELS} />);
      expect(screen.getByTestId('orchestration-settings-form')).toBeInTheDocument();
    });
  });

  describe('Save button disabled state', () => {
    it('Save button is disabled when form is not dirty', () => {
      render(<OrchestrationSettingsForm settings={MOCK_SETTINGS} models={MOCK_MODELS} />);

      const saveBtn = screen.getByRole('button', { name: /save changes/i });
      expect(saveBtn).toBeDisabled();
    });
  });

  describe('typing into budget input enables Save', () => {
    it('Save button becomes enabled after changing the budget field', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<OrchestrationSettingsForm settings={MOCK_SETTINGS} models={MOCK_MODELS} />);

      // Act: clear budget and type a new value to mark form dirty
      const budgetInput = screen.getByRole('spinbutton');
      await user.clear(budgetInput);
      await user.type(budgetInput, '750');

      // Assert: Save button is now enabled
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /save changes/i })).not.toBeDisabled();
      });
    });
  });

  describe('form submission — happy path', () => {
    it('calls apiClient.patch with settings payload and shows "Saved" on success', async () => {
      // Arrange
      const user = userEvent.setup();
      mockedPatch.mockResolvedValueOnce({ id: 'settings-1', slug: 'global' });

      render(<OrchestrationSettingsForm settings={MOCK_SETTINGS} models={MOCK_MODELS} />);

      // Make form dirty by changing budget
      const budgetInput = screen.getByRole('spinbutton');
      await user.clear(budgetInput);
      await user.type(budgetInput, '600');

      // Wait for Save to become enabled (form dirty)
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /save changes/i })).not.toBeDisabled();
      });

      // Act: submit the form directly to bypass the button's disabled state races
      const form = screen.getByTestId('orchestration-settings-form').closest('form');
      await act(async () => {
        fireEvent.submit(form!);
      });

      // Assert: patch was called with settings endpoint and payload
      await waitFor(
        () => {
          expect(mockedPatch).toHaveBeenCalledWith(
            '/api/v1/admin/orchestration/settings',
            expect.objectContaining({
              body: expect.objectContaining({
                defaultModels: expect.objectContaining({
                  routing: 'claude-haiku-4-5',
                  chat: 'claude-sonnet-4-6',
                }),
              }),
            })
          );
        },
        { timeout: 3000 }
      );

      // Assert: "Saved" indicator appears after successful save
      await waitFor(() => {
        expect(screen.getByText('Saved')).toBeInTheDocument();
      });
    });
  });

  describe('form submission — error handling', () => {
    it('shows error banner when PATCH rejects with APIClientError', async () => {
      // Arrange
      const user = userEvent.setup();
      mockedPatch.mockRejectedValueOnce(
        new APIClientError('Invalid model id in defaultModels', 'VALIDATION_ERROR', 400)
      );

      render(<OrchestrationSettingsForm settings={MOCK_SETTINGS} models={MOCK_MODELS} />);

      // Make dirty
      const budgetInput = screen.getByRole('spinbutton');
      await user.clear(budgetInput);
      await user.type(budgetInput, '1000');

      // Wait for Save to become enabled
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /save changes/i })).not.toBeDisabled();
      });

      // Act: submit the form directly
      const form = screen.getByTestId('orchestration-settings-form').closest('form');
      await act(async () => {
        fireEvent.submit(form!);
      });

      // Assert: error banner shows message
      await waitFor(
        () => {
          expect(screen.getByText('Invalid model id in defaultModels')).toBeInTheDocument();
        },
        { timeout: 3000 }
      );
    });

    it('shows generic error message for non-APIClientError rejections', async () => {
      // Arrange
      const user = userEvent.setup();
      mockedPatch.mockRejectedValueOnce(new Error('Network failure'));

      render(<OrchestrationSettingsForm settings={MOCK_SETTINGS} models={MOCK_MODELS} />);

      const budgetInput = screen.getByRole('spinbutton');
      await user.clear(budgetInput);
      await user.type(budgetInput, '1000');

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /save changes/i })).not.toBeDisabled();
      });

      // Act: submit the form directly
      const form = screen.getByTestId('orchestration-settings-form').closest('form');
      await act(async () => {
        fireEvent.submit(form!);
      });

      await waitFor(
        () => {
          expect(
            screen.getByText('Could not save settings. Try again in a moment.')
          ).toBeInTheDocument();
        },
        { timeout: 3000 }
      );
    });
  });

  describe('null settings — renders empty form', () => {
    it('renders empty budget input when settings is null', () => {
      render(<OrchestrationSettingsForm settings={null} models={MOCK_MODELS} />);

      // Budget input should have empty/null value
      const budgetInput = screen.getByRole('spinbutton');
      // When globalMonthlyBudgetUsd is null, the input defaults to empty string
      expect(budgetInput).toHaveValue(null);
    });
  });
});
