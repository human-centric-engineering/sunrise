/**
 * Tests for `components/admin/orchestration/provider-model-form.tsx`
 *
 * Key behaviours:
 * - Create mode: renders "Create model" button, slug disabled=false
 * - Edit mode: renders "Save changes" button, slug input disabled
 * - Slug auto-fills from providerSlug + name in create mode
 * - Embedding details section shown only when Embedding checkbox is checked
 * - Validation: submit disabled/fails when required fields missing
 * - No capability → shows "At least one capability" error
 * - Create success → apiClient.post called, router.push fires
 * - Edit success → apiClient.patch called, "Saved" message shown
 * - Submit error → shows error message
 * - isActive switch toggles
 *
 * @see components/admin/orchestration/provider-model-form.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ProviderModelForm,
  type ProviderModelData,
} from '@/components/admin/orchestration/provider-model-form';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockPush = vi.fn();
const mockPost = vi.fn();
const mockPatch = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    post: (...args: unknown[]) => mockPost(...args),
    patch: (...args: unknown[]) => mockPatch(...args),
  },
}));

vi.mock('@/lib/api/endpoints', () => ({
  API: {
    ADMIN: {
      ORCHESTRATION: {
        PROVIDER_MODELS: '/api/v1/admin/orchestration/provider-models',
        providerModelById: (id: string) => `/api/v1/admin/orchestration/provider-models/${id}`,
      },
    },
  },
}));

vi.mock('@/types/orchestration', () => ({
  TIER_ROLE_META: {
    thinking: { label: 'Thinking', description: 'High-reasoning tasks' },
    worker: { label: 'Worker', description: 'General tasks' },
  },
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeModel(overrides: Partial<ProviderModelData> = {}): ProviderModelData {
  return {
    id: 'model-1',
    slug: 'anthropic-claude',
    providerSlug: 'anthropic',
    modelId: 'claude-opus-4',
    name: 'Claude Opus 4',
    description: 'Flagship model',
    capabilities: ['chat'],
    tierRole: 'thinking',
    reasoningDepth: 'very_high',
    latency: 'medium',
    costEfficiency: 'none',
    contextLength: 'very_high',
    toolUse: 'strong',
    bestRole: 'Planner / orchestrator',
    isDefault: false,
    isActive: true,
    ...overrides,
  };
}

async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText('e.g. openai'), 'openai');
  await user.type(screen.getByPlaceholderText('e.g. gpt-5'), 'gpt-5');
  await user.type(screen.getByPlaceholderText('e.g. GPT-5'), 'GPT-5');
  await user.type(
    screen.getByPlaceholderText("Brief description of this model's strengths and characteristics."),
    'Next gen model'
  );
  await user.type(screen.getByPlaceholderText('e.g. Planner / orchestrator'), 'Planner');
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ProviderModelForm', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockPost.mockResolvedValue({ id: 'model-new' });
    mockPatch.mockResolvedValue({});
  });

  // ── Create mode ───────────────────────────────────────────────────────────

  it('renders "Create model" submit button in create mode', () => {
    render(<ProviderModelForm />);
    expect(screen.getByRole('button', { name: /create model/i })).toBeInTheDocument();
  });

  it('slug input is enabled in create mode', () => {
    render(<ProviderModelForm />);
    expect(screen.getByLabelText(/^slug$/i)).not.toBeDisabled();
  });

  it('auto-fills slug from providerSlug + name', async () => {
    const user = userEvent.setup();
    render(<ProviderModelForm />);

    await user.type(screen.getByPlaceholderText('e.g. openai'), 'openai');
    await user.type(screen.getByPlaceholderText('e.g. GPT-5'), 'GPT 5');

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/e\.g\. openai-gpt-5/i)).toHaveDisplayValue(/openai/);
    });
  });

  // ── Edit mode ─────────────────────────────────────────────────────────────

  it('renders "Save changes" button in edit mode', () => {
    render(<ProviderModelForm model={makeModel()} />);
    expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
  });

  it('slug input is disabled in edit mode', () => {
    render(<ProviderModelForm model={makeModel()} />);
    expect(screen.getByLabelText(/^slug$/i)).toBeDisabled();
  });

  it('populates fields with model data in edit mode', () => {
    render(<ProviderModelForm model={makeModel()} />);
    expect(screen.getByPlaceholderText('e.g. openai')).toHaveValue('anthropic');
    expect(screen.getByPlaceholderText('e.g. gpt-5')).toHaveValue('claude-opus-4');
    expect(screen.getByPlaceholderText('e.g. GPT-5')).toHaveValue('Claude Opus 4');
  });

  // ── Embedding capability toggle ────────────────────────────────────────────

  it('shows embedding details section when Embedding checkbox is checked', async () => {
    const user = userEvent.setup();
    render(<ProviderModelForm />);

    expect(screen.queryByText('Embedding Details')).not.toBeInTheDocument();

    const embeddingCheckbox = screen.getByRole('checkbox', { name: /^embedding$/i });
    await user.click(embeddingCheckbox);

    expect(screen.getByText('Embedding Details')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/e\.g\. 1536/i)).toBeInTheDocument();
  });

  it('hides embedding details when Embedding is unchecked', async () => {
    const user = userEvent.setup();
    render(<ProviderModelForm model={makeModel({ capabilities: ['chat', 'embedding'] })} />);

    expect(screen.getByText('Embedding Details')).toBeInTheDocument();

    const embeddingCheckbox = screen.getByRole('checkbox', { name: /^embedding$/i });
    await user.click(embeddingCheckbox);

    await waitFor(() => {
      expect(screen.queryByText('Embedding Details')).not.toBeInTheDocument();
    });
  });

  // ── No capability validation ──────────────────────────────────────────────

  it('shows capability error when both Chat and Embedding are unchecked', async () => {
    const user = userEvent.setup();
    render(<ProviderModelForm model={makeModel({ capabilities: ['chat'] })} />);

    // Uncheck Chat
    const chatCheckbox = screen.getByLabelText(/^chat$/i);
    await user.click(chatCheckbox);

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(screen.getByText(/at least one capability/i)).toBeInTheDocument();
    });
    expect(mockPatch).not.toHaveBeenCalled();
  });

  // ── Create submit ─────────────────────────────────────────────────────────

  it('calls apiClient.post and router.push on successful create', async () => {
    const user = userEvent.setup();
    render(<ProviderModelForm />);

    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: /create model/i }));

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(
        '/api/v1/admin/orchestration/provider-models',
        expect.objectContaining({
          body: expect.objectContaining({ name: 'GPT-5', providerSlug: 'openai' }),
        })
      );
    });
    expect(mockPush).toHaveBeenCalledWith('/admin/orchestration/provider-models/model-new');
  });

  // ── Edit submit ───────────────────────────────────────────────────────────

  it('calls apiClient.patch on successful edit', async () => {
    const user = userEvent.setup();
    render(<ProviderModelForm model={makeModel()} />);

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalledWith(
        '/api/v1/admin/orchestration/provider-models/model-1',
        expect.objectContaining({
          body: expect.objectContaining({ name: 'Claude Opus 4' }),
        })
      );
    });
  });

  it('shows "Saved" message after successful edit', async () => {
    const user = userEvent.setup();
    render(<ProviderModelForm model={makeModel()} />);

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(screen.getByText('Saved')).toBeInTheDocument();
    });
  });

  // ── Submit error ──────────────────────────────────────────────────────────

  it('shows error message when submit throws', async () => {
    mockPatch.mockRejectedValue(new Error('Slug already taken'));
    const user = userEvent.setup();
    render(<ProviderModelForm model={makeModel()} />);

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(screen.getByText('Slug already taken')).toBeInTheDocument();
    });
  });

  // ── isActive switch ───────────────────────────────────────────────────────

  it('toggles isActive switch', async () => {
    const user = userEvent.setup();
    render(<ProviderModelForm model={makeModel({ isActive: true })} />);

    const activeSwitch = screen.getByRole('switch');
    expect(activeSwitch).toBeChecked();

    await user.click(activeSwitch);

    expect(activeSwitch).not.toBeChecked();
  });

  // ── Select field interactions ─────────────────────────────────────────────

  it('sends updated reasoningDepth in PATCH payload when changed', async () => {
    const user = userEvent.setup();
    render(<ProviderModelForm model={makeModel({ reasoningDepth: 'medium' })} />);

    // Open the Reasoning Depth select (first SelectTrigger in the grid)
    const triggers = screen.getAllByRole('combobox');
    // Find the one that currently shows "Medium" for reasoning depth
    const reasoningTrigger = triggers.find((t) => t.textContent?.includes('Medium'));
    if (!reasoningTrigger) throw new Error('Reasoning Depth trigger not found');
    await user.click(reasoningTrigger);

    await user.click(await screen.findByRole('option', { name: /^very high$/i }));

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.objectContaining({ reasoningDepth: 'very_high' }),
        })
      );
    });
  });

  it('sends updated latency in PATCH payload when changed', async () => {
    const user = userEvent.setup();
    // Use very_fast as the initial value so the trigger shows "Very Fast" — unique enough to find
    render(<ProviderModelForm model={makeModel({ latency: 'very_fast' })} />);

    const triggers = screen.getAllByRole('combobox');
    // Find the trigger showing "Very Fast" (unique to latency select)
    const latencyTrigger = triggers.find((t) => t.textContent?.includes('Very Fast'));
    if (!latencyTrigger) throw new Error('Latency trigger not found');
    await user.click(latencyTrigger);

    await user.click(await screen.findByRole('option', { name: /^fast$/i }));

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.objectContaining({ latency: 'fast' }),
        })
      );
    });
  });

  it('sends updated costEfficiency in PATCH payload when changed', async () => {
    const user = userEvent.setup();
    // Start with "none" which is distinct to cost efficiency (shares with reasoningDepth but
    // we change to "high" which is unambiguous as we can find the trigger showing "None" and
    // the cost efficiency select is the only one next to Cost Efficiency label)
    render(
      <ProviderModelForm
        model={makeModel({ costEfficiency: 'very_high', reasoningDepth: 'medium' })}
      />
    );

    const triggers = screen.getAllByRole('combobox');
    // reasoningDepth shows "Medium", latency shows its value, costEfficiency shows "Very High"
    // tierRole is first, then reasoningDepth, latency, costEfficiency
    // Find trigger whose text is "Very High" — reasoningDepth starts as medium so first "Very High" is costEfficiency
    const costEffTrigger = triggers.find((t) => t.textContent?.includes('Very High'));
    if (!costEffTrigger) throw new Error('Cost Efficiency trigger not found');
    await user.click(costEffTrigger);

    await user.click(await screen.findByRole('option', { name: /^high$/i }));

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.objectContaining({ costEfficiency: 'high' }),
        })
      );
    });
  });

  it('sends updated contextLength in PATCH payload when changed', async () => {
    const user = userEvent.setup();
    // Use 'high' for contextLength which is unique if other selects are set differently
    render(
      <ProviderModelForm
        model={makeModel({
          contextLength: 'high',
          reasoningDepth: 'very_high',
          costEfficiency: 'medium',
          latency: 'fast',
        })}
      />
    );

    const triggers = screen.getAllByRole('combobox');
    // contextLength is the 4th rating select (after tierRole, reasoningDepth, latency, costEfficiency)
    // index: tierRole=0, reasoningDepth=1, latency=2, costEfficiency=3, contextLength=4, toolUse=5
    const contextTrigger = triggers[4];
    await user.click(contextTrigger);

    await user.click(await screen.findByRole('option', { name: /^n\/a$/i }));

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.objectContaining({ contextLength: 'n_a' }),
        })
      );
    });
  });

  it('sends updated toolUse in PATCH payload when changed', async () => {
    const user = userEvent.setup();
    // "Strong" is unique to toolUse select
    render(<ProviderModelForm model={makeModel({ toolUse: 'strong' })} />);

    const triggers = screen.getAllByRole('combobox');
    const toolUseTrigger = triggers.find((t) => t.textContent?.includes('Strong'));
    if (!toolUseTrigger) throw new Error('Tool Use trigger not found');
    await user.click(toolUseTrigger);

    await user.click(await screen.findByRole('option', { name: /^moderate$/i }));

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.objectContaining({ toolUse: 'moderate' }),
        })
      );
    });
  });

  it('sends updated tierRole in PATCH payload when changed', async () => {
    const user = userEvent.setup();
    render(<ProviderModelForm model={makeModel({ tierRole: 'thinking' })} />);

    // tierRole Select is the first combobox in the form (before the rating grid)
    const triggers = screen.getAllByRole('combobox');
    // tierRole trigger is index 0 (before the grid selects)
    const tierTrigger = triggers[0];
    await user.click(tierTrigger);

    await user.click(await screen.findByRole('option', { name: /worker/i }));

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.objectContaining({ tierRole: 'worker' }),
        })
      );
    });
  });

  // ── bestRole field ────────────────────────────────────────────────────────

  it('sends bestRole in PATCH payload', async () => {
    const user = userEvent.setup();
    render(<ProviderModelForm model={makeModel({ bestRole: 'Planner / orchestrator' })} />);

    const bestRoleInput = screen.getByPlaceholderText('e.g. Planner / orchestrator');
    await user.clear(bestRoleInput);
    await user.type(bestRoleInput, 'Code generation');

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.objectContaining({ bestRole: 'Code generation' }),
        })
      );
    });
  });

  // ── Embedding details inputs ───────────────────────────────────────────────

  it('includes embedding fields in create payload when Embedding is checked', async () => {
    const user = userEvent.setup();
    render(<ProviderModelForm />);

    await fillRequiredFields(user);

    // Enable embedding
    const embeddingCheckbox = screen.getByRole('checkbox', { name: /^embedding$/i });
    await user.click(embeddingCheckbox);

    // Fill dimensions
    await user.type(screen.getByPlaceholderText(/e\.g\. 1536/i), '1536');

    await user.click(screen.getByRole('button', { name: /create model/i }));

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.objectContaining({
            capabilities: expect.arrayContaining(['embedding']),
            dimensions: 1536,
          }),
        })
      );
    });
  });

  it('shows embedding schemaCompatible and hasFreeTier checkboxes when embedding is enabled', async () => {
    const user = userEvent.setup();
    render(<ProviderModelForm />);

    const embeddingCheckbox = screen.getByRole('checkbox', { name: /^embedding$/i });
    await user.click(embeddingCheckbox);

    expect(screen.getByRole('checkbox', { name: /schema compatible/i })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /free tier/i })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /local \/ self-hosted/i })).toBeInTheDocument();
  });

  // ── Manual slug edit stops auto-fill ──────────────────────────────────────

  it('stops auto-filling slug once the user manually edits it', async () => {
    const user = userEvent.setup();
    render(<ProviderModelForm />);

    // Manually edit the slug — this sets slugEdited=true
    const slugInput = screen.getByLabelText(/^slug$/i);
    await user.type(slugInput, 'my-custom-slug');

    // Now type into name — slug should NOT change
    await user.type(screen.getByPlaceholderText('e.g. GPT-5'), 'New Name');

    await waitFor(() => {
      expect(slugInput).toHaveDisplayValue(/my-custom-slug/);
    });
  });

  // ── Edit mode default values ───────────────────────────────────────────────

  it('renders all select fields with correct defaults from model in edit mode', () => {
    render(
      <ProviderModelForm
        model={makeModel({
          reasoningDepth: 'very_high',
          latency: 'medium',
          costEfficiency: 'none',
          contextLength: 'very_high',
          toolUse: 'strong',
          tierRole: 'thinking',
        })}
      />
    );

    // Each SelectTrigger renders its value as text content
    const triggers = screen.getAllByRole('combobox');
    // tierRole (index 0) shows "Thinking — High-reasoning tasks"
    expect(triggers[0].textContent).toMatch(/thinking/i);
    // reasoningDepth (index 1) shows "Very High"
    expect(triggers[1].textContent).toMatch(/very high/i);
    // latency (index 2) shows "Medium"
    expect(triggers[2].textContent).toMatch(/medium/i);
    // costEfficiency (index 3) shows "None"
    expect(triggers[3].textContent).toMatch(/none/i);
    // contextLength (index 4) shows "Very High"
    expect(triggers[4].textContent).toMatch(/very high/i);
    // toolUse (index 5) shows "Strong"
    expect(triggers[5].textContent).toMatch(/strong/i);
  });
});
