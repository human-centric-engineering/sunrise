/**
 * DefaultModelsForm Component Tests
 *
 * Test Coverage:
 * - Renders 4 Select fields populated from settings prop
 * - Save button disabled when !isDirty
 * - Submitting calls apiClient.patch with defaultModels payload
 * - 400 APIClientError → inline error banner shows message
 * - Saved state renders "Saved" text after successful submit
 *
 * Lives on the Settings page since the move from the Costs page —
 * default-model selection is closer to "global config" than to cost
 * analytics.
 *
 * @see components/admin/orchestration/default-models-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DefaultModelsForm } from '@/components/admin/orchestration/default-models-form';
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
  // Default fixture treats every slot as operator-saved — individual
  // tests override `defaultModelsStored` to exercise the empty-slot UX.
  defaultModelsStored: {
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
  citationGuardMode: 'log_only',
  webhookRetentionDays: null,
  costLogRetentionDays: null,
  auditLogRetentionDays: null,
  maxConversationsPerUser: null,
  maxMessagesPerConversation: null,
  escalationConfig: null,
  embedAllowedOrigins: [],
  voiceInputGloballyEnabled: true,
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

// At least one configured provider — without this, the form renders
// the no-providers CTA and hides the dropdowns.
const MOCK_PROVIDERS = [{ slug: 'anthropic', name: 'Anthropic', isActive: true }];

const MOCK_EMBEDDING_MODELS = [
  {
    id: 'openai/text-embedding-3-small',
    name: 'text-embedding-3-small',
    provider: 'OpenAI',
    model: 'text-embedding-3-small',
  },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DefaultModelsForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('initial render', () => {
    it('renders the form with 4 task-select triggers', () => {
      render(
        <DefaultModelsForm
          settings={MOCK_SETTINGS}
          models={MOCK_MODELS}
          providers={MOCK_PROVIDERS}
          embeddingModels={MOCK_EMBEDDING_MODELS}
        />
      );

      // 4 select triggers for routing, chat, reasoning, embeddings
      const combos = screen.getAllByRole('combobox');
      expect(combos.length).toBeGreaterThanOrEqual(4);
    });

    it('does not render the legacy budget-cap section', () => {
      // The form previously included a read-only budget summary that
      // pointed at Settings. Now that the form lives on Settings (and
      // the actual budget editor is in <SettingsForm> on the same page)
      // that section is gone.
      render(
        <DefaultModelsForm
          settings={MOCK_SETTINGS}
          models={MOCK_MODELS}
          providers={MOCK_PROVIDERS}
          embeddingModels={MOCK_EMBEDDING_MODELS}
        />
      );

      expect(screen.queryByText(/global monthly budget cap/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/manage in settings/i)).not.toBeInTheDocument();
    });

    it('renders the card with test id', () => {
      render(
        <DefaultModelsForm
          settings={MOCK_SETTINGS}
          models={MOCK_MODELS}
          providers={MOCK_PROVIDERS}
          embeddingModels={MOCK_EMBEDDING_MODELS}
        />
      );
      expect(screen.getByTestId('default-models-form')).toBeInTheDocument();
    });
  });

  describe('stored vs suggested distinction', () => {
    it('shows "Saved override" + Clear link for slots the operator has saved', () => {
      render(
        <DefaultModelsForm
          settings={MOCK_SETTINGS}
          models={MOCK_MODELS}
          providers={MOCK_PROVIDERS}
          embeddingModels={MOCK_EMBEDDING_MODELS}
        />
      );

      // The default fixture marks every slot as stored, so all four
      // footers show the Saved override state.
      const saved = screen.getAllByText(/Saved override/i);
      expect(saved.length).toBe(4);
      const clearButtons = screen.getAllByRole('button', { name: /Clear \(use suggestion\)/i });
      expect(clearButtons.length).toBe(4);
    });

    it('shows the suggested model + Use suggestion button for empty slots', () => {
      // Stored is empty for `chat`; the form should render Chat's
      // dropdown empty and surface a suggestion footer.
      const settingsWithEmptyChat: OrchestrationSettings = {
        ...MOCK_SETTINGS,
        defaultModelsStored: {
          routing: 'claude-haiku-4-5',
          // chat: missing on purpose
          reasoning: 'claude-opus-4-6',
          embeddings: 'claude-haiku-4-5',
        },
      };

      render(
        <DefaultModelsForm
          settings={settingsWithEmptyChat}
          models={MOCK_MODELS}
          providers={MOCK_PROVIDERS}
          embeddingModels={MOCK_EMBEDDING_MODELS}
        />
      );

      // The hydrated `defaultModels.chat` ('claude-sonnet-4-6') is
      // surfaced as a suggestion, NOT as a saved value.
      expect(screen.getByText(/Suggested:/i)).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: /^Use suggestion$/i }).length).toBe(1);
    });

    it('Use suggestion makes the form dirty so Save lights up', async () => {
      const settingsWithEmptyChat: OrchestrationSettings = {
        ...MOCK_SETTINGS,
        defaultModelsStored: {
          routing: 'claude-haiku-4-5',
          reasoning: 'claude-opus-4-6',
          embeddings: 'claude-haiku-4-5',
        },
      };
      const user = userEvent.setup();

      render(
        <DefaultModelsForm
          settings={settingsWithEmptyChat}
          models={MOCK_MODELS}
          providers={MOCK_PROVIDERS}
          embeddingModels={MOCK_EMBEDDING_MODELS}
        />
      );

      const saveBtn = screen.getByRole('button', { name: /save changes/i });
      expect(saveBtn).toBeDisabled();

      await user.click(screen.getByRole('button', { name: /^Use suggestion$/i }));

      // Picking the suggestion commits it as a saved value → form
      // dirty → Save enabled.
      expect(saveBtn).not.toBeDisabled();
    });

    it('Clear drops the saved override and falls back to the suggestion footer', async () => {
      const user = userEvent.setup();
      render(
        <DefaultModelsForm
          settings={MOCK_SETTINGS}
          models={MOCK_MODELS}
          providers={MOCK_PROVIDERS}
          embeddingModels={MOCK_EMBEDDING_MODELS}
        />
      );

      const clearButtons = screen.getAllByRole('button', { name: /Clear \(use suggestion\)/i });
      // Clear the chat slot (second of the four saved overrides — order
      // is: routing, chat, reasoning, embeddings).
      await user.click(clearButtons[1]);

      // After clearing, that slot now shows a Use-suggestion footer
      // and the Save button is enabled (form is dirty).
      expect(screen.getByText(/Suggested:/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /save changes/i })).not.toBeDisabled();
    });
  });

  describe('Save button disabled state', () => {
    it('Save button is disabled when form is not dirty', () => {
      render(
        <DefaultModelsForm
          settings={MOCK_SETTINGS}
          models={MOCK_MODELS}
          providers={MOCK_PROVIDERS}
          embeddingModels={MOCK_EMBEDDING_MODELS}
        />
      );

      const saveBtn = screen.getByRole('button', { name: /save changes/i });
      expect(saveBtn).toBeDisabled();
    });
  });

  describe('form submission — happy path', () => {
    it('calls apiClient.patch with defaultModels payload and shows "Saved" on success', async () => {
      mockedPatch.mockResolvedValueOnce({ id: 'settings-1', slug: 'global' });

      render(
        <DefaultModelsForm
          settings={MOCK_SETTINGS}
          models={MOCK_MODELS}
          providers={MOCK_PROVIDERS}
          embeddingModels={MOCK_EMBEDDING_MODELS}
        />
      );

      // Submit the form directly (simulates a model select change + submit)
      const form = screen.getByTestId('default-models-form').closest('form');
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

    it('omits empty slots from the payload so partial saves do not 400', async () => {
      // Regression: server schema requires `z.string().min(1)` per task,
      // so the form must filter out empty values before submitting. With
      // only chat saved, the payload should contain `{ chat }` and
      // nothing else — not `{ routing: '', chat, reasoning: '', embeddings: '' }`.
      mockedPatch.mockResolvedValueOnce({ id: 'settings-1', slug: 'global' });

      render(
        <DefaultModelsForm
          settings={{
            ...MOCK_SETTINGS,
            defaultModelsStored: { chat: 'claude-sonnet-4-6' },
          }}
          models={MOCK_MODELS}
          providers={MOCK_PROVIDERS}
          embeddingModels={MOCK_EMBEDDING_MODELS}
        />
      );

      // Mark the form dirty by clicking "Use suggestion" on the routing
      // slot (which is empty in stored). That gives us {chat, routing}
      // in the payload but still leaves reasoning/embeddings empty.
      const [firstUseSuggestion] = screen.getAllByRole('button', { name: /use suggestion/i });
      await act(async () => {
        fireEvent.click(firstUseSuggestion);
      });

      const form = screen.getByTestId('default-models-form').closest('form');
      await act(async () => {
        fireEvent.submit(form!);
      });

      await waitFor(
        () => {
          expect(mockedPatch).toHaveBeenCalledTimes(1);
        },
        { timeout: 3000 }
      );

      const [, firstCallOptions] = mockedPatch.mock.calls[0];
      const sentBody = firstCallOptions.body as {
        defaultModels: Record<string, string>;
      };
      // Empty slots must not appear in the payload at all.
      expect(sentBody.defaultModels).not.toHaveProperty('reasoning');
      expect(sentBody.defaultModels).not.toHaveProperty('embeddings');
      // No empty-string values anywhere.
      for (const v of Object.values(sentBody.defaultModels)) {
        expect(v).not.toBe('');
      }
      // The chat slot the operator already had stored is preserved.
      expect(sentBody.defaultModels.chat).toBe('claude-sonnet-4-6');
    });
  });

  describe('form submission — error handling', () => {
    it('shows error banner when PATCH rejects with APIClientError', async () => {
      mockedPatch.mockRejectedValueOnce(
        new APIClientError('Invalid model id in defaultModels', 'VALIDATION_ERROR', 400)
      );

      render(
        <DefaultModelsForm
          settings={MOCK_SETTINGS}
          models={MOCK_MODELS}
          providers={MOCK_PROVIDERS}
          embeddingModels={MOCK_EMBEDDING_MODELS}
        />
      );

      // Submit the form directly
      const form = screen.getByTestId('default-models-form').closest('form');
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

      render(
        <DefaultModelsForm
          settings={MOCK_SETTINGS}
          models={MOCK_MODELS}
          providers={MOCK_PROVIDERS}
          embeddingModels={MOCK_EMBEDDING_MODELS}
        />
      );

      // Submit the form directly
      const form = screen.getByTestId('default-models-form').closest('form');
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
    it('shows amber warning banner when settings is null', () => {
      render(
        <DefaultModelsForm
          settings={null}
          models={MOCK_MODELS}
          providers={MOCK_PROVIDERS}
          embeddingModels={MOCK_EMBEDDING_MODELS}
        />
      );

      expect(screen.getByText(/settings could not be loaded/i)).toBeInTheDocument();
    });

    it('does not show warning banner when settings is provided', () => {
      render(
        <DefaultModelsForm
          settings={MOCK_SETTINGS}
          models={MOCK_MODELS}
          providers={MOCK_PROVIDERS}
          embeddingModels={MOCK_EMBEDDING_MODELS}
        />
      );

      expect(screen.queryByText(/settings could not be loaded/i)).not.toBeInTheDocument();
    });
  });

  describe('configured-provider gate', () => {
    it('renders the no-providers CTA and hides the dropdowns when nothing is configured', () => {
      render(
        <DefaultModelsForm
          settings={MOCK_SETTINGS}
          models={MOCK_MODELS}
          providers={[]}
          embeddingModels={MOCK_EMBEDDING_MODELS}
        />
      );

      expect(screen.getByText(/No providers configured yet/i)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /Open Providers/i })).toHaveAttribute(
        'href',
        '/admin/orchestration/providers'
      );
      // The four task dropdowns must be absent — we don't list models
      // the system can't actually reach.
      expect(document.getElementById('model-chat')).toBeNull();
      expect(document.getElementById('model-routing')).toBeNull();
      expect(document.getElementById('model-reasoning')).toBeNull();
      expect(document.getElementById('model-embeddings')).toBeNull();
    });

    it('treats inactive providers as not-configured for the gate', () => {
      // A provider that's been soft-deleted (isActive=false) shouldn't
      // unlock the form. The operator should reactivate it first.
      render(
        <DefaultModelsForm
          settings={MOCK_SETTINGS}
          models={MOCK_MODELS}
          providers={[{ slug: 'anthropic', name: 'Anthropic', isActive: false }]}
          embeddingModels={MOCK_EMBEDDING_MODELS}
        />
      );

      expect(screen.getByText(/No providers configured yet/i)).toBeInTheDocument();
    });
  });

  describe('per-task option filtering', () => {
    it('chat / routing / reasoning dropdowns only show models from configured providers', async () => {
      const mixedModels: ModelInfo[] = [
        ...MOCK_MODELS,
        // GPT-4o belongs to "openai" — not configured here, must be hidden.
        {
          id: 'gpt-4o',
          name: 'GPT-4o',
          provider: 'openai',
          tier: 'frontier',
          inputCostPerMillion: 2.5,
          outputCostPerMillion: 10,
          maxContext: 128_000,
          supportsTools: true,
        },
      ];

      // Settings with Anthropic-only provider: GPT-4o would be a leak.
      const settingsWithEmptyChat: OrchestrationSettings = {
        ...MOCK_SETTINGS,
        defaultModelsStored: {
          routing: 'claude-haiku-4-5',
          reasoning: 'claude-opus-4-6',
          embeddings: 'text-embedding-3-small',
        },
      };
      const user = userEvent.setup();

      render(
        <DefaultModelsForm
          settings={settingsWithEmptyChat}
          models={mixedModels}
          providers={MOCK_PROVIDERS}
          embeddingModels={MOCK_EMBEDDING_MODELS}
        />
      );

      // Open the chat dropdown.
      await user.click(document.getElementById('model-chat') as HTMLElement);

      // Anthropic options visible, GPT-4o NOT.
      expect(screen.getByRole('option', { name: /Claude Haiku/i })).toBeInTheDocument();
      expect(screen.queryByRole('option', { name: /GPT-4o/i })).not.toBeInTheDocument();
    });

    it('embeddings dropdown shows only embedding-capable models for configured providers', async () => {
      // Configure both Anthropic and OpenAI; embedding model belongs to OpenAI.
      const providers = [
        { slug: 'anthropic', name: 'Anthropic', isActive: true },
        { slug: 'openai', name: 'OpenAI', isActive: true },
      ];
      const settingsWithEmptyEmbed: OrchestrationSettings = {
        ...MOCK_SETTINGS,
        defaultModelsStored: {
          routing: 'claude-haiku-4-5',
          chat: 'claude-sonnet-4-6',
          reasoning: 'claude-opus-4-6',
        },
      };
      const user = userEvent.setup();

      render(
        <DefaultModelsForm
          settings={settingsWithEmptyEmbed}
          models={MOCK_MODELS}
          providers={providers}
          embeddingModels={MOCK_EMBEDDING_MODELS}
        />
      );

      await user.click(document.getElementById('model-embeddings') as HTMLElement);

      // Only the OpenAI embedding option, not chat models.
      expect(screen.getByRole('option', { name: /text-embedding-3-small/i })).toBeInTheDocument();
      expect(screen.queryByRole('option', { name: /Claude Sonnet/i })).not.toBeInTheDocument();
    });

    it('does not show a suggestion footer for embeddings when the suggested id is not an embedding-capable model', () => {
      // Regression: computeDefaultModelMap previously suggested a chat
      // model (e.g. gpt-4o-mini) for embeddings. Even if a stale row in
      // the DB still carries that bad value, the form must not render
      // it as "Suggested:" — there's no matching dropdown option, so
      // "Use suggestion" would be a no-op and the operator would be
      // confused.
      const providers = [
        { slug: 'anthropic', name: 'Anthropic', isActive: true },
        { slug: 'openai', name: 'OpenAI', isActive: true },
      ];
      const settingsWithBadEmbeddingsSuggestion: OrchestrationSettings = {
        ...MOCK_SETTINGS,
        // Hydrated map has the bad suggestion …
        defaultModels: {
          routing: 'claude-haiku-4-5',
          chat: 'claude-sonnet-4-6',
          reasoning: 'claude-opus-4-6',
          embeddings: 'gpt-4o-mini',
        },
        // … but the operator hasn't saved an embeddings override.
        defaultModelsStored: {
          routing: 'claude-haiku-4-5',
          chat: 'claude-sonnet-4-6',
          reasoning: 'claude-opus-4-6',
        },
      };

      render(
        <DefaultModelsForm
          settings={settingsWithBadEmbeddingsSuggestion}
          models={MOCK_MODELS}
          providers={providers}
          embeddingModels={MOCK_EMBEDDING_MODELS}
        />
      );

      // The footer for the empty embeddings slot must NOT show the
      // chat-model id as a suggestion. Other slots can still show
      // Saved-override badges; we only assert "gpt-4o-mini" never appears.
      expect(screen.queryByText(/gpt-4o-mini/)).not.toBeInTheDocument();
      // And the form should fall through to the no-suggestion message
      // for the embeddings slot.
      expect(
        screen.getByText(/No suggestion available — pick a model from the dropdown/i)
      ).toBeInTheDocument();
    });

    it('embeddings shows the no-embedding-provider hint when none of the configured providers offer embeddings', () => {
      // Anthropic only, no embedding-capable model in MOCK_EMBEDDING_MODELS.
      const settingsWithEmptyEmbed: OrchestrationSettings = {
        ...MOCK_SETTINGS,
        defaultModelsStored: {
          routing: 'claude-haiku-4-5',
          chat: 'claude-sonnet-4-6',
          reasoning: 'claude-opus-4-6',
        },
      };

      render(
        <DefaultModelsForm
          settings={settingsWithEmptyEmbed}
          models={MOCK_MODELS}
          providers={MOCK_PROVIDERS}
          embeddingModels={MOCK_EMBEDDING_MODELS} // OpenAI but not configured
        />
      );

      expect(
        screen.getByText(/None of your configured providers offer embeddings/i)
      ).toBeInTheDocument();
      // Suggest mentioning Voyage AI, OpenAI, Google, Mistral, Ollama.
      expect(
        screen.getByText(/Voyage AI, OpenAI, Google, Mistral, or local Ollama/i)
      ).toBeInTheDocument();
    });

    it('honest placeholder reads "Not set — pick a model" when slot is empty', () => {
      const settingsWithEmptyChat: OrchestrationSettings = {
        ...MOCK_SETTINGS,
        defaultModelsStored: {
          routing: 'claude-haiku-4-5',
          reasoning: 'claude-opus-4-6',
          embeddings: 'text-embedding-3-small',
        },
      };

      render(
        <DefaultModelsForm
          settings={settingsWithEmptyChat}
          models={MOCK_MODELS}
          providers={MOCK_PROVIDERS}
          embeddingModels={MOCK_EMBEDDING_MODELS}
        />
      );

      expect(screen.getByText('Not set — pick a model')).toBeInTheDocument();
    });
  });
});
