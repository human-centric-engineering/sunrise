/**
 * ProviderModelsPanel Component Tests
 *
 * Test Coverage:
 * - Renders table from a model-list fixture (apiClient.get mock)
 * - "Refresh models" button calls apiClient.get again
 * - Loading skeleton during fetch; error banner on rejection
 * - isLocal=true hides "Input $/1M" and "Output $/1M" columns
 * - Per-model test button shows latency on success, "Failed" on error
 *
 * @see components/admin/orchestration/provider-models-panel.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ProviderModelsPanel } from '@/components/admin/orchestration/provider-models-panel';
import type { ProviderModelInfo } from '@/components/admin/orchestration/provider-models-panel';

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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_MODELS: ProviderModelInfo[] = [
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    provider: 'anthropic',
    tier: 'frontier',
    inputCostPerMillion: 15.0,
    outputCostPerMillion: 75.0,
    maxContext: 200000,
    supportsTools: true,
    available: true,
  },
  {
    id: 'claude-haiku-3',
    name: 'Claude Haiku 3',
    provider: 'anthropic',
    tier: 'budget',
    inputCostPerMillion: 0.25,
    outputCostPerMillion: 1.25,
    maxContext: 200000,
    supportsTools: true,
    available: true,
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    tier: 'standard',
    inputCostPerMillion: 3.0,
    outputCostPerMillion: 15.0,
    maxContext: 200000,
    supportsTools: true,
    available: undefined,
  },
];

const MOCK_RESPONSE = {
  providerId: 'prov-1',
  slug: 'anthropic',
  models: MOCK_MODELS,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ProviderModelsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Rendering ──────────────────────────────────────────────────────────────

  describe('rendering with data', () => {
    it('renders model names from fixture', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(MOCK_RESPONSE);

      render(<ProviderModelsPanel providerId="prov-1" providerName="Anthropic" isLocal={false} />);

      await waitFor(() => {
        expect(screen.getByText('Claude Opus 4.6')).toBeInTheDocument();
        expect(screen.getByText('Claude Haiku 3')).toBeInTheDocument();
        expect(screen.getByText('Claude Sonnet 4.6')).toBeInTheDocument();
      });
    });

    it('renders model IDs in monospace', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(MOCK_RESPONSE);

      render(<ProviderModelsPanel providerId="prov-1" providerName="Anthropic" isLocal={false} />);

      await waitFor(() => {
        expect(screen.getByText('claude-opus-4-6')).toBeInTheDocument();
      });
    });

    it('renders pricing columns for non-local provider', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(MOCK_RESPONSE);

      render(<ProviderModelsPanel providerId="prov-1" providerName="Anthropic" isLocal={false} />);

      await waitFor(() => {
        expect(screen.getByText('Input $/1M')).toBeInTheDocument();
        expect(screen.getByText('Output $/1M')).toBeInTheDocument();
      });
    });

    it('renders the provider name heading', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(MOCK_RESPONSE);

      render(<ProviderModelsPanel providerId="prov-1" providerName="Anthropic" isLocal={false} />);

      expect(screen.getByText('Anthropic')).toBeInTheDocument();
    });
  });

  // ── isLocal column hiding ──────────────────────────────────────────────────

  describe('isLocal=true hides pricing columns', () => {
    it('does NOT render Input $/1M and Output $/1M for local provider', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue({
        ...MOCK_RESPONSE,
        slug: 'ollama',
      });

      render(<ProviderModelsPanel providerId="prov-3" providerName="Ollama" isLocal={true} />);

      await waitFor(() => {
        expect(screen.getByText('Claude Opus 4.6')).toBeInTheDocument();
      });

      expect(screen.queryByText('Input $/1M')).not.toBeInTheDocument();
      expect(screen.queryByText('Output $/1M')).not.toBeInTheDocument();
    });

    it('renders "Local provider — pricing not applicable" description for local', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(MOCK_RESPONSE);

      render(<ProviderModelsPanel providerId="prov-3" providerName="Ollama" isLocal={true} />);

      expect(screen.getByText(/local provider — pricing not applicable/i)).toBeInTheDocument();
    });
  });

  // ── Refresh button ─────────────────────────────────────────────────────────

  describe('refresh button', () => {
    it('"Refresh models" button calls apiClient.get again', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(MOCK_RESPONSE);

      const user = userEvent.setup();
      render(<ProviderModelsPanel providerId="prov-1" providerName="Anthropic" isLocal={false} />);

      await waitFor(() => {
        expect(screen.getByText('Claude Opus 4.6')).toBeInTheDocument();
      });

      const initialCallCount = (apiClient.get as ReturnType<typeof vi.fn>).mock.calls.length;

      await user.click(screen.getByRole('button', { name: /refresh models/i }));

      await waitFor(() => {
        const calls = (apiClient.get as ReturnType<typeof vi.fn>).mock.calls.length;
        expect(calls).toBeGreaterThan(initialCallCount);
      });
    });
  });

  // ── Loading state ──────────────────────────────────────────────────────────

  describe('loading state', () => {
    it('shows "Loading models…" during initial fetch', async () => {
      const { apiClient } = await import('@/lib/api/client');
      // Never resolves — stays loading
      vi.mocked(apiClient.get).mockReturnValue(new Promise(() => {}));

      render(<ProviderModelsPanel providerId="prov-1" providerName="Anthropic" isLocal={false} />);

      expect(screen.getByText(/loading models/i)).toBeInTheDocument();
    });
  });

  // ── Error state ────────────────────────────────────────────────────────────

  describe('error state', () => {
    it('shows error banner when fetch rejects', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockRejectedValue(new Error('Network error'));

      render(<ProviderModelsPanel providerId="prov-1" providerName="Anthropic" isLocal={false} />);

      await waitFor(() => {
        expect(screen.getByText(/couldn't load models/i)).toBeInTheDocument();
      });
    });
  });

  // ── apiKeyPresent=false ───────────────────────────────────────────────────

  describe('apiKeyPresent=false', () => {
    it('does not fetch models and shows "No API key" message', async () => {
      const { apiClient } = await import('@/lib/api/client');

      render(
        <ProviderModelsPanel
          providerId="prov-1"
          providerName="Anthropic"
          isLocal={false}
          apiKeyPresent={false}
        />
      );

      expect(screen.getByText(/no api key configured/i)).toBeInTheDocument();
      expect(apiClient.get).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('does not render the Refresh button', () => {
      render(
        <ProviderModelsPanel
          providerId="prov-1"
          providerName="Anthropic"
          isLocal={false}
          apiKeyPresent={false}
        />
      );

      expect(screen.queryByRole('button', { name: /refresh models/i })).not.toBeInTheDocument();
    });
  });

  // ── Local provider with apiKeyPresent=false ────────────────────────────────

  describe('local provider with apiKeyPresent=false', () => {
    it('fetches models even without an API key', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(MOCK_RESPONSE);

      render(
        <ProviderModelsPanel
          providerId="prov-3"
          providerName="Ollama"
          isLocal={true}
          apiKeyPresent={false}
        />
      );

      await waitFor(() => {
        expect(apiClient.get).toHaveBeenCalled();
        expect(screen.getByText('Claude Opus 4.6')).toBeInTheDocument();
      });
    });

    it('does NOT show "No API key configured" message', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(MOCK_RESPONSE);

      render(
        <ProviderModelsPanel
          providerId="prov-3"
          providerName="Ollama"
          isLocal={true}
          apiKeyPresent={false}
        />
      );

      expect(screen.queryByText(/no api key configured/i)).not.toBeInTheDocument();
    });

    it('renders the Refresh button', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(MOCK_RESPONSE);

      render(
        <ProviderModelsPanel
          providerId="prov-3"
          providerName="Ollama"
          isLocal={true}
          apiKeyPresent={false}
        />
      );

      expect(screen.getByRole('button', { name: /refresh models/i })).toBeInTheDocument();
    });
  });

  // ── Per-model test button ─────────────────────────────────────────────────

  describe('per-model test button', () => {
    it('renders a Test header column', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(MOCK_RESPONSE);

      render(<ProviderModelsPanel providerId="prov-1" providerName="Anthropic" isLocal={false} />);

      await waitFor(() => {
        expect(screen.getByText('Test')).toBeInTheDocument();
      });
    });

    it('clicking test button posts to test-model endpoint and shows latency', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(MOCK_RESPONSE);
      vi.mocked(apiClient.post).mockResolvedValue({
        ok: true,
        latencyMs: 320,
        model: 'claude-opus-4-6',
      });

      const user = userEvent.setup();
      render(<ProviderModelsPanel providerId="prov-1" providerName="Anthropic" isLocal={false} />);

      await waitFor(() => {
        expect(screen.getByText('Claude Opus 4.6')).toBeInTheDocument();
      });

      // Find the play button (test) for the first model
      const testButtons = screen.getAllByTitle(/test/i);
      await user.click(testButtons[0]);

      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          expect.stringContaining('/providers/prov-1/test-model'),
          expect.objectContaining({
            body: expect.objectContaining({ model: 'claude-opus-4-6' }),
          })
        );
      });

      await waitFor(() => {
        expect(screen.getByText('320 ms')).toBeInTheDocument();
      });
    });

    it('shows friendly error text when test-model request fails', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(MOCK_RESPONSE);
      vi.mocked(apiClient.post).mockRejectedValue(new Error('Connection refused'));

      const user = userEvent.setup();
      render(<ProviderModelsPanel providerId="prov-1" providerName="Anthropic" isLocal={false} />);

      await waitFor(() => {
        expect(screen.getByText('Claude Opus 4.6')).toBeInTheDocument();
      });

      const testButtons = screen.getAllByTitle(/test/i);
      await user.click(testButtons[0]);

      await waitFor(() => {
        expect(screen.getByText(/didn.t respond/i)).toBeInTheDocument();
      });
    });
  });

  // ── Phase A/C — Matrix annotation + sectioning ─────────────────────────────

  describe('matrix annotation and sectioning', () => {
    const ENRICHED_MODELS: ProviderModelInfo[] = [
      {
        id: 'gpt-4o-mini',
        name: 'GPT-4o mini',
        provider: 'openai',
        tier: 'worker',
        inputCostPerMillion: 0.15,
        outputCostPerMillion: 0.6,
        maxContext: 128000,
        supportsTools: true,
        inMatrix: true,
        matrixId: 'matrix-1',
        capabilities: ['chat'],
        tierRole: 'worker',
      },
      {
        id: 'text-embedding-3-small',
        name: 'text-embedding-3-small',
        provider: 'openai',
        tier: 'embedding',
        inputCostPerMillion: 0.02,
        outputCostPerMillion: 0,
        maxContext: 8191,
        supportsTools: false,
        inMatrix: false,
        matrixId: null,
        capabilities: ['embedding'],
        tierRole: null,
      },
      {
        id: 'o3-pro-2025-06-10',
        name: 'o3-pro',
        provider: 'openai',
        tier: 'frontier',
        inputCostPerMillion: 0,
        outputCostPerMillion: 0,
        maxContext: 200000,
        supportsTools: false,
        inMatrix: false,
        matrixId: null,
        capabilities: ['reasoning'],
        tierRole: null,
      },
      {
        id: 'dall-e-3',
        name: 'DALL-E 3',
        provider: 'openai',
        tier: 'frontier',
        inputCostPerMillion: 0,
        outputCostPerMillion: 0,
        maxContext: 0,
        supportsTools: false,
        inMatrix: false,
        matrixId: null,
        capabilities: ['image'],
        tierRole: null,
      },
    ];

    const ENRICHED_RESPONSE = {
      providerId: 'prov-2',
      slug: 'openai',
      models: ENRICHED_MODELS,
    };

    it('renders an "In matrix" badge on rows that have a matrix match', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(ENRICHED_RESPONSE);

      render(<ProviderModelsPanel providerId="prov-2" providerName="OpenAI" isLocal={false} />);

      await waitFor(() => {
        expect(screen.getByText('GPT-4o mini')).toBeInTheDocument();
      });

      // Only one matrix-matched row in the fixture, so there should
      // be exactly one "In matrix" badge.
      expect(screen.getAllByText(/in matrix/i)).toHaveLength(1);
    });

    it('splits rows into "In your matrix" and "Discovered" sections', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(ENRICHED_RESPONSE);

      render(<ProviderModelsPanel providerId="prov-2" providerName="OpenAI" isLocal={false} />);

      await waitFor(() => {
        expect(screen.getByText(/in your matrix/i)).toBeInTheDocument();
        expect(screen.getByText(/^discovered$/i)).toBeInTheDocument();
      });
    });

    it('shows a capability badge per row', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(ENRICHED_RESPONSE);

      const user = userEvent.setup();
      render(<ProviderModelsPanel providerId="prov-2" providerName="OpenAI" isLocal={false} />);

      await waitFor(() => {
        expect(screen.getByText(/^discovered$/i)).toBeInTheDocument();
      });

      // Discovered defaults closed when matrix has matches — open it
      // so the embedding/reasoning/image rows render.
      await user.click(screen.getByRole('button', { name: /discovered/i }));

      // The embedding row shows a capability badge with text "embedding".
      // Need to disambiguate from the "Embedding" filter chip — assert
      // on the badge's container in the row.
      await waitFor(() => {
        const matches = screen.getAllByText(/embedding/i);
        // At least 2: the filter chip + the row capability badge
        expect(matches.length).toBeGreaterThanOrEqual(2);
      });
    });
  });

  // ── Phase C — Search and filter ────────────────────────────────────────────

  describe('search and filter', () => {
    it('search input filters rows by id substring', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(MOCK_RESPONSE);

      const user = userEvent.setup();
      render(<ProviderModelsPanel providerId="prov-1" providerName="Anthropic" isLocal={false} />);

      await waitFor(() => {
        expect(screen.getByText('Claude Opus 4.6')).toBeInTheDocument();
      });

      await user.type(screen.getByPlaceholderText(/search models/i), 'haiku');

      await waitFor(() => {
        expect(screen.getByText('Claude Haiku 3')).toBeInTheDocument();
        expect(screen.queryByText('Claude Opus 4.6')).not.toBeInTheDocument();
      });
    });

    it('renders capability filter chips', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(MOCK_RESPONSE);

      render(<ProviderModelsPanel providerId="prov-1" providerName="Anthropic" isLocal={false} />);

      await waitFor(() => {
        expect(screen.getByRole('group', { name: /filter by capability/i })).toBeInTheDocument();
      });

      // Chat / Embedding / Image / Audio / Other
      expect(screen.getByRole('button', { name: /^chat$/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^embedding$/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^image$/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^audio$/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^other$/i })).toBeInTheDocument();
    });
  });

  // ── Phase B/C — Capability-aware Test button ──────────────────────────────

  describe('capability-aware Test button', () => {
    const ENRICHED: ProviderModelInfo[] = [
      {
        id: 'gpt-4o-mini',
        name: 'GPT-4o mini',
        provider: 'openai',
        tier: 'worker',
        inputCostPerMillion: 0.15,
        outputCostPerMillion: 0.6,
        maxContext: 128000,
        supportsTools: true,
        capabilities: ['chat'],
      },
      {
        id: 'text-embedding-3-small',
        name: 'text-embedding-3-small',
        provider: 'openai',
        tier: 'embedding',
        inputCostPerMillion: 0.02,
        outputCostPerMillion: 0,
        maxContext: 8191,
        supportsTools: false,
        capabilities: ['embedding'],
      },
      {
        id: 'o3-pro-2025-06-10',
        name: 'o3-pro',
        provider: 'openai',
        tier: 'frontier',
        inputCostPerMillion: 0,
        outputCostPerMillion: 0,
        maxContext: 200000,
        supportsTools: false,
        capabilities: ['reasoning'],
      },
    ];

    it('passes capability in the request body', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue({
        providerId: 'prov-2',
        slug: 'openai',
        models: ENRICHED,
      });
      vi.mocked(apiClient.post).mockResolvedValue({
        ok: true,
        latencyMs: 100,
        model: 'text-embedding-3-small',
      });

      const user = userEvent.setup();
      render(<ProviderModelsPanel providerId="prov-2" providerName="OpenAI" isLocal={false} />);

      // Both the model name and id are "text-embedding-3-small", so
      // the string appears twice in the DOM. Wait on the title-cased
      // header instead, then look up the test button by its title.
      await waitFor(() => {
        expect(screen.getByTitle(/test text-embedding-3-small/i)).toBeInTheDocument();
      });

      const embeddingTestButton = screen.getByTitle(/test text-embedding-3-small/i);
      await user.click(embeddingTestButton);

      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          expect.stringContaining('/test-model'),
          expect.objectContaining({
            body: expect.objectContaining({
              model: 'text-embedding-3-small',
              capability: 'embedding',
            }),
          })
        );
      });
    });

    it('disables Test on reasoning / image / audio rows', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue({
        providerId: 'prov-2',
        slug: 'openai',
        models: ENRICHED,
      });

      render(<ProviderModelsPanel providerId="prov-2" providerName="OpenAI" isLocal={false} />);

      await waitFor(() => {
        expect(screen.getByText('o3-pro')).toBeInTheDocument();
      });

      // The reasoning row's Test button is disabled — there is no
      // matching enabled "Test o3-pro" handler.
      expect(screen.queryByTitle(/test o3-pro/i)).not.toBeInTheDocument();
      // ...but the disabled button is rendered with an aria-label
      // pointing at the disabled state.
      expect(screen.getByLabelText(/test not supported for o3-pro/i)).toBeDisabled();
    });
  });
});
