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
      const slugInput = screen.getByPlaceholderText(/e\.g\. openai-gpt-5/i);
      expect(slugInput.value).toContain('openai');
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
});
