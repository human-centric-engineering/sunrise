/**
 * OrchestrationSettingsForm Component Tests (Costs page variant)
 *
 * Test Coverage:
 * - Renders 4 Select fields populated from settings prop
 * - Save button disabled when !isDirty
 * - Budget cap shows read-only text with link to Settings page
 * - Submitting calls apiClient.patch with defaultModels payload
 * - 400 APIClientError → inline error banner shows message
 * - Saved state renders "Saved" text after successful submit
 *
 * @see components/admin/orchestration/costs/orchestration-settings-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
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
  webhookRetentionDays: null,
  costLogRetentionDays: null,
  auditLogRetentionDays: null,
  maxConversationsPerUser: null,
  maxMessagesPerConversation: null,
  escalationConfig: null,
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

    it('renders budget cap as read-only text with link to Settings', () => {
      render(<OrchestrationSettingsForm settings={MOCK_SETTINGS} models={MOCK_MODELS} />);

      expect(screen.getByText(/current cap: \$500/i)).toBeInTheDocument();
      expect(screen.getByText('manage in Settings')).toHaveAttribute(
        'href',
        '/admin/orchestration/settings'
      );
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

  describe('form submission — happy path', () => {
    it('calls apiClient.patch with defaultModels payload and shows "Saved" on success', async () => {
      mockedPatch.mockResolvedValueOnce({ id: 'settings-1', slug: 'global' });

      render(<OrchestrationSettingsForm settings={MOCK_SETTINGS} models={MOCK_MODELS} />);

      // Submit the form directly (simulates a model select change + submit)
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
      mockedPatch.mockRejectedValueOnce(
        new APIClientError('Invalid model id in defaultModels', 'VALIDATION_ERROR', 400)
      );

      render(<OrchestrationSettingsForm settings={MOCK_SETTINGS} models={MOCK_MODELS} />);

      // Submit the form directly
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
      mockedPatch.mockRejectedValueOnce(new Error('Network failure'));

      render(<OrchestrationSettingsForm settings={MOCK_SETTINGS} models={MOCK_MODELS} />);

      // Submit the form directly
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

  describe('null settings — renders empty form with warning', () => {
    it('renders "No global cap set" when settings is null', () => {
      render(<OrchestrationSettingsForm settings={null} models={MOCK_MODELS} />);

      expect(screen.getByText(/no global cap set/i)).toBeInTheDocument();
    });

    it('shows amber warning banner when settings is null', () => {
      render(<OrchestrationSettingsForm settings={null} models={MOCK_MODELS} />);

      expect(screen.getByText(/settings could not be loaded/i)).toBeInTheDocument();
    });

    it('does not show warning banner when settings is provided', () => {
      render(<OrchestrationSettingsForm settings={MOCK_SETTINGS} models={MOCK_MODELS} />);

      expect(screen.queryByText(/settings could not be loaded/i)).not.toBeInTheDocument();
    });
  });
});
