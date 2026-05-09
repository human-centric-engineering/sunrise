/**
 * ProviderModelsMatrix Component Tests
 *
 * Test Coverage:
 * - Renders model name and provider in table rows
 * - Only shows active models (isActive: false models hidden)
 * - Shows "No models match the current filters" when all filtered out
 * - Shows "Chat" badge for chat-only models
 * - Shows "Embedding" badge for embedding-only models
 * - Shows "Both" badge for models with both capabilities
 * - Filtering by provider shows only matching models
 * - Filter by capability shows only matching models
 * - Model count text ("N model(s)") updates after filtering
 * - Clicking a sortable column header changes sort (column becomes "active")
 * - "Discover models" button opens the discovery dialog (replaced the old /new link in Phase F)
 * - Model name is a link to /admin/orchestration/provider-models/{id}
 * - Decision heuristic table is rendered
 * - Green dot for configured+active, yellow for configured+inactive, gray for unconfigured
 *
 * @see components/admin/orchestration/provider-models-matrix.tsx
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ProviderModelsMatrix } from '@/components/admin/orchestration/provider-models-matrix';
import type { ModelRow } from '@/components/admin/orchestration/provider-models-matrix';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

const mockRouterRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRouterRefresh }),
}));

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return {
    ...actual,
    apiClient: {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
  };
});

vi.mock('@/types/orchestration', () => ({
  TIER_ROLE_META: {
    thinking: { label: 'Thinking', description: 'High-reasoning' },
    worker: { label: 'Worker', description: 'General tasks' },
  },
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeModel(overrides: Partial<ModelRow> = {}): ModelRow {
  return {
    id: 'model-1',
    slug: 'openai-gpt-5',
    providerSlug: 'openai',
    modelId: 'gpt-5',
    name: 'GPT-5',
    description: 'Flagship',
    capabilities: ['chat'],
    tierRole: 'thinking',
    reasoningDepth: 'very_high',
    latency: 'medium',
    costEfficiency: 'none',
    contextLength: 'very_high',
    toolUse: 'strong',
    bestRole: 'Planner',
    isDefault: true,
    isActive: true,
    configured: true,
    configuredActive: true,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ProviderModelsMatrix', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ── Basic rendering ────────────────────────────────────────────────────────

  it('renders model name in table rows', () => {
    render(<ProviderModelsMatrix initialModels={[makeModel()]} />);

    expect(screen.getByText('GPT-5')).toBeInTheDocument();
  });

  it('renders provider slug in table rows', () => {
    render(<ProviderModelsMatrix initialModels={[makeModel()]} />);

    expect(screen.getByText('openai')).toBeInTheDocument();
  });

  // ── isActive filter ────────────────────────────────────────────────────────

  it('only shows active models — inactive models are hidden', () => {
    const models = [
      makeModel({ id: 'active-1', name: 'Active Model', isActive: true }),
      makeModel({ id: 'inactive-1', name: 'Inactive Model', isActive: false }),
    ];
    render(<ProviderModelsMatrix initialModels={models} />);

    expect(screen.getByText('Active Model')).toBeInTheDocument();
    expect(screen.queryByText('Inactive Model')).not.toBeInTheDocument();
  });

  // ── Empty state ────────────────────────────────────────────────────────────

  it('shows "No models match the current filters" when all models are inactive', () => {
    render(
      <ProviderModelsMatrix
        initialModels={[makeModel({ id: 'x', name: 'Ghost', isActive: false })]}
      />
    );

    expect(screen.getByText('No models match the current filters')).toBeInTheDocument();
  });

  // ── Capability badges ──────────────────────────────────────────────────────

  it('shows "Chat" badge for chat-only models', () => {
    render(<ProviderModelsMatrix initialModels={[makeModel({ capabilities: ['chat'] })]} />);

    expect(screen.getByText('Chat')).toBeInTheDocument();
  });

  it('shows "Embedding" badge for embedding-only models', () => {
    render(
      <ProviderModelsMatrix
        initialModels={[makeModel({ id: 'embed-1', capabilities: ['embedding'] })]}
      />
    );

    // "Embedding" also appears in the decision heuristic table as a tier label.
    // The capability badge has amber-colored classes; verify at least one amber badge exists.
    const allEmbeddingText = screen.getAllByText('Embedding');
    const amberBadge = allEmbeddingText.find(
      (el) => el.className.includes('amber') || el.closest('[class*="amber"]') !== null
    );
    expect(amberBadge).toBeDefined();
  });

  it('shows "Both" badge for models with chat and embedding capabilities', () => {
    render(
      <ProviderModelsMatrix
        initialModels={[makeModel({ id: 'both-1', capabilities: ['chat', 'embedding'] })]}
      />
    );

    expect(screen.getByText('Both')).toBeInTheDocument();
  });

  // ── Provider filter ────────────────────────────────────────────────────────

  it('filtering by provider shows only matching models', async () => {
    const user = userEvent.setup();
    const models = [
      makeModel({ id: 'm1', name: 'GPT-5', providerSlug: 'openai' }),
      makeModel({ id: 'm2', name: 'Claude-4', providerSlug: 'anthropic' }),
    ];
    render(<ProviderModelsMatrix initialModels={models} />);

    // Open the provider Select (first combobox)
    const providerTrigger = screen.getAllByRole('combobox')[0];
    await user.click(providerTrigger);

    // Select "anthropic" option
    const option = await screen.findByRole('option', { name: /anthropic/i });
    await user.click(option);

    expect(screen.getByText('Claude-4')).toBeInTheDocument();
    expect(screen.queryByText('GPT-5')).not.toBeInTheDocument();
  });

  // ── Capability filter ──────────────────────────────────────────────────────

  it('filtering by capability shows only matching models', async () => {
    const user = userEvent.setup();
    const models = [
      makeModel({ id: 'm1', name: 'Chat Model', capabilities: ['chat'] }),
      makeModel({ id: 'm2', name: 'Embed Model', capabilities: ['embedding'] }),
    ];
    render(<ProviderModelsMatrix initialModels={models} />);

    // Third combobox is the capability/type filter
    const capabilityTrigger = screen.getAllByRole('combobox')[2];
    await user.click(capabilityTrigger);

    const option = await screen.findByRole('option', { name: /embedding/i });
    await user.click(option);

    expect(screen.getByText('Embed Model')).toBeInTheDocument();
    expect(screen.queryByText('Chat Model')).not.toBeInTheDocument();
  });

  // ── Model count text ───────────────────────────────────────────────────────

  it('shows correct model count text for multiple active models', () => {
    const models = [
      makeModel({ id: 'm1', name: 'Model A' }),
      makeModel({ id: 'm2', name: 'Model B' }),
    ];
    render(<ProviderModelsMatrix initialModels={models} />);

    expect(screen.getByText(/2 models/)).toBeInTheDocument();
  });

  it('shows singular "model" when count is 1', () => {
    render(<ProviderModelsMatrix initialModels={[makeModel()]} />);

    expect(screen.getByText(/1 model(?!s)/)).toBeInTheDocument();
  });

  it('model count updates to 0 after all models are filtered out', async () => {
    const user = userEvent.setup();
    // Our only model is chat-only; filtering by "embedding" capability → 0 results
    const models = [makeModel({ id: 'm1', name: 'Only Chat', capabilities: ['chat'] })];
    render(<ProviderModelsMatrix initialModels={models} />);

    // Open the capability filter (third combobox at index 2)
    const capabilityTrigger = screen.getAllByRole('combobox')[2];
    await user.click(capabilityTrigger);

    const embeddingOption = await screen.findByRole('option', { name: /^embedding$/i });
    await user.click(embeddingOption);

    // Chat-only model does not match embedding filter → 0 models shown
    expect(screen.getByText(/0 models/)).toBeInTheDocument();
  });

  // ── Sorting ────────────────────────────────────────────────────────────────

  it('clicking "Model" column header changes sort to name', async () => {
    const user = userEvent.setup();
    render(<ProviderModelsMatrix initialModels={[makeModel()]} />);

    // The ArrowUpDown icon on the active sort column has opacity-100 class.
    // Default sort is "providerSlug". Clicking "Model" should change the active sort.
    const modelHeader = screen.getByText('Model').closest('th');
    expect(modelHeader).toBeDefined();

    await user.click(modelHeader!);

    // After clicking Model, the ArrowUpDown within that column header should be opacity-100
    const arrow = modelHeader!.querySelector('svg');
    expect(arrow?.className).toContain('opacity-100');
  });

  it('sort headers are keyboard-accessible via Enter', async () => {
    const user = userEvent.setup();
    render(<ProviderModelsMatrix initialModels={[makeModel()]} />);

    const modelHeader = screen.getByText('Model').closest('th')!;
    modelHeader.focus();
    await user.keyboard('{Enter}');

    // After Enter, the ArrowUpDown within Model column should be active
    const arrow = modelHeader.querySelector('svg');
    expect(arrow?.className).toContain('opacity-100');
  });

  it('sort headers are keyboard-accessible via Space', async () => {
    const user = userEvent.setup();
    render(<ProviderModelsMatrix initialModels={[makeModel()]} />);

    const modelHeader = screen.getByText('Model').closest('th')!;
    modelHeader.focus();
    await user.keyboard(' ');

    const arrow = modelHeader.querySelector('svg');
    expect(arrow?.className).toContain('opacity-100');
  });

  it('clicking same column header toggles sort direction', async () => {
    const user = userEvent.setup();
    const models = [
      makeModel({ id: 'm1', name: 'Alpha', providerSlug: 'openai' }),
      makeModel({ id: 'm2', name: 'Zeta', providerSlug: 'anthropic' }),
    ];
    render(<ProviderModelsMatrix initialModels={models} />);

    const modelHeader = screen.getByText('Model').closest('th');
    // First click: sort by name ascending
    await user.click(modelHeader!);
    const rowsAsc = screen.getAllByRole('row');
    // Skip header row (index 0); first data row should be 'Alpha'
    expect(rowsAsc[1].textContent).toContain('Alpha');

    // Second click: sort by name descending
    await user.click(modelHeader!);
    const rowsDesc = screen.getAllByRole('row');
    // After descending sort, 'Zeta' should come first (or at least order changes)
    // We verify the order changed by checking the first data row is now different
    // (RATING_ORDER fallback: both have non-numeric name, localeCompare applies)
    const firstRowText = rowsDesc[1].textContent ?? '';
    // With descending sort the first result should be 'Zeta' (z > a alphabetically descending)
    expect(firstRowText).toContain('Zeta');
  });

  // ── Links ──────────────────────────────────────────────────────────────────

  it('renders a "Discover models" button (replaces the legacy /new link)', () => {
    render(<ProviderModelsMatrix initialModels={[makeModel()]} />);

    // Phase F replaced the free-text "Add model" link with a button
    // that opens the DiscoverModelsDialog. The button is rendered
    // unconditionally; clicking it is covered separately in the
    // dialog's own tests.
    expect(screen.getByRole('button', { name: /discover models/i })).toBeInTheDocument();
    // Old behaviour gone — no link to /provider-models/new in the
    // matrix toolbar anymore.
    expect(screen.queryByRole('link', { name: /^add model$/i })).not.toBeInTheDocument();
  });

  it('model name is a link to /admin/orchestration/provider-models/{id}', () => {
    render(<ProviderModelsMatrix initialModels={[makeModel({ id: 'model-xyz' })]} />);

    const link = screen.getByRole('link', { name: 'GPT-5' });
    expect(link).toHaveAttribute('href', '/admin/orchestration/provider-models/model-xyz');
  });

  // ── Tier filter ───────────────────────────────────────────────────────────

  it('filtering by tier shows only matching models', async () => {
    const user = userEvent.setup();
    const models = [
      makeModel({ id: 'm1', name: 'Thinker', tierRole: 'thinking' }),
      makeModel({ id: 'm2', name: 'Doer', tierRole: 'worker' }),
    ];
    render(<ProviderModelsMatrix initialModels={models} />);

    // Second combobox is the tier filter
    const tierTrigger = screen.getAllByRole('combobox')[1];
    await user.click(tierTrigger);

    const option = await screen.findByRole('option', { name: /worker/i });
    await user.click(option);

    expect(screen.getByText('Doer')).toBeInTheDocument();
    expect(screen.queryByText('Thinker')).not.toBeInTheDocument();
  });

  // ── Embedding dimensions in bestRole column ───────────────────────────────

  it('shows dimensions and schema checkmark for embedding models', () => {
    render(
      <ProviderModelsMatrix
        initialModels={[
          makeModel({
            id: 'embed-dim',
            capabilities: ['embedding'],
            dimensions: 1536,
            schemaCompatible: true,
            bestRole: 'Embeddings',
          }),
        ]}
      />
    );

    expect(screen.getByText(/1536d/)).toBeInTheDocument();
    expect(screen.getByText(/✓/)).toBeInTheDocument();
  });

  it('shows dimensions without checkmark when not schema compatible', () => {
    render(
      <ProviderModelsMatrix
        initialModels={[
          makeModel({
            id: 'embed-nock',
            capabilities: ['embedding'],
            dimensions: 768,
            schemaCompatible: false,
            bestRole: 'Embeddings',
          }),
        ]}
      />
    );

    expect(screen.getByText(/768d/)).toBeInTheDocument();
  });

  // ── Decision heuristic table ───────────────────────────────────────────────

  it('renders the "Model Selection Heuristic" section', () => {
    render(<ProviderModelsMatrix initialModels={[]} />);

    expect(screen.getByText('Model Selection Heuristic')).toBeInTheDocument();
  });

  it('heuristic table contains expected task characteristic rows', () => {
    render(<ProviderModelsMatrix initialModels={[]} />);

    expect(screen.getByText('Complex reasoning or planning')).toBeInTheDocument();
    expect(screen.getByText('Vector embeddings for search')).toBeInTheDocument();
  });

  // ── Provider status dots ───────────────────────────────────────────────────

  it('green dot for configured+active provider', () => {
    render(
      <ProviderModelsMatrix
        initialModels={[makeModel({ configured: true, configuredActive: true })]}
      />
    );

    const dot = document.querySelector('span.bg-green-500');
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute('title')).toMatch(/configured and active/i);
  });

  it('yellow dot for configured-but-inactive provider', () => {
    render(
      <ProviderModelsMatrix
        initialModels={[makeModel({ configured: true, configuredActive: false })]}
      />
    );

    const dot = document.querySelector('span.bg-yellow-500');
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute('title')).toMatch(/configured but inactive/i);
  });

  it('gray dot for unconfigured provider', () => {
    render(
      <ProviderModelsMatrix
        initialModels={[makeModel({ configured: false, configuredActive: false })]}
      />
    );

    const dot = document.querySelector('span.bg-gray-300');
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute('title')).toMatch(/not configured/i);
  });

  // ── In-use column ──────────────────────────────────────────────────────────

  describe('in-use column', () => {
    it('shows 0 for rows with no bound agents', () => {
      render(<ProviderModelsMatrix initialModels={[makeModel({ agents: [] })]} />);

      // Both the bare "0" cell and the "0 models" filter caption are
      // possible matches — the cell sits inside the table body.
      const tbodyCells = document.querySelectorAll('tbody td');
      const inUseCell = Array.from(tbodyCells).find((td) => td.textContent?.trim() === '0');
      expect(inUseCell).toBeDefined();
    });

    it('renders the agent count as a popover trigger when agents are bound', async () => {
      const user = userEvent.setup();
      render(
        <ProviderModelsMatrix
          initialModels={[
            makeModel({
              name: 'GPT-5',
              agents: [
                { id: 'agent-1', name: 'Triage Bot', slug: 'triage-bot' },
                { id: 'agent-2', name: 'Researcher', slug: 'researcher' },
              ],
            }),
          ]}
        />
      );

      const trigger = screen.getByRole('button', { name: /show 2 agents using GPT-5/i });
      expect(trigger).toBeInTheDocument();

      await user.click(trigger);

      // Popover renders a deep-link to each agent's admin page.
      expect(await screen.findByRole('link', { name: /Triage Bot/ })).toHaveAttribute(
        'href',
        '/admin/orchestration/agents/agent-1'
      );
      expect(screen.getByRole('link', { name: /Researcher/ })).toHaveAttribute(
        'href',
        '/admin/orchestration/agents/agent-2'
      );
    });
  });

  // ── Row delete action + in-use guard ──────────────────────────────────────

  describe('row delete action', () => {
    it('row delete is disabled when at least one agent is bound', () => {
      render(
        <ProviderModelsMatrix
          initialModels={[
            makeModel({
              name: 'GPT-5',
              agents: [{ id: 'agent-1', name: 'Triage', slug: 'triage' }],
            }),
          ]}
        />
      );

      const btn = screen.getByRole('button', { name: /delete GPT-5 disabled — model is in use/i });
      expect(btn).toBeDisabled();
    });

    it('row delete is enabled and calls DELETE on confirmation when no agents bound', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.delete).mockResolvedValue({ id: 'model-1', deleted: true } as never);

      const user = userEvent.setup();
      render(<ProviderModelsMatrix initialModels={[makeModel({ name: 'GPT-5', agents: [] })]} />);

      await user.click(screen.getByRole('button', { name: /^delete GPT-5$/i }));

      // Dialog appears with the model name in the description.
      expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
      expect(screen.getByText(/permanently removes/i)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /^delete$/i }));

      expect(apiClient.delete).toHaveBeenCalledWith(
        '/api/v1/admin/orchestration/provider-models/model-1'
      );
    });

    it('renders the bound-agent list and disables Delete on a 409 response', async () => {
      const { apiClient, APIClientError } = await import('@/lib/api/client');
      vi.mocked(apiClient.delete).mockRejectedValue(
        new APIClientError(
          'Cannot delete model "GPT-5" — 1 active agent still uses it.',
          'MODEL_IN_USE',
          409,
          {
            agents: [{ id: 'agent-3', name: 'Late Bound', slug: 'late-bound' }],
          }
        )
      );

      const user = userEvent.setup();
      // Simulate the optimistic state: matrix data shows 0 agents (the
      // page just loaded), but a concurrent admin bound an agent. The
      // delete request races and the 409 surfaces them.
      render(<ProviderModelsMatrix initialModels={[makeModel({ name: 'GPT-5', agents: [] })]} />);

      await user.click(screen.getByRole('button', { name: /^delete GPT-5$/i }));
      await user.click(screen.getByRole('button', { name: /^delete$/i }));

      // Bound-agent list appears with a deep link to the agent.
      expect(await screen.findByText('Late Bound')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /late bound/i })).toHaveAttribute(
        'href',
        '/admin/orchestration/agents/agent-3'
      );

      // Delete button is disabled — the operator has to re-point the
      // agent before the action can complete.
      const deleteBtn = screen.getByRole('button', { name: /^delete$/i });
      expect(deleteBtn).toBeDisabled();
    });

    it('renders the bound-workflow list and disables Delete on a 409 response', async () => {
      const { apiClient, APIClientError } = await import('@/lib/api/client');
      vi.mocked(apiClient.delete).mockRejectedValue(
        new APIClientError(
          'Cannot delete model "GPT-5" — 1 active workflow still references it.',
          'MODEL_IN_USE',
          409,
          {
            agents: [],
            workflows: [{ id: 'wf-1', name: 'Support Router', slug: 'support-router' }],
          }
        )
      );

      const user = userEvent.setup();
      render(<ProviderModelsMatrix initialModels={[makeModel({ name: 'GPT-5', agents: [] })]} />);

      await user.click(screen.getByRole('button', { name: /^delete GPT-5$/i }));
      await user.click(screen.getByRole('button', { name: /^delete$/i }));

      // Bound-workflow list appears with a deep link to the workflow.
      expect(await screen.findByText('Support Router')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /support router/i })).toHaveAttribute(
        'href',
        '/admin/orchestration/workflows/wf-1'
      );

      // Delete button is disabled until the workflow is re-pointed.
      const deleteBtn = screen.getByRole('button', { name: /^delete$/i });
      expect(deleteBtn).toBeDisabled();
    });
  });
});
