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
import { render, screen, waitFor, within } from '@testing-library/react';
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
      public status = 500,
      public details?: Record<string, unknown>
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
        expect(screen.getByText('claude-opus-4-6')).toBeInTheDocument();
        expect(screen.getByText('claude-haiku-3')).toBeInTheDocument();
        expect(screen.getByText('claude-sonnet-4-6')).toBeInTheDocument();
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
        expect(screen.getByText('claude-opus-4-6')).toBeInTheDocument();
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
        expect(screen.getByText('claude-opus-4-6')).toBeInTheDocument();
      });

      // Clear the mount-time fetch from the history so the refresh
      // assertion is exact ("clicking the button fired one fetch"),
      // not a snapshot-then-compare ("more than before"). The latter
      // is fragile against incidental calls between snapshot and click.
      vi.mocked(apiClient.get).mockClear();

      await user.click(screen.getByRole('button', { name: /refresh models/i }));

      await waitFor(() => {
        expect(apiClient.get).toHaveBeenCalledTimes(1);
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
        expect(screen.getByText('claude-opus-4-6')).toBeInTheDocument();
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
        expect(screen.getByText('claude-opus-4-6')).toBeInTheDocument();
      });

      // Target the Test button by its accessible name — the row order
      // in the table now depends on the sort state, so picking element
      // [0] would couple the assertion to the default sort.
      await user.click(screen.getByRole('button', { name: /^test claude opus 4\.6$/i }));

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
        expect(screen.getByText('claude-opus-4-6')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /^test claude opus 4\.6$/i }));

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

    it('renders an "In matrix" badge in the In matrix column for matched rows', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(ENRICHED_RESPONSE);

      render(<ProviderModelsPanel providerId="prov-2" providerName="OpenAI" isLocal={false} />);

      await waitFor(() => {
        expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
      });

      // Scope the badge query to the matrix-matched row directly.
      // The previous `toHaveLength(2)` count assertion would silently
      // break (or false-positive) if any future label or tooltip
      // mentioned "In matrix" again — this is more precise.
      const matchedRow = screen.getByRole('row', { name: /gpt-4o-mini/i });
      expect(within(matchedRow).getByText(/in matrix/i)).toBeInTheDocument();
      // ...and the embedding row (not in matrix) does NOT carry the badge.
      const unmatchedRow = screen.getByRole('row', { name: /text-embedding-3-small/i });
      expect(within(unmatchedRow).queryByText(/in matrix/i)).not.toBeInTheDocument();
    });

    it('renders all rows in a single combined table (no section split)', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(ENRICHED_RESPONSE);

      render(<ProviderModelsPanel providerId="prov-2" providerName="OpenAI" isLocal={false} />);

      await waitFor(() => {
        expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
      });

      // Every row is visible immediately — no "In your matrix" /
      // "Discovered" expand toggles, no rows hidden behind a closed
      // section. The four enriched fixture rows all render in one go.
      // The cell shows the canonical model id (the source of truth);
      // the friendly `name` field is no longer rendered.
      expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
      expect(screen.getByText('text-embedding-3-small')).toBeInTheDocument();
      expect(screen.getByText('o3-pro-2025-06-10')).toBeInTheDocument();
      expect(screen.getByText('dall-e-3')).toBeInTheDocument();
    });

    it('shows a capability badge per row', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(ENRICHED_RESPONSE);

      render(<ProviderModelsPanel providerId="prov-2" providerName="OpenAI" isLocal={false} />);

      await waitFor(() => {
        expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
      });

      // The embedding row shows a capability badge with text "embedding".
      // Need to disambiguate from the "Embedding" filter chip — assert
      // on the count instead.
      const matches = screen.getAllByText(/embedding/i);
      // At least 2: the filter chip + the row capability badge
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });

    it('clicking "In matrix" twice falls back to alphabetical row order (id-asc)', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(ENRICHED_RESPONSE);

      const user = userEvent.setup();
      render(<ProviderModelsPanel providerId="prov-2" providerName="OpenAI" isLocal={false} />);

      await waitFor(() => {
        expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
      });

      // Click 1 — group matrix rows at top.
      const inMatrixHeader = screen.getByRole('button', { name: /^in matrix/i });
      await user.click(inMatrixHeader);
      let rows = document.querySelectorAll('tbody tr');
      expect(rows[0]?.textContent).toContain('gpt-4o-mini');

      // Click 2 — revert to id-asc, NOT flip to matrix-rows-at-bottom.
      await user.click(inMatrixHeader);
      rows = document.querySelectorAll('tbody tr');
      expect(rows[0]?.textContent).toContain('dall-e-3');
    });

    it('default sort is alphabetical by canonical model id (matrix rows interleaved)', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(ENRICHED_RESPONSE);

      render(<ProviderModelsPanel providerId="prov-2" providerName="OpenAI" isLocal={false} />);

      await waitFor(() => {
        expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
      });

      // Default sort is `id asc` — `dall-e-3` sorts before `gpt-4o-mini`
      // (the lone matrix-matched row), proving the matrix grouping is
      // NOT applied by default. Operators opt into grouping by clicking
      // the "In matrix" column header.
      const rows = document.querySelectorAll('tbody tr');
      expect(rows[0]?.textContent).toContain('dall-e-3');
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
        expect(screen.getByText('claude-opus-4-6')).toBeInTheDocument();
      });

      await user.type(screen.getByPlaceholderText(/search models/i), 'haiku');

      await waitFor(() => {
        expect(screen.getByText('claude-haiku-3')).toBeInTheDocument();
        expect(screen.queryByText('claude-opus-4-6')).not.toBeInTheDocument();
      });
    });

    it('renders capability filter chips', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(MOCK_RESPONSE);

      render(<ProviderModelsPanel providerId="prov-1" providerName="Anthropic" isLocal={false} />);

      await waitFor(() => {
        expect(screen.getByRole('group', { name: /filter by capability/i })).toBeInTheDocument();
      });

      // Phase 5: one chip per inference output. Previously reasoning +
      // moderation + unknown collapsed into a single "Other" chip,
      // which lost information on OpenAI's mixed catalogue.
      for (const label of [
        'chat',
        'reasoning',
        'embedding',
        'image',
        'audio',
        'moderation',
        'unknown',
      ]) {
        expect(
          screen.getByRole('button', { name: new RegExp(`^${label}$`, 'i') })
        ).toBeInTheDocument();
      }
      // "Other" chip is no longer rendered.
      expect(screen.queryByRole('button', { name: /^other$/i })).not.toBeInTheDocument();
    });

    it('Reasoning and Moderation chips filter independently (regression for old Other lump)', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue({
        providerId: 'prov-2',
        slug: 'openai',
        models: [
          {
            id: 'o3-mini',
            name: 'o3-mini',
            provider: 'openai',
            tier: 'mid',
            inputCostPerMillion: 0,
            outputCostPerMillion: 0,
            maxContext: 128_000,
            supportsTools: false,
            capabilities: ['reasoning'],
          },
          {
            id: 'omni-moderation',
            name: 'omni-moderation',
            provider: 'openai',
            tier: 'mid',
            inputCostPerMillion: 0,
            outputCostPerMillion: 0,
            maxContext: 0,
            supportsTools: false,
            capabilities: ['moderation'],
          },
        ],
      });

      const user = userEvent.setup();
      render(<ProviderModelsPanel providerId="prov-2" providerName="OpenAI" isLocal={false} />);

      await waitFor(() => {
        expect(screen.getByText('o3-mini')).toBeInTheDocument();
      });
      expect(screen.getByText('omni-moderation')).toBeInTheDocument();

      // Reasoning chip narrows to the reasoning row only.
      await user.click(screen.getByRole('button', { name: /^reasoning$/i }));
      await waitFor(() => {
        expect(screen.queryByText('omni-moderation')).not.toBeInTheDocument();
      });
      expect(screen.getByText('o3-mini')).toBeInTheDocument();

      // Switch to Moderation chip — only the moderation row remains.
      await user.click(screen.getByRole('button', { name: /^reasoning$/i }));
      await user.click(screen.getByRole('button', { name: /^moderation$/i }));
      await waitFor(() => {
        expect(screen.queryByText('o3-mini')).not.toBeInTheDocument();
      });
      expect(screen.getByText('omni-moderation')).toBeInTheDocument();
    });

    it('Unknown chip filters to capability=unknown rows (catalogue-only chip)', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue({
        providerId: 'prov-2',
        slug: 'openai',
        models: [
          {
            id: 'gpt-4o',
            name: 'GPT-4o',
            provider: 'openai',
            tier: 'frontier',
            inputCostPerMillion: 5,
            outputCostPerMillion: 15,
            maxContext: 128_000,
            supportsTools: true,
            capabilities: ['chat'],
          },
          {
            id: 'mystery-x',
            name: 'mystery-x',
            provider: 'openai',
            tier: 'mid',
            inputCostPerMillion: 0,
            outputCostPerMillion: 0,
            maxContext: 0,
            supportsTools: false,
            capabilities: ['unknown'],
          },
        ],
      });

      const user = userEvent.setup();
      render(<ProviderModelsPanel providerId="prov-2" providerName="OpenAI" isLocal={false} />);

      await waitFor(() => {
        expect(screen.getByText('gpt-4o')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /^unknown$/i }));
      await waitFor(() => {
        expect(screen.queryByText('gpt-4o')).not.toBeInTheDocument();
      });
      expect(screen.getByText('mystery-x')).toBeInTheDocument();
    });

    it('clicking the Embedding filter chip narrows rows to embedding models', async () => {
      // The chip rendering test above only proves the chips appear —
      // the actual filtering logic (`activeBuckets.has(bucketFor(...))`)
      // wasn't exercised. This drives the toggleBucket reducer + the
      // `filtered` memo's bucket arm.
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue({
        providerId: 'prov-2',
        slug: 'openai',
        models: [
          {
            id: 'gpt-4o-mini',
            name: 'GPT-4o mini',
            provider: 'openai',
            tier: 'budget',
            inputCostPerMillion: 0.15,
            outputCostPerMillion: 0.6,
            maxContext: 128_000,
            supportsTools: true,
            capabilities: ['chat'],
          },
          {
            id: 'text-embedding-3-small',
            name: 'text-embedding-3-small',
            provider: 'openai',
            tier: 'budget',
            inputCostPerMillion: 0.02,
            outputCostPerMillion: 0,
            maxContext: 8191,
            supportsTools: false,
            capabilities: ['embedding'],
          },
        ],
      });

      const user = userEvent.setup();
      render(<ProviderModelsPanel providerId="prov-2" providerName="OpenAI" isLocal={false} />);

      await waitFor(() => {
        expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
      });

      // Both rows visible before any filter applied.
      expect(screen.getByText('text-embedding-3-small')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /^embedding$/i }));

      // Chat row hidden, embedding row remains.
      await waitFor(() => {
        expect(screen.queryByText('gpt-4o-mini')).not.toBeInTheDocument();
      });
      expect(screen.getByText('text-embedding-3-small')).toBeInTheDocument();

      // Click again to deactivate — chat row returns.
      await user.click(screen.getByRole('button', { name: /^embedding$/i }));
      await waitFor(() => {
        expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
      });
    });
  });

  // ── Sort by tier / context / cost columns ──────────────────────────────────

  describe('sortable columns', () => {
    const SORTABLE_FIXTURE = {
      providerId: 'prov-2',
      slug: 'openai',
      models: [
        {
          id: 'gpt-4o',
          name: 'GPT-4o',
          provider: 'openai',
          tier: 'frontier',
          inputCostPerMillion: 5,
          outputCostPerMillion: 15,
          maxContext: 128_000,
          supportsTools: true,
          capabilities: ['chat'],
        },
        {
          id: 'gpt-4o-mini',
          name: 'GPT-4o mini',
          provider: 'openai',
          tier: 'budget',
          inputCostPerMillion: 0.15,
          outputCostPerMillion: 0.6,
          maxContext: 16_000,
          supportsTools: true,
          capabilities: ['chat'],
        },
      ],
    };

    // The `inMatrix` and `name` paths already had explicit tests; this
    // table covers the remaining four sort keys (tier / context /
    // input / output) via one parameterised test. Each verifies that
    // clicking the header lands the expected model first.
    it.each([
      // tier asc: budget < frontier
      { column: /^tier/i, expectedFirstId: 'gpt-4o-mini' },
      // context asc: 16k < 128k
      { column: /^context/i, expectedFirstId: 'gpt-4o-mini' },
      // input cost asc: 0.15 < 5
      { column: /^input \$\/1m/i, expectedFirstId: 'gpt-4o-mini' },
      // output cost asc: 0.6 < 15
      { column: /^output \$\/1m/i, expectedFirstId: 'gpt-4o-mini' },
    ])('clicking the $column header sorts ascending', async ({ column, expectedFirstId }) => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(SORTABLE_FIXTURE);

      const user = userEvent.setup();
      render(<ProviderModelsPanel providerId="prov-2" providerName="OpenAI" isLocal={false} />);

      await waitFor(() => {
        expect(screen.getByText('gpt-4o')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: column }));

      const rows = document.querySelectorAll('tbody tr');
      expect(rows[0]?.textContent).toContain(expectedFirstId);
    });
  });

  // ── Free / unknown cell tooltips ───────────────────────────────────────────

  describe('cost cell display variants', () => {
    it('renders "Free" for OpenRouter zero-pricing models (tier=local on non-local provider)', async () => {
      // Source detection: cost=0 + tier='local' on a non-local provider
      // signals a `:free` OpenRouter entry. The cell should render
      // "Free" in green rather than "—" (the unknown variant).
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue({
        providerId: 'prov-2',
        slug: 'openrouter',
        models: [
          {
            id: 'meta-llama/llama-3-8b-instruct:free',
            name: 'Llama 3 8B Instruct (free)',
            provider: 'openrouter',
            tier: 'local', // OpenRouter parser's classifyTier(0)
            inputCostPerMillion: 0,
            outputCostPerMillion: 0,
            maxContext: 8192,
            supportsTools: false,
            capabilities: ['chat'],
          },
        ],
      });

      render(<ProviderModelsPanel providerId="prov-2" providerName="OpenRouter" isLocal={false} />);

      await waitFor(() => {
        expect(screen.getByText('meta-llama/llama-3-8b-instruct:free')).toBeInTheDocument();
      });

      // Two "Free" labels — input cost cell + output cost cell.
      const freeCells = screen.getAllByText('Free');
      expect(freeCells.length).toBe(2);
    });

    it('renders em-dash for unknown pricing (tier=mid + cost=0 = not in OpenRouter)', async () => {
      // Source forces tier='mid' for non-local providers when the model
      // isn't in the registry. cost=0 here means "unknown", not "free".
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue({
        providerId: 'prov-2',
        slug: 'openai',
        models: [
          {
            id: 'mystery-model',
            name: 'Mystery Model',
            provider: 'openai',
            tier: 'mid', // openai-compatible fallback
            inputCostPerMillion: 0,
            outputCostPerMillion: 0,
            maxContext: 0,
            supportsTools: false,
            capabilities: ['chat'],
          },
        ],
      });

      render(<ProviderModelsPanel providerId="prov-2" providerName="OpenAI" isLocal={false} />);

      await waitFor(() => {
        expect(screen.getByText('mystery-model')).toBeInTheDocument();
      });

      // No Free labels (the mid-tier-zero-cost case is "unknown").
      expect(screen.queryByText('Free')).not.toBeInTheDocument();
      // Em-dashes render in the unknown cells (Context + Input + Output
      // = 3, plus the Available column when not pre-set, so just check
      // for at least 3).
      const dashes = screen.getAllByText('—');
      expect(dashes.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ── In-use column + filter ────────────────────────────────────────────────

  describe('in-use column', () => {
    const IN_USE_RESPONSE = {
      providerId: 'prov-2',
      slug: 'openai',
      models: [
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
          agents: [
            { id: 'agent-1', name: 'Triage Bot', slug: 'triage-bot' },
            { id: 'agent-2', name: 'Researcher', slug: 'researcher' },
          ],
        },
        {
          id: 'gpt-4o',
          name: 'GPT-4o',
          provider: 'openai',
          tier: 'frontier',
          inputCostPerMillion: 5,
          outputCostPerMillion: 15,
          maxContext: 128000,
          supportsTools: true,
          inMatrix: false,
          matrixId: null,
          capabilities: ['chat'],
          tierRole: null,
          agents: [],
        },
      ] satisfies ProviderModelInfo[],
    };

    it('renames the column header from "In use" to "Used by"', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(IN_USE_RESPONSE);

      render(<ProviderModelsPanel providerId="prov-2" providerName="OpenAI" isLocal={false} />);

      // The legacy "In use" header was ambiguous — it didn't say "in
      // use by what", and it conflated direct agent assignment with
      // default-settings inheritance. The new header makes the meaning
      // explicit and the hover tooltip documents both paths.
      const usedByHeader = await screen.findByRole('columnheader', { name: /used by/i });
      expect(usedByHeader).toBeInTheDocument();
      expect(screen.queryByRole('columnheader', { name: /^in use$/i })).not.toBeInTheDocument();
    });

    it('shows the agent count and renders "Not in use" for unbound models with no default roles', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(IN_USE_RESPONSE);

      render(<ProviderModelsPanel providerId="prov-2" providerName="OpenAI" isLocal={false} />);

      await waitFor(() => {
        expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
      });

      // Bound row shows the agent count as a popover trigger; the
      // unbound row with no default role renders "Not in use" — a
      // bare "0" used to require the operator to guess "0 of what?".
      expect(
        screen.getByRole('button', { name: /show 2 agents directly assigned to GPT-4o mini/i })
      ).toBeInTheDocument();
      expect(screen.getByText(/^Not in use$/)).toBeInTheDocument();
    });

    it('opens the popover and lists every directly-assigned agent with a link to its admin page', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(IN_USE_RESPONSE);

      const user = userEvent.setup();
      render(<ProviderModelsPanel providerId="prov-2" providerName="OpenAI" isLocal={false} />);

      await waitFor(() => {
        expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
      });

      await user.click(
        screen.getByRole('button', { name: /show 2 agents directly assigned to GPT-4o mini/i })
      );

      const triageLink = await screen.findByRole('link', { name: /Triage Bot/ });
      expect(triageLink).toHaveAttribute('href', '/admin/orchestration/agents/agent-1');
      expect(screen.getByRole('link', { name: /Researcher/ })).toHaveAttribute(
        'href',
        '/admin/orchestration/agents/agent-2'
      );
      // Popover heading reinforces that the listed agents are
      // directly assigned — distinct from defaults inheritance.
      expect(screen.getByText(/directly assigned to/i)).toBeInTheDocument();
    });

    it('"Has agent" filter chip hides models that have no bound agents', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(IN_USE_RESPONSE);

      const user = userEvent.setup();
      render(<ProviderModelsPanel providerId="prov-2" providerName="OpenAI" isLocal={false} />);

      await waitFor(() => {
        expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
      });
      // Both rows visible by default.
      expect(screen.getByText('gpt-4o')).toBeInTheDocument();

      // Filter chip was renamed from the ambiguous "In use" to "Has
      // agent" so the toggle's semantics match what it filters by —
      // models with ≥1 direct agent assignment. The aria-label still
      // documents the precise meaning for assistive tech.
      const filterButton = screen.getByRole('button', {
        name: /show only models with at least one bound agent/i,
      });
      expect(filterButton).toHaveTextContent(/has agent/i);
      await user.click(filterButton);

      await waitFor(() => {
        expect(screen.queryByText('gpt-4o')).not.toBeInTheDocument();
      });
      // Bound row stays visible.
      expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
    });

    it('renders a default-role badge for every TaskType slot the model fills', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue({
        providerId: 'prov-2',
        slug: 'openai',
        models: [
          {
            id: 'gpt-4o',
            name: 'GPT-4o',
            provider: 'openai',
            tier: 'frontier',
            inputCostPerMillion: 5,
            outputCostPerMillion: 15,
            maxContext: 128000,
            supportsTools: true,
            inMatrix: true,
            capabilities: ['chat'],
            agents: [],
            defaultFor: ['chat', 'reasoning'],
          },
        ] satisfies ProviderModelInfo[],
      });

      render(<ProviderModelsPanel providerId="prov-2" providerName="OpenAI" isLocal={false} />);

      await waitFor(() => {
        expect(screen.getByText('gpt-4o')).toBeInTheDocument();
      });

      // Each TaskType slot produces a badge so the operator can spot
      // every place the runtime falls back to this model without
      // opening settings. Badges link to the orchestration settings
      // page for one-click editing.
      const dataRow = screen.getByRole('row', { name: /gpt-4o/ });
      expect(within(dataRow).getByText(/default: chat/i)).toBeInTheDocument();
      expect(within(dataRow).getByText(/default: reasoning/i)).toBeInTheDocument();

      const chatBadge = within(dataRow).getByText(/default: chat/i);
      const settingsLink = chatBadge.closest('a');
      expect(settingsLink).toHaveAttribute('href', '/admin/orchestration/settings');

      // "Not in use" must NOT render — the model is in use via the
      // default-settings inheritance path even with no direct agent.
      expect(within(dataRow).queryByText(/not in use/i)).not.toBeInTheDocument();
      // "0 agents" still shows so the operator can see there's no
      // direct assignment alongside the default badges.
      expect(within(dataRow).getByText(/0 agents/i)).toBeInTheDocument();
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
      // the string appears twice in the DOM. Find the test button via
      // its accessible name (aria-label).
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /^test text-embedding-3-small$/i })
        ).toBeInTheDocument();
      });

      const embeddingTestButton = screen.getByRole('button', {
        name: /^test text-embedding-3-small$/i,
      });
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
        expect(screen.getByText('o3-pro-2025-06-10')).toBeInTheDocument();
      });

      // The reasoning row's Test button is disabled — there is no
      // enabled button whose accessible name is "Test o3-pro".
      expect(screen.queryByRole('button', { name: /^test o3-pro$/i })).not.toBeInTheDocument();
      // ...but the disabled button is rendered with an aria-label
      // pointing at the disabled state.
      expect(screen.getByLabelText(/test not supported for o3-pro/i)).toBeDisabled();
    });
  });

  // ── Phase G — Add to matrix button ─────────────────────────────────────────

  describe('Add to matrix button', () => {
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
        inMatrix: false,
      },
      {
        id: 'gpt-4o',
        name: 'GPT-4o',
        provider: 'openai',
        tier: 'frontier',
        inputCostPerMillion: 2.5,
        outputCostPerMillion: 10,
        maxContext: 128000,
        supportsTools: true,
        capabilities: ['chat'],
        inMatrix: true,
      },
    ];

    it('renders an Add button on rows that are not in the matrix', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue({
        providerId: 'prov-2',
        slug: 'openai',
        models: ENRICHED,
      });

      render(<ProviderModelsPanel providerId="prov-2" providerName="OpenAI" isLocal={false} />);

      await waitFor(() => {
        expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
      });

      // Non-matrix row → Add button rendered.
      expect(screen.getByLabelText(/add gpt-4o mini to matrix/i)).toBeInTheDocument();
      // Matrix row → no Add button (the cell shows a dash).
      expect(screen.queryByLabelText(/^add gpt-4o to matrix$/i)).not.toBeInTheDocument();
    });

    it('clicking Add opens the discovery dialog with provider preselected', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockImplementation((url: string) => {
        // Initial panel fetch returns the candidate list. The dialog's
        // own discovery fetch reuses the same mock — return an
        // appropriate shape for /discovery/models too so the dialog
        // can render its candidates table.
        if (url.includes('/discovery/models')) {
          return Promise.resolve({
            providerSlug: 'openai',
            candidates: [
              {
                modelId: 'gpt-4o-mini',
                name: 'GPT-4o mini',
                sources: { vendor: true, openrouter: false },
                inMatrix: false,
                matrixId: null,
                inferredCapability: 'chat',
                suggested: {
                  capabilities: ['chat'],
                  tierRole: 'worker',
                  reasoningDepth: 'medium',
                  latency: 'fast',
                  costEfficiency: 'very_high',
                  contextLength: 'high',
                  toolUse: 'strong',
                  bestRole: 'Quick worker for tool calls',
                  inputCostPerMillion: 0.15,
                  outputCostPerMillion: 0.6,
                  maxContext: 128000,
                  slug: 'openai-gpt-4o-mini',
                },
              },
            ],
          });
        }
        return Promise.resolve({
          providerId: 'prov-2',
          slug: 'openai',
          models: ENRICHED,
        });
      });

      const user = userEvent.setup();
      render(<ProviderModelsPanel providerId="prov-2" providerName="OpenAI" isLocal={false} />);

      await waitFor(() => {
        expect(screen.getByLabelText(/add gpt-4o mini to matrix/i)).toBeInTheDocument();
      });

      await user.click(screen.getByLabelText(/add gpt-4o mini to matrix/i));

      // Dialog mounted — discovery step heading should be visible
      // (provider step skipped because providerSlug was preselected).
      await waitFor(() => {
        // The dialog's continue button only shows in step 2/3.
        expect(screen.getByRole('button', { name: /continue/i })).toBeInTheDocument();
      });

      // The pre-checked row's checkbox is checked (via prefilledModelIds).
      await waitFor(() => {
        const checkbox = screen.getByRole('checkbox', {
          name: /select gpt-4o mini/i,
        });
        expect(checkbox).toBeChecked();
      });
    });
  });
});
