/**
 * CompareProvidersModal Component Tests
 *
 * @see components/admin/orchestration/knowledge/compare-providers-modal.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CompareProvidersModal } from '@/components/admin/orchestration/knowledge/compare-providers-modal';
import type { EmbeddingModelInfo } from '@/lib/orchestration/llm/embedding-models';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const makeModel = (overrides: Partial<EmbeddingModelInfo> = {}): EmbeddingModelInfo => ({
  id: 'voyage/voyage-3',
  name: 'Voyage 3',
  provider: 'Voyage AI',
  model: 'voyage-3',
  dimensions: 1024,
  schemaCompatible: true,
  costPerMillionTokens: 0.06,
  hasFreeTier: true,
  local: false,
  quality: 'high',
  strengths: 'Top-tier retrieval quality',
  setup: 'Sign up at voyageai.com',
  ...overrides,
});

const MOCK_MODELS: EmbeddingModelInfo[] = [
  makeModel(),
  makeModel({
    id: 'openai/text-embedding-3-small',
    name: 'text-embedding-3-small',
    provider: 'OpenAI',
    model: 'text-embedding-3-small',
    dimensions: 1536,
    schemaCompatible: true,
    costPerMillionTokens: 0.02,
    hasFreeTier: false,
    quality: 'medium',
    strengths: 'Low cost; native 1 536 dimensions',
    setup: 'OpenAI API key required',
  }),
];

const makeOkResponse = (data: EmbeddingModelInfo[] = MOCK_MODELS) => ({
  ok: true,
  json: () => Promise.resolve({ data }),
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CompareProvidersModal', () => {
  const onOpenChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 1. Does not fetch when open=false; fetches when open=true
  describe('fetch behaviour based on open prop', () => {
    it('does not fetch when open is false', () => {
      render(<CompareProvidersModal open={false} onOpenChange={onOpenChange} />);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('fetches embedding models when open is true', async () => {
      mockFetch.mockResolvedValue(makeOkResponse());

      render(<CompareProvidersModal open={true} onOpenChange={onOpenChange} />);

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('/api/v1/admin/orchestration/embedding-models')
        );
      });
    });
  });

  // 2. Fetch URL includes query params when filters are active
  describe('filter query params', () => {
    it('appends schemaCompatibleOnly=true when that filter is toggled', async () => {
      const user = userEvent.setup();
      mockFetch.mockResolvedValue(makeOkResponse());

      render(<CompareProvidersModal open={true} onOpenChange={onOpenChange} />);

      // Wait for initial fetch and table to render
      await waitFor(() => expect(screen.getByText('Voyage AI')).toBeInTheDocument());

      // Toggle the schema-compatible filter
      await user.click(screen.getByRole('button', { name: /schema-compatible only/i }));

      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
      const [url] = mockFetch.mock.calls[1] as [string];
      expect(url).toContain('schemaCompatibleOnly=true');
    });

    it('appends hasFreeTier=true when free tier filter is toggled', async () => {
      const user = userEvent.setup();
      mockFetch.mockResolvedValue(makeOkResponse());

      render(<CompareProvidersModal open={true} onOpenChange={onOpenChange} />);

      await waitFor(() => expect(screen.getByText('Voyage AI')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /free tier/i }));

      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
      const [url] = mockFetch.mock.calls[1] as [string];
      expect(url).toContain('hasFreeTier=true');
    });

    it('appends local=true when local only filter is toggled', async () => {
      const user = userEvent.setup();
      mockFetch.mockResolvedValue(makeOkResponse());

      render(<CompareProvidersModal open={true} onOpenChange={onOpenChange} />);

      await waitFor(() => expect(screen.getByText('Voyage AI')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /local only/i }));

      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
      const [url] = mockFetch.mock.calls[1] as [string];
      expect(url).toContain('local=true');
    });
  });

  // 3. Renders a row per returned model with correct data formatting
  describe('model row rendering', () => {
    it('renders provider and model name for each returned model', async () => {
      mockFetch.mockResolvedValue(makeOkResponse());

      render(<CompareProvidersModal open={true} onOpenChange={onOpenChange} />);

      await waitFor(() => {
        expect(screen.getByText('Voyage AI')).toBeInTheDocument();
        expect(screen.getByText('voyage-3')).toBeInTheDocument();
        expect(screen.getByText('OpenAI')).toBeInTheDocument();
        expect(screen.getByText('text-embedding-3-small')).toBeInTheDocument();
      });
    });

    it('renders "Free" for cost when costPerMillionTokens is 0', async () => {
      const freeModel = makeModel({
        id: 'ollama/nomic',
        costPerMillionTokens: 0,
        provider: 'Ollama',
        model: 'nomic-embed-text',
      });
      mockFetch.mockResolvedValue(makeOkResponse([freeModel]));

      render(<CompareProvidersModal open={true} onOpenChange={onOpenChange} />);

      await waitFor(() => {
        expect(screen.getByText('Free')).toBeInTheDocument();
      });
    });

    it('renders cost with 2 decimal places when costPerMillionTokens >= 0.1', async () => {
      const costModel = makeModel({
        id: 'openai/large',
        costPerMillionTokens: 0.13,
        provider: 'OpenAI',
        model: 'text-embedding-3-large',
      });
      mockFetch.mockResolvedValue(makeOkResponse([costModel]));

      render(<CompareProvidersModal open={true} onOpenChange={onOpenChange} />);

      await waitFor(() => {
        expect(screen.getByText('$0.13')).toBeInTheDocument();
      });
    });

    it('renders cost with 3 decimal places when costPerMillionTokens < 0.1 and > 0', async () => {
      const smallCostModel = makeModel({ costPerMillionTokens: 0.06 });
      mockFetch.mockResolvedValue(makeOkResponse([smallCostModel]));

      render(<CompareProvidersModal open={true} onOpenChange={onOpenChange} />);

      await waitFor(() => {
        expect(screen.getByText('$0.060')).toBeInTheDocument();
      });
    });
  });

  // 4. Empty state
  describe('empty state', () => {
    it('shows "No models match the current filters" when API returns empty array', async () => {
      mockFetch.mockResolvedValue(makeOkResponse([]));

      render(<CompareProvidersModal open={true} onOpenChange={onOpenChange} />);

      await waitFor(() => {
        expect(screen.getByText(/no models match the current filters/i)).toBeInTheDocument();
      });
    });
  });

  // 5. Filter toggle flips active state and refetches
  describe('filter toggle behaviour', () => {
    it('toggling schema-compatible filter enables it, then toggling again removes the param', async () => {
      const user = userEvent.setup();
      mockFetch.mockResolvedValue(makeOkResponse());

      render(<CompareProvidersModal open={true} onOpenChange={onOpenChange} />);

      await waitFor(() => expect(screen.getByText('Voyage AI')).toBeInTheDocument());

      // Enable filter
      await user.click(screen.getByRole('button', { name: /schema-compatible only/i }));
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

      const [enabledUrl] = mockFetch.mock.calls[1] as [string];
      expect(enabledUrl).toContain('schemaCompatibleOnly=true');

      // Disable filter (toggle off)
      await user.click(screen.getByRole('button', { name: /schema-compatible only/i }));
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));

      const [disabledUrl] = mockFetch.mock.calls[2] as [string];
      expect(disabledUrl).not.toContain('schemaCompatibleOnly');
    });
  });

  // 6. Sort direction cycling
  describe('sort header behaviour', () => {
    it('clicking same sort header twice cycles direction asc -> desc', async () => {
      const user = userEvent.setup();
      mockFetch.mockResolvedValue(makeOkResponse());

      render(<CompareProvidersModal open={true} onOpenChange={onOpenChange} />);

      await waitFor(() => {
        expect(screen.getByText('Voyage AI')).toBeInTheDocument();
      });

      // Default sort is provider asc — click provider again to flip to desc
      const providerBtn = screen.getByRole('button', { name: /provider/i });
      await user.click(providerBtn);

      // After clicking same header, desc arrow should appear
      expect(screen.getByText('↓')).toBeInTheDocument();
    });

    it('clicking a different sort header resets direction to asc', async () => {
      const user = userEvent.setup();
      mockFetch.mockResolvedValue(makeOkResponse());

      render(<CompareProvidersModal open={true} onOpenChange={onOpenChange} />);

      await waitFor(() => {
        expect(screen.getByText('Voyage AI')).toBeInTheDocument();
      });

      // Click provider to flip to desc (it is already the active field, starts asc)
      const providerBtn = screen.getByRole('button', { name: /provider/i });
      await user.click(providerBtn);
      expect(screen.getByText('↓')).toBeInTheDocument();

      // Click a different header (Cost/1M) — should reset to asc
      const costBtn = screen.getByRole('button', { name: /cost\/1m/i });
      await user.click(costBtn);
      expect(screen.getByText('↑')).toBeInTheDocument();
    });
  });

  // 7. QualityBadge variants
  describe('QualityBadge', () => {
    it('renders "High" badge for quality: high', async () => {
      const highModel = makeModel({ quality: 'high' });
      mockFetch.mockResolvedValue(makeOkResponse([highModel]));

      render(<CompareProvidersModal open={true} onOpenChange={onOpenChange} />);

      await waitFor(() => {
        expect(screen.getByText('High')).toBeInTheDocument();
      });
    });

    it('renders "Medium" badge for quality: medium', async () => {
      const mediumModel = makeModel({
        id: 'openai/small',
        provider: 'OpenAI',
        model: 'small',
        quality: 'medium',
      });
      mockFetch.mockResolvedValue(makeOkResponse([mediumModel]));

      render(<CompareProvidersModal open={true} onOpenChange={onOpenChange} />);

      await waitFor(() => {
        expect(screen.getByText('Medium')).toBeInTheDocument();
      });
    });

    it('renders "Budget" badge for quality: budget', async () => {
      const budgetModel = makeModel({
        id: 'local/cheap',
        provider: 'Local',
        model: 'cheap',
        quality: 'budget',
      });
      mockFetch.mockResolvedValue(makeOkResponse([budgetModel]));

      render(<CompareProvidersModal open={true} onOpenChange={onOpenChange} />);

      await waitFor(() => {
        expect(screen.getByText('Budget')).toBeInTheDocument();
      });
    });
  });

  // Sort by dimensions
  describe('sort by dimensions', () => {
    it('sorts rows by dimensions when Dims header is clicked', async () => {
      const user = userEvent.setup();
      const smallDims = makeModel({
        id: 'a/small',
        provider: 'AAA',
        model: 'small',
        dimensions: 512,
      });
      const largeDims = makeModel({
        id: 'b/large',
        provider: 'BBB',
        model: 'large',
        dimensions: 4096,
      });
      mockFetch.mockResolvedValue(makeOkResponse([largeDims, smallDims]));

      render(<CompareProvidersModal open={true} onOpenChange={onOpenChange} />);

      await waitFor(() => expect(screen.getByText('AAA')).toBeInTheDocument());

      // Click Dims sort header
      const dimsBtn = screen.getByRole('button', { name: /dims/i });
      await user.click(dimsBtn);

      // Dims direction indicator should appear
      expect(screen.getByText('↑')).toBeInTheDocument();
    });
  });

  // Close button
  describe('close button', () => {
    it('calls onOpenChange(false) when Close button is clicked', async () => {
      mockFetch.mockResolvedValue(makeOkResponse([]));

      render(<CompareProvidersModal open={true} onOpenChange={onOpenChange} />);

      await waitFor(() => expect(screen.queryByText('Loading models…')).not.toBeInTheDocument());

      // Two "Close" buttons exist: the Radix X icon and our explicit Close button.
      // Click the one whose text content is exactly "Close".
      const closeButtons = screen.getAllByRole('button', { name: 'Close' });
      const explicitClose = closeButtons.find((btn) => btn.textContent === 'Close');
      await userEvent.setup().click(explicitClose!);

      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  // 8. Loading state
  describe('loading state', () => {
    it('shows "Loading models…" while fetch is in flight', async () => {
      let resolveResponse!: (value: {
        ok: boolean;
        json: () => Promise<{ data: EmbeddingModelInfo[] }>;
      }) => void;
      const pendingResponse = new Promise<{
        ok: boolean;
        json: () => Promise<{ data: EmbeddingModelInfo[] }>;
      }>((resolve) => {
        resolveResponse = resolve;
      });
      mockFetch.mockReturnValue(pendingResponse);

      render(<CompareProvidersModal open={true} onOpenChange={onOpenChange} />);

      expect(screen.getByText('Loading models…')).toBeInTheDocument();

      // Resolve so the component can finish without leaking timers
      resolveResponse({ ok: true, json: () => Promise.resolve({ data: [] }) });

      await waitFor(() => {
        expect(screen.queryByText('Loading models…')).not.toBeInTheDocument();
      });
    });
  });
});
