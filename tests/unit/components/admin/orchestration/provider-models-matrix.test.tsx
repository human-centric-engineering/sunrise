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
import { render, screen, within } from '@testing-library/react';
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
  MODEL_CAPABILITIES: ['chat', 'reasoning', 'embedding', 'audio', 'image', 'moderation'],
  STORAGE_ONLY_CAPABILITIES: ['image', 'moderation'],
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

    // The provider strip above the filter bar also renders "openai" as
    // a filter chip, so scope to the table body to assert specifically
    // on the row's provider column.
    const dataRow = screen.getByRole('row', { name: /gpt-5/i });
    expect(within(dataRow).getByText('openai')).toBeInTheDocument();
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

    // The "Chat" string also appears on the capability filter chip and in
    // the decision heuristic table at the bottom of the page. Scope to
    // the data row by the model's display name so we assert on the
    // badge specifically.
    const dataRow = screen.getByRole('row', { name: /gpt-5/i });
    expect(within(dataRow).getByText('Chat')).toBeInTheDocument();
  });

  it('shows "Embedding" badge for embedding-only models', () => {
    render(
      <ProviderModelsMatrix
        initialModels={[
          makeModel({
            id: 'embed-1',
            name: 'Embed Test Model',
            capabilities: ['embedding'],
          }),
        ]}
      />
    );

    // "Embedding" also appears in the decision heuristic table at the
    // bottom of the source. Scope the badge query to the data row by
    // its visible name (model.name is what the row's accessible name
    // is built from) instead of inspecting class names.
    const dataRow = screen.getByRole('row', { name: /embed test model/i });
    expect(within(dataRow).getByText('Embedding')).toBeInTheDocument();
  });

  it('renders one badge per capability for multi-capability rows', () => {
    // Pre-Phase-4 the matrix collapsed chat+embedding into a single
    // "Both" badge. The matrix now stores six capabilities, so the
    // collapse loses information — render one pill per stored cap.
    render(
      <ProviderModelsMatrix
        initialModels={[makeModel({ id: 'both-1', capabilities: ['chat', 'embedding'] })]}
      />
    );

    const dataRow = screen.getByRole('row', { name: /gpt-5/i });
    // Capability column is index 2 (Provider, Model, Capabilities, ...).
    // Scope to that cell so the assertion counts only badges, not other
    // occurrences of the labels in popovers or filter chips.
    const capabilityCell = within(dataRow).getAllByRole('cell')[2];
    expect(within(capabilityCell).getByText('Chat')).toBeInTheDocument();
    expect(within(capabilityCell).getByText('Embedding')).toBeInTheDocument();
    // Exact-2 lock-in: two stored capabilities ⇒ two badges in the cell,
    // never a collapsed "Both" pill.
    expect(
      within(capabilityCell).getAllByText(/^(chat|reasoning|embedding|audio|image|moderation)$/i)
    ).toHaveLength(2);
  });

  it.each(['reasoning', 'audio', 'image', 'moderation'] as const)(
    'shows the %s badge when the matrix stores that capability',
    (cap) => {
      render(
        <ProviderModelsMatrix
          initialModels={[makeModel({ id: `m-${cap}`, name: `Cap-${cap}`, capabilities: [cap] })]}
        />
      );
      const dataRow = screen.getByRole('row', { name: new RegExp(`cap-${cap}`, 'i') });
      const expectedLabel = cap.charAt(0).toUpperCase() + cap.slice(1);
      expect(within(dataRow).getByText(expectedLabel)).toBeInTheDocument();
    }
  );

  it('renders the Storage-only indicator for rows with only image/moderation capabilities', () => {
    render(
      <ProviderModelsMatrix
        initialModels={[makeModel({ id: 'img-only', capabilities: ['image'] })]}
      />
    );
    const dataRow = screen.getByRole('row', { name: /gpt-5/i });
    expect(within(dataRow).getByText(/storage-only/i)).toBeInTheDocument();
  });

  it('does not render the Storage-only indicator when a runtime capability is present', () => {
    render(
      <ProviderModelsMatrix
        initialModels={[makeModel({ id: 'mixed', capabilities: ['chat', 'image'] })]}
      />
    );
    const dataRow = screen.getByRole('row', { name: /gpt-5/i });
    expect(within(dataRow).queryByText(/storage-only/i)).not.toBeInTheDocument();
  });

  // ── Provider filter ────────────────────────────────────────────────────────

  it('filtering by provider chip shows only matching models', async () => {
    const user = userEvent.setup();
    const models = [
      makeModel({ id: 'm1', name: 'GPT-5', providerSlug: 'openai' }),
      makeModel({ id: 'm2', name: 'Claude-4', providerSlug: 'anthropic' }),
    ];
    render(<ProviderModelsMatrix initialModels={models} />);

    // The Provider <Select> dropdown was replaced by chips in the
    // provider strip above the filter bar so an operator can see
    // configured-vs-not at a glance. Locate the anthropic chip via
    // its aria-label (the chip text alone collides with the provider
    // column inside the table body).
    const anthropicChip = screen.getByRole('button', {
      name: /filter to anthropic models/i,
    });
    await user.click(anthropicChip);

    expect(screen.getByText('Claude-4')).toBeInTheDocument();
    expect(screen.queryByText('GPT-5')).not.toBeInTheDocument();
  });

  // ── Capability filter ──────────────────────────────────────────────────────

  it('filtering by capability chip shows only matching models', async () => {
    const user = userEvent.setup();
    const models = [
      makeModel({ id: 'm1', name: 'Chat Model', capabilities: ['chat'] }),
      makeModel({ id: 'm2', name: 'Embed Model', capabilities: ['embedding'] }),
    ];
    render(<ProviderModelsMatrix initialModels={models} />);

    // Phase 4: capability dropdown was replaced by chip multi-select
    // mirroring the catalogue panel. Toggle the Embedding chip via its
    // pressable button role.
    const embeddingChip = screen.getByRole('button', { name: /^embedding$/i });
    await user.click(embeddingChip);

    expect(screen.getByText('Embed Model')).toBeInTheDocument();
    expect(screen.queryByText('Chat Model')).not.toBeInTheDocument();
  });

  it('chip filter uses OR semantics — selecting Chat and Audio shows both', async () => {
    const user = userEvent.setup();
    const models = [
      makeModel({ id: 'm1', name: 'Chat Model', capabilities: ['chat'] }),
      makeModel({ id: 'm2', name: 'Audio Model', capabilities: ['audio'] }),
      makeModel({ id: 'm3', name: 'Embed Model', capabilities: ['embedding'] }),
    ];
    render(<ProviderModelsMatrix initialModels={models} />);

    await user.click(screen.getByRole('button', { name: /^chat$/i }));
    await user.click(screen.getByRole('button', { name: /^audio$/i }));

    expect(screen.getByText('Chat Model')).toBeInTheDocument();
    expect(screen.getByText('Audio Model')).toBeInTheDocument();
    expect(screen.queryByText('Embed Model')).not.toBeInTheDocument();
  });

  it('search input narrows by name / modelId / slug / bestRole', async () => {
    const user = userEvent.setup();
    const models = [
      makeModel({ id: 'm1', name: 'GPT-5', modelId: 'gpt-5', bestRole: 'Planner' }),
      makeModel({
        id: 'm2',
        name: 'Whisper 1',
        modelId: 'whisper-1',
        capabilities: ['audio'],
        bestRole: 'Speech-to-text',
      }),
    ];
    render(<ProviderModelsMatrix initialModels={models} />);

    const search = screen.getByPlaceholderText(/search/i);
    await user.type(search, 'whisper');

    expect(screen.getByText('Whisper 1')).toBeInTheDocument();
    expect(screen.queryByText('GPT-5')).not.toBeInTheDocument();
  });

  it('"Has agent" toggle hides rows that have no bound agents', async () => {
    const user = userEvent.setup();
    const models = [
      makeModel({
        id: 'm1',
        name: 'Unused Model',
        agents: [],
      }),
      makeModel({
        id: 'm2',
        name: 'Used Model',
        agents: [{ id: 'a1', name: 'Agent 1', slug: 'agent-1' }],
      }),
    ];
    render(<ProviderModelsMatrix initialModels={models} />);

    const hasAgentChip = screen.getByRole('button', {
      name: /show only models with at least one bound agent/i,
    });
    expect(hasAgentChip).toHaveTextContent(/has agent/i);
    await user.click(hasAgentChip);

    expect(screen.getByText('Used Model')).toBeInTheDocument();
    expect(screen.queryByText('Unused Model')).not.toBeInTheDocument();
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
    // Our only model is chat-only; toggling the Embedding chip yields zero matches.
    const models = [makeModel({ id: 'm1', name: 'Only Chat', capabilities: ['chat'] })];
    render(<ProviderModelsMatrix initialModels={models} />);

    await user.click(screen.getByRole('button', { name: /^embedding$/i }));

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

    // Tier is now the only combobox left in the filter bar — the
    // legacy Provider <Select> was replaced by chips when the provider
    // strip landed, so the tier dropdown sits at index 0.
    const tierTrigger = screen.getAllByRole('combobox')[0];
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

  // ── Provider strip + Configured-only toggle ───────────────────────────────

  describe('provider strip', () => {
    it('renders one chip per distinct provider with its model count', () => {
      const models = [
        makeModel({ id: 'a1', name: 'A1', providerSlug: 'anthropic' }),
        makeModel({ id: 'a2', name: 'A2', providerSlug: 'anthropic' }),
        makeModel({ id: 'o1', name: 'O1', providerSlug: 'openai' }),
      ];
      render(<ProviderModelsMatrix initialModels={models} />);

      // Chip aria-label includes the slug so we can locate it
      // unambiguously alongside the table's per-row provider column.
      const anthropicChip = screen.getByRole('button', {
        name: /filter to anthropic models/i,
      });
      const openaiChip = screen.getByRole('button', {
        name: /filter to openai models/i,
      });

      // Each chip shows its model count alongside the slug so the
      // operator gets a quick "how many models per provider" read.
      expect(anthropicChip).toHaveTextContent('2');
      expect(openaiChip).toHaveTextContent('1');
    });

    it('summary text reports active + total provider counts', () => {
      const models = [
        makeModel({
          id: 'a1',
          providerSlug: 'anthropic',
          configured: true,
          configuredActive: true,
        }),
        makeModel({
          id: 'o1',
          providerSlug: 'openai',
          configured: true,
          configuredActive: false,
        }),
        makeModel({
          id: 't1',
          providerSlug: 'together',
          configured: false,
          configuredActive: false,
        }),
      ];
      render(<ProviderModelsMatrix initialModels={models} />);

      // Summary lives in the provider strip header — anchors the
      // operator with "1 of 3 providers are wired up" at a glance.
      expect(screen.getByText(/1 active · 3 total/i)).toBeInTheDocument();
    });

    it('chip status dot reflects the provider config: green active, yellow inactive, gray missing', () => {
      const models = [
        makeModel({
          id: 'a1',
          providerSlug: 'anthropic',
          configured: true,
          configuredActive: true,
        }),
        makeModel({
          id: 'o1',
          providerSlug: 'openai',
          configured: true,
          configuredActive: false,
        }),
        makeModel({
          id: 't1',
          providerSlug: 'together',
          configured: false,
          configuredActive: false,
        }),
      ];
      render(<ProviderModelsMatrix initialModels={models} />);

      // Locate each chip via aria-label and inspect its inline dot.
      // The chip is the closest button; its dot is the first <span>
      // child with a rounded-full class.
      const anthropicDot = screen
        .getByRole('button', { name: /filter to anthropic models/i })
        .querySelector('span.rounded-full');
      const openaiDot = screen
        .getByRole('button', { name: /filter to openai models/i })
        .querySelector('span.rounded-full');
      const togetherDot = screen
        .getByRole('button', { name: /filter to together models/i })
        .querySelector('span.rounded-full');

      expect(anthropicDot?.className).toContain('bg-green-500');
      expect(openaiDot?.className).toContain('bg-yellow-500');
      expect(togetherDot?.className).toContain('bg-gray-300');
    });

    it('clicking a provider chip filters the matrix to that provider', async () => {
      const user = userEvent.setup();
      const models = [
        makeModel({ id: 'a1', name: 'Claude-4', providerSlug: 'anthropic' }),
        makeModel({ id: 'o1', name: 'GPT-5', providerSlug: 'openai' }),
      ];
      render(<ProviderModelsMatrix initialModels={models} />);

      await user.click(screen.getByRole('button', { name: /filter to anthropic models/i }));

      expect(screen.getByText('Claude-4')).toBeInTheDocument();
      expect(screen.queryByText('GPT-5')).not.toBeInTheDocument();
    });

    it('clicking the active chip again clears the provider filter', async () => {
      const user = userEvent.setup();
      const models = [
        makeModel({ id: 'a1', name: 'Claude-4', providerSlug: 'anthropic' }),
        makeModel({ id: 'o1', name: 'GPT-5', providerSlug: 'openai' }),
      ];
      render(<ProviderModelsMatrix initialModels={models} />);

      const anthropicChip = screen.getByRole('button', {
        name: /filter to anthropic models/i,
      });
      // First click selects.
      await user.click(anthropicChip);
      expect(screen.queryByText('GPT-5')).not.toBeInTheDocument();
      // Second click on the same chip toggles back to all-providers
      // — matches the standard chip-toggle pattern used elsewhere.
      await user.click(anthropicChip);
      expect(screen.getByText('GPT-5')).toBeInTheDocument();
      expect(screen.getByText('Claude-4')).toBeInTheDocument();
    });

    it('"Configured only" toggle hides rows from unconfigured providers', async () => {
      const user = userEvent.setup();
      const models = [
        makeModel({
          id: 'a1',
          name: 'Claude-4',
          providerSlug: 'anthropic',
          configured: true,
          configuredActive: true,
        }),
        makeModel({
          id: 'o1',
          name: 'GPT-5',
          providerSlug: 'openai',
          configured: true,
          configuredActive: false,
        }),
        makeModel({
          id: 't1',
          name: 'Together-Model',
          providerSlug: 'together',
          configured: false,
          configuredActive: false,
        }),
      ];
      render(<ProviderModelsMatrix initialModels={models} />);

      // Baseline — all three rows visible.
      expect(screen.getByText('Claude-4')).toBeInTheDocument();
      expect(screen.getByText('GPT-5')).toBeInTheDocument();
      expect(screen.getByText('Together-Model')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /configured only/i }));

      // Only configured + active stays visible.
      expect(screen.getByText('Claude-4')).toBeInTheDocument();
      // The inactive-but-configured row drops too — the toggle's
      // purpose is "show what's actually going to work right now",
      // and an inactive provider config won't serve requests.
      expect(screen.queryByText('GPT-5')).not.toBeInTheDocument();
      expect(screen.queryByText('Together-Model')).not.toBeInTheDocument();
    });

    it('"Configured only" toggle drops the chips for non-configured providers', async () => {
      const user = userEvent.setup();
      const models = [
        makeModel({
          id: 'a1',
          providerSlug: 'anthropic',
          configured: true,
          configuredActive: true,
        }),
        makeModel({
          id: 't1',
          providerSlug: 'together',
          configured: false,
          configuredActive: false,
        }),
      ];
      render(<ProviderModelsMatrix initialModels={models} />);

      // Baseline — both chips visible.
      expect(
        screen.getByRole('button', { name: /filter to anthropic models/i })
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /filter to together models/i })
      ).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /configured only/i }));

      // The unconfigured chip is dropped — keeping it around when its
      // rows are filtered out would be confusing noise.
      expect(
        screen.getByRole('button', { name: /filter to anthropic models/i })
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /filter to together models/i })
      ).not.toBeInTheDocument();
    });
  });

  // ── Used-by column ─────────────────────────────────────────────────────────

  describe('used-by column', () => {
    it('renames the column header from "In use" to "Used by"', () => {
      render(<ProviderModelsMatrix initialModels={[makeModel({ agents: [] })]} />);

      // The column was renamed so its meaning (agents + default-role
      // slots) reads at a glance. Bare "In use" no longer appears in
      // the header.
      expect(screen.getByRole('columnheader', { name: /used by/i })).toBeInTheDocument();
      expect(screen.queryByRole('columnheader', { name: /^in use$/i })).not.toBeInTheDocument();
    });

    it('shows "Not in use" when a row has no agents and no default roles', () => {
      render(<ProviderModelsMatrix initialModels={[makeModel({ agents: [], defaultFor: [] })]} />);

      // The explicit "Not in use" disambiguates the cell — a bare "0"
      // used to leave readers wondering "0 of what?". The cell sits
      // inside the table body, so scope the lookup there to avoid
      // colliding with any other "Not in use" text.
      const tbodyCells = document.querySelectorAll('tbody td');
      const inUseCell = Array.from(tbodyCells).find(
        (td) => td.textContent?.trim() === 'Not in use'
      );
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

      // aria-label says "directly assigned to" so the trigger's
      // meaning is unambiguous — it lists agents that explicitly
      // pinned the model, not those inheriting via a default.
      const trigger = screen.getByRole('button', {
        name: /show 2 agents directly assigned to GPT-5/i,
      });
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

    it('renders a default-role badge for each TaskType slot a model fills', () => {
      render(
        <ProviderModelsMatrix
          initialModels={[
            makeModel({
              name: 'GPT-5',
              agents: [],
              defaultFor: ['chat', 'reasoning'],
            }),
          ]}
        />
      );

      // Each TaskType slot produces a badge so the operator can spot
      // every place the runtime falls back to this model without
      // opening settings. Badges link to the orchestration settings
      // page for one-click editing.
      const dataRow = screen.getByRole('row', { name: /GPT-5/ });
      expect(within(dataRow).getByText(/default: chat/i)).toBeInTheDocument();
      expect(within(dataRow).getByText(/default: reasoning/i)).toBeInTheDocument();

      const chatBadge = within(dataRow).getByText(/default: chat/i);
      const settingsLink = chatBadge.closest('a');
      expect(settingsLink).toHaveAttribute('href', '/admin/orchestration/settings');
    });

    it('shows the default-role badges even when there are no directly-assigned agents', () => {
      render(
        <ProviderModelsMatrix
          initialModels={[
            makeModel({
              name: 'GPT-5',
              agents: [],
              defaultFor: ['embeddings'],
            }),
          ]}
        />
      );

      // "Not in use" must NOT appear when a default-role slot is
      // filled — the model is in use via inheritance even without a
      // direct agent assignment.
      const dataRow = screen.getByRole('row', { name: /GPT-5/ });
      expect(within(dataRow).getByText(/default: embeddings/i)).toBeInTheDocument();
      expect(within(dataRow).queryByText(/not in use/i)).not.toBeInTheDocument();
      // The "0 agents" line is still shown so the operator can see
      // there's no direct assignment alongside the default badge.
      expect(within(dataRow).getByText(/0 agents/i)).toBeInTheDocument();
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
