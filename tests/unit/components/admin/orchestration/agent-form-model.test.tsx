/**
 * AgentForm — Model Tab Tests
 *
 * Test Coverage:
 * - Provider change filters model Select options
 * - Test connection success shows "{n} models available"
 * - Test connection failure shows friendly fallback, raw error NOT in DOM
 * - Provider/model null hydration → free-text Input fallback + warning banner
 *
 * @see components/admin/orchestration/agent-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AgentForm } from '@/components/admin/orchestration/agent-form';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PROVIDERS = [
  {
    id: 'prov-anthropic',
    name: 'Anthropic',
    slug: 'anthropic',
    providerType: 'anthropic',
    apiKeyEnvVar: 'ANTHROPIC_KEY',
    isActive: true,
    isLocal: false,
    createdBy: 'system',
    createdAt: new Date(),
    updatedAt: new Date(),
    baseUrl: null,
    metadata: {},
    timeoutMs: null,
    maxRetries: null,
  },
  {
    id: 'prov-openai',
    name: 'OpenAI',
    slug: 'openai',
    providerType: 'openai-compatible',
    apiKeyEnvVar: null,
    isActive: true,
    isLocal: false,
    createdBy: 'system',
    createdAt: new Date(),
    updatedAt: new Date(),
    baseUrl: null,
    metadata: {},
    timeoutMs: null,
    maxRetries: null,
  },
];

const MODELS = [
  { provider: 'anthropic', id: 'claude-opus-4-6', tier: 'frontier' },
  { provider: 'anthropic', id: 'claude-haiku-3', tier: 'budget' },
  { provider: 'openai', id: 'gpt-4o', tier: 'frontier' },
  { provider: 'openai', id: 'gpt-4o-mini', tier: 'budget' },
];

async function renderAndOpenModelTab() {
  const user = userEvent.setup();
  render(<AgentForm mode="create" providers={PROVIDERS} models={MODELS} />);
  await user.click(screen.getByRole('tab', { name: /model/i }));
  return user;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AgentForm — Model tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Provider / Model filtering ─────────────────────────────────────────────

  describe('provider / model Select', () => {
    it('opens Model tab and shows provider select', async () => {
      // Arrange & Act
      await renderAndOpenModelTab();

      // Assert: provider select trigger is visible
      expect(screen.getByRole('combobox', { name: /provider/i })).toBeInTheDocument();
    });

    it('shows only models belonging to the selected provider', async () => {
      // Arrange
      const user = await renderAndOpenModelTab();

      // By default provider is 'anthropic', open the model combobox
      const modelSelect = screen.getByRole('combobox', { name: /model/i });
      await user.click(modelSelect);

      // Assert: anthropic models visible, openai models not visible
      await waitFor(() => {
        expect(screen.getByRole('option', { name: /claude-opus-4-6/i })).toBeInTheDocument();
        expect(screen.getByRole('option', { name: /claude-haiku-3/i })).toBeInTheDocument();
        expect(screen.queryByRole('option', { name: /gpt-4o/i })).not.toBeInTheDocument();
      });
    });

    it('caps the model popover at 60vh so long lists scroll on short screens', async () => {
      // Without an explicit max-h on the SelectContent the popover relies on
      // Radix's `--radix-select-content-available-height`, which only covers
      // the space below the trigger. On mid-page short screens with 20+ models
      // the popover ran off the viewport with no scroll. The fix is a tighter
      // viewport-relative cap. Asserting the class is the regression guard —
      // a future cleanup that strips the className would re-introduce the bug.
      const user = await renderAndOpenModelTab();

      // Open the model combobox so Radix renders the SelectContent.
      const modelSelect = screen.getByRole('combobox', { name: /model/i });
      await user.click(modelSelect);

      // The model combobox's `aria-controls` points at the SelectContent's
      // outer wrapper — that's the element carrying max-h-[60vh].
      await waitFor(() => {
        const contentId = modelSelect.getAttribute('aria-controls');
        expect(contentId).toBeTruthy();
        const content = document.getElementById(contentId!);
        expect(content).not.toBeNull();
        expect(content!.className).toMatch(/max-h-\[60vh\]/);
      });
    });

    it('auto-resets model when provider changes to one that does not own current model', async () => {
      // Hits the useEffect at agent-form.tsx:172-179. Default provider is
      // anthropic with model claude-opus-4-6; switching to openai makes the
      // current model invalid for the new provider, so the effect picks
      // the first openai model (gpt-4o). Covers both the `!valid` and the
      // `filteredModels.length > 0` truthy branches.
      const user = await renderAndOpenModelTab();

      const providerSelect = screen.getByRole('combobox', { name: /provider/i });
      await user.click(providerSelect);
      const openaiOption = await screen.findByRole('option', { name: /openai/i });
      await user.click(openaiOption);

      // Effect synchronously sets model to filteredModels[0].id — the model
      // combobox should now display an openai model.
      await waitFor(() => {
        const modelTrigger = screen.getByRole('combobox', { name: /model/i });
        expect(modelTrigger).toHaveTextContent(/gpt-4o/i);
      });
    });
  });

  // ── Legacy model fallback (saved model no longer in matrix) ───────────────

  describe('legacy model fallback on edit', () => {
    // The agent form's model dropdown is restricted to the operator-
    // curated provider matrix. When editing an existing agent whose
    // saved model is no longer in that matrix (matrix row deactivated
    // or deleted since the agent was last saved), the form must:
    //   1. Surface the saved model as a SelectItem so the operator
    //      doesn't silently lose the selection;
    //   2. Mark it as "no longer in matrix" so they know to pick a
    //      replacement before saving;
    //   3. Skip the auto-reset that would otherwise switch to
    //      filteredModels[0] (which would drop the legacy value).
    //
    // Without this fallback the existing agent's model field flips on
    // first edit — a confusing UX regression.

    const SAVED_AGENT_WITH_LEGACY_MODEL = {
      id: 'agent-1',
      slug: 'archived-bot',
      name: 'Archived Bot',
      description: 'Predates the current matrix',
      provider: 'anthropic',
      model: 'claude-opus-3-deprecated',
      systemInstructions: 'be helpful',
      visibility: 'internal' as const,
      retentionDays: 30,
      temperature: 0.7,
      maxTokens: 4096,
      isActive: true,
      rateLimitRpm: null,
      maxHistoryTokens: null,
      maxHistoryMessages: null,
      enableImageInput: false,
      enableDocumentInput: false,
      enableAudioInput: false,
      enableVoiceInput: false,
      inputGuardMode: 'inherit',
      outputGuardMode: 'inherit',
      contextWindowAlertThreshold: 80,
      citationGuardMode: 'inherit',
      knowledgeAccessMode: 'full' as const,
      structuredOutputSchema: null,
      providerFallbacks: [],
      attachmentMaxBytes: null,
      attachmentMaxCount: null,
      attachmentAllowedExt: [],
      voiceTtsModel: null,
      voiceTtsVoice: null,
      activeVersionId: null,
      widgetConfig: null,
      userId: 'user-1',
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    function renderEditWithLegacyModel() {
      // Use type assertion only for the unknown-prop mismatches between
      // the fixture and the live Prisma model shape — irrelevant to the
      // assertions below.

      const agent = SAVED_AGENT_WITH_LEGACY_MODEL as any;
      return render(<AgentForm mode="edit" agent={agent} providers={PROVIDERS} models={MODELS} />);
    }

    it('renders the saved model as a SelectItem even though it is not in the matrix', async () => {
      const user = userEvent.setup();
      renderEditWithLegacyModel();
      await user.click(screen.getByRole('tab', { name: /model/i }));

      // The model trigger displays the saved (legacy) value.
      const modelTrigger = screen.getByRole('combobox', { name: /model/i });
      expect(modelTrigger).toHaveTextContent('claude-opus-3-deprecated');

      // Open the dropdown — the legacy option is present with the
      // "no longer in matrix" marker, alongside the in-matrix options.
      await user.click(modelTrigger);
      await waitFor(() => {
        expect(
          screen.getByTestId('model-option-legacy-claude-opus-3-deprecated')
        ).toBeInTheDocument();
        // In-matrix options still listed below.
        expect(screen.getByRole('option', { name: /claude-opus-4-6/i })).toBeInTheDocument();
      });
    });

    it('displays the "no longer in matrix" badge text on the legacy option', async () => {
      const user = userEvent.setup();
      renderEditWithLegacyModel();
      await user.click(screen.getByRole('tab', { name: /model/i }));

      // The badge appears in TWO places — Radix's SelectValue mirrors
      // the selected option's children into the trigger, AND the
      // dropdown renders the option itself. Both surfaces should show
      // the marker so the operator sees it pre-open. Assert ≥ 1 to
      // confirm the trigger displays it. The dropdown render is
      // covered by the testid assertion in the previous test.
      await waitFor(() => {
        expect(screen.getAllByText(/no longer in matrix/i).length).toBeGreaterThanOrEqual(1);
      });
    });

    it('does NOT auto-reset the saved model on initial render', async () => {
      // Regression guard against the auto-reset effect at agent-form.tsx
      // (which kicks in when filteredModels lacks the current model).
      // The legacy-entry synthesis must keep `currentModel` valid so the
      // effect's `valid` check returns true and no reset fires.
      const user = userEvent.setup();
      renderEditWithLegacyModel();
      await user.click(screen.getByRole('tab', { name: /model/i }));

      const modelTrigger = screen.getByRole('combobox', { name: /model/i });
      // Allow a frame for any effect-driven setValue calls to settle.
      await waitFor(() => {
        expect(modelTrigger).toHaveTextContent('claude-opus-3-deprecated');
      });
    });

    it('does NOT show the legacy badge in create mode (only edit)', async () => {
      const user = await renderAndOpenModelTab();
      await user.click(screen.getByRole('combobox', { name: /model/i }));

      await waitFor(() => {
        expect(screen.queryByText(/no longer in matrix/i)).not.toBeInTheDocument();
      });
    });
  });

  // ── Test connection ────────────────────────────────────────────────────────

  describe('test connection', () => {
    it('shows "{n} models available" on success', async () => {
      // Arrange — the real API response shape is `{ ok, models: string[] }`,
      // matching `lib/orchestration/llm/provider.ts` ProviderTestResult.
      // A previous version of this test mocked `{ modelCount: 5 }`, which
      // masked a bug where agent-test-card was reading a non-existent
      // `modelCount` field and always showing "0 models available".
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({
        ok: true,
        models: ['m1', 'm2', 'm3', 'm4', 'm5'],
      });

      const user = await renderAndOpenModelTab();

      // Act
      await user.click(screen.getByRole('button', { name: /run check/i }));

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/5 models available/i)).toBeInTheDocument();
      });
    });

    it('shows "0 models available" when the API returns an empty model list', async () => {
      // Regression: the API returning `{ ok: true, models: [] }` should
      // display "0 models available", not crash or hide the row.
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({ ok: true, models: [] });

      const user = await renderAndOpenModelTab();
      await user.click(screen.getByRole('button', { name: /run check/i }));

      await waitFor(() => {
        expect(screen.getByText(/0 models available/i)).toBeInTheDocument();
      });
    });

    it('shows a friendly failure when the API returns ok: false', async () => {
      // The provider route returns `{ ok: false }` (not an HTTP error) when
      // the SDK reports a soft failure. Agent-test-card must surface this
      // as a friendly message rather than reporting a phantom success.
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({ ok: false });

      const user = await renderAndOpenModelTab();
      await user.click(screen.getByRole('button', { name: /run check/i }));

      await waitFor(() => {
        expect(screen.getByText(/couldn't reach this provider/i)).toBeInTheDocument();
      });
    });

    it('shows friendly fallback on failure, never puts raw error in DOM', async () => {
      // Arrange — secret raw error text must never reach the DOM
      const SECRET = `RAW_SDK_LEAK_${Date.now()}`;
      const { apiClient, APIClientError } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockRejectedValue(
        new APIClientError(SECRET, 'PROVIDER_ERROR', 500)
      );

      const user = await renderAndOpenModelTab();

      // Act
      await user.click(screen.getByRole('button', { name: /run check/i }));

      // Assert: friendly message
      await waitFor(() => {
        expect(screen.getByText(/couldn't reach this provider/i)).toBeInTheDocument();
      });

      // Critical: raw error text must NOT be in DOM
      expect(document.body.textContent ?? '').not.toContain(SECRET);
    });

    it('shows "no config" message when provider has no stored record', async () => {
      // Arrange: providers prop is empty array so no match is found
      const user = userEvent.setup();
      render(<AgentForm mode="create" providers={[]} models={MODELS} />);
      await user.click(screen.getByRole('tab', { name: /model/i }));

      // Act: test connection - no providerId since providers prop is empty
      // The handler checks if providerId exists and sets an error message
      const testBtn = screen.getByRole('button', { name: /run check/i });
      await user.click(testBtn);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/no saved provider config/i)).toBeInTheDocument();
      });
    });
  });

  // ── Rate limit RPM ─────────────────────────────────────────────────────────

  describe('rate limit RPM', () => {
    it('renders rate limit RPM input with placeholder', async () => {
      await renderAndOpenModelTab();
      const input = screen.getByRole('spinbutton', { name: /rate limit/i });
      expect(input).toBeInTheDocument();
      expect(input).toHaveAttribute('placeholder', 'Use global default');
    });
  });

  // ── Guard mode and history token fields ───────────────────────────────────

  describe('guard mode and history token fields', () => {
    it('renders max history tokens input with placeholder', async () => {
      await renderAndOpenModelTab();
      const input = screen.getByRole('spinbutton', { name: /max history tokens/i });
      expect(input).toBeInTheDocument();
      expect(input).toHaveAttribute('placeholder', 'Use model default');
    });

    it('renders input guard mode select', async () => {
      await renderAndOpenModelTab();
      expect(screen.getByRole('combobox', { name: /input guard/i })).toBeInTheDocument();
    });

    it('renders output guard mode select defaulting to global default', async () => {
      await renderAndOpenModelTab();
      expect(screen.getByRole('combobox', { name: /output guard/i })).toBeInTheDocument();
    });
  });

  // ── Null hydration fallback ────────────────────────────────────────────────

  describe('null provider/model fallback', () => {
    it('shows warning banner when providers is null', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<AgentForm mode="create" providers={null} models={null} />);
      await user.click(screen.getByRole('tab', { name: /model/i }));

      // Assert: amber warning banner visible
      await waitFor(() => {
        expect(screen.getByText(/couldn't load the provider and model lists/i)).toBeInTheDocument();
      });
    });

    it('renders free-text input for provider when providers is null', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<AgentForm mode="create" providers={null} models={null} />);
      await user.click(screen.getByRole('tab', { name: /model/i }));

      // Assert: provider is a plain text input (no combobox)
      expect(screen.queryByRole('combobox', { name: /provider/i })).not.toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: /provider/i })).toBeInTheDocument();
    });

    it('renders free-text input for model when models is null', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<AgentForm mode="create" providers={null} models={null} />);
      await user.click(screen.getByRole('tab', { name: /model/i }));

      // Assert: model is a plain text input (no combobox)
      expect(screen.queryByRole('combobox', { name: /^model/i })).not.toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: /^model/i })).toBeInTheDocument();
    });
  });
});
