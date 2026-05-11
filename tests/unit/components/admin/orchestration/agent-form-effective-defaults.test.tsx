/**
 * AgentForm — Effective Defaults Tests
 *
 * Covers the bug where system-seeded agents (pattern-advisor, quiz-master,
 * mcp-system, model-auditor) ship with empty `provider` / `model` strings
 * and the edit form rendered them as blank Selects / a free-text Input.
 *
 * Test Coverage:
 * - Empty agent.provider/model falls through to effectiveDefaults
 * - Provider Select shows effective provider in the trigger
 * - Model Select shows effective model in the trigger
 * - Model field is always a Select when models list is non-empty
 *   (no more text-input fallback when filteredModels is empty)
 * - "Inherited from …" hint appears in edit mode but not create mode
 *
 * @see components/admin/orchestration/agent-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AgentForm } from '@/components/admin/orchestration/agent-form';
import type { AiAgent, AiProviderConfig } from '@/types/prisma';

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

const PROVIDERS: (AiProviderConfig & { apiKeyPresent?: boolean })[] = [
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
    apiKeyPresent: true,
  } as AiProviderConfig & { apiKeyPresent: boolean },
  {
    id: 'prov-openai',
    name: 'OpenAI',
    slug: 'openai',
    providerType: 'openai-compatible',
    apiKeyEnvVar: 'OPENAI_KEY',
    isActive: true,
    isLocal: false,
    createdBy: 'system',
    createdAt: new Date(),
    updatedAt: new Date(),
    baseUrl: null,
    metadata: {},
    apiKeyPresent: true,
  } as AiProviderConfig & { apiKeyPresent: boolean },
];

const MODELS = [
  { provider: 'anthropic', id: 'claude-opus-4-6', tier: 'frontier' },
  { provider: 'anthropic', id: 'claude-haiku-3', tier: 'budget' },
  { provider: 'openai', id: 'gpt-4o', tier: 'frontier' },
];

function makeSystemSeededAgent(): AiAgent {
  // Mirrors how pattern-advisor / quiz-master / mcp-system / model-auditor
  // are seeded — empty strings that are resolved at runtime by
  // agent-resolver.ts.
  return {
    id: 'pattern-advisor',
    name: 'Pattern Advisor',
    slug: 'pattern-advisor',
    description: 'Recommends orchestration patterns.',
    systemInstructions: 'Help operators pick orchestration patterns.',
    provider: '',
    providerConfig: null,
    model: '',
    temperature: 0.7,
    maxTokens: 4096,
    monthlyBudgetUsd: null,
    isActive: true,
    isSystem: true,
    createdBy: 'system',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    systemInstructionsHistory: [],
    metadata: {},
    knowledgeCategories: [],
    topicBoundaries: [],
    brandVoiceInstructions: null,
    rateLimitRpm: null,
    inputGuardMode: null,
    outputGuardMode: null,
    citationGuardMode: null,
    maxHistoryTokens: null,
    retentionDays: null,
    visibility: 'internal',
    deletedAt: null,
    fallbackProviders: [],
    enableVoiceInput: false,
    widgetConfig: null,
  } as AiAgent;
}

async function openModelTab(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('tab', { name: /model/i }));
  return user;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AgentForm — effective defaults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pre-fills Provider Select with effectiveDefaults when agent.provider is empty', async () => {
    render(
      <AgentForm
        mode="edit"
        agent={makeSystemSeededAgent()}
        providers={PROVIDERS}
        models={MODELS}
        effectiveDefaults={{
          provider: 'anthropic',
          model: 'claude-opus-4-6',
          inheritedProvider: true,
          inheritedModel: true,
        }}
      />
    );

    await openModelTab();

    const providerTrigger = screen.getByRole('combobox', { name: /provider/i });
    // Trigger displays the resolved provider name, not the placeholder.
    expect(providerTrigger).toHaveTextContent(/anthropic/i);
    expect(providerTrigger).not.toHaveTextContent(/pick a provider/i);
  });

  it('pre-fills Model Select with effectiveDefaults when agent.model is empty', async () => {
    render(
      <AgentForm
        mode="edit"
        agent={makeSystemSeededAgent()}
        providers={PROVIDERS}
        models={MODELS}
        effectiveDefaults={{
          provider: 'anthropic',
          model: 'claude-opus-4-6',
          inheritedProvider: true,
          inheritedModel: true,
        }}
      />
    );

    await openModelTab();

    const modelTrigger = screen.getByRole('combobox', { name: /^model/i });
    expect(modelTrigger).toHaveTextContent(/claude-opus-4-6/i);
    expect(modelTrigger).not.toHaveTextContent(/pick a model/i);
  });

  it('renders Model as a Select (not a text input) when models list is non-empty', async () => {
    // Regression: when agent.model was empty and the provider was empty,
    // filteredModels was [] and the field collapsed to a free-text Input.
    // With effectiveDefaults populated, filteredModels has matches, so the
    // Select must render.
    render(
      <AgentForm
        mode="edit"
        agent={makeSystemSeededAgent()}
        providers={PROVIDERS}
        models={MODELS}
        effectiveDefaults={{
          provider: 'anthropic',
          model: 'claude-opus-4-6',
          inheritedProvider: true,
          inheritedModel: true,
        }}
      />
    );

    await openModelTab();

    expect(screen.getByRole('combobox', { name: /^model/i })).toBeInTheDocument();
    // No free-text Input for the model field
    expect(screen.queryByRole('textbox', { name: /^model/i })).not.toBeInTheDocument();
  });

  it('disables the Model Select with an explanatory hint when no models match the provider', async () => {
    // Models registry loaded but none match the current provider — should
    // still render a Select (disabled) with a help message, not fall back
    // to a bare text input that users can't validate.
    const agent = makeSystemSeededAgent();
    agent.provider = 'mystery-provider';
    agent.model = '';

    render(
      <AgentForm
        mode="edit"
        agent={agent}
        providers={PROVIDERS}
        models={MODELS}
        effectiveDefaults={{
          provider: 'mystery-provider',
          model: '',
          inheritedProvider: false,
          inheritedModel: true,
        }}
      />
    );

    await openModelTab();

    const modelTrigger = screen.getByRole('combobox', { name: /^model/i });
    expect(modelTrigger).toBeDisabled();
    expect(modelTrigger).toHaveTextContent(/no models registered/i);
    expect(screen.getByText(/no models are registered for/i)).toBeInTheDocument();
  });

  it('shows the "Inherited from …" hint under provider and model in edit mode', async () => {
    render(
      <AgentForm
        mode="edit"
        agent={makeSystemSeededAgent()}
        providers={PROVIDERS}
        models={MODELS}
        effectiveDefaults={{
          provider: 'anthropic',
          model: 'claude-opus-4-6',
          inheritedProvider: true,
          inheritedModel: true,
        }}
      />
    );

    await openModelTab();

    await waitFor(() => {
      expect(screen.getByText(/inherited from the first active provider/i)).toBeInTheDocument();
      expect(screen.getByText(/inherited from the system default chat model/i)).toBeInTheDocument();
    });
  });

  it('does NOT show inherited hints when the agent has explicit values', async () => {
    const agent = makeSystemSeededAgent();
    agent.provider = 'anthropic';
    agent.model = 'claude-opus-4-6';

    render(
      <AgentForm
        mode="edit"
        agent={agent}
        providers={PROVIDERS}
        models={MODELS}
        effectiveDefaults={{
          provider: 'anthropic',
          model: 'claude-opus-4-6',
          inheritedProvider: false,
          inheritedModel: false,
        }}
      />
    );

    await openModelTab();

    expect(screen.queryByText(/inherited from/i)).not.toBeInTheDocument();
  });

  it('does NOT show inherited hints in create mode', async () => {
    render(
      <AgentForm
        mode="create"
        providers={PROVIDERS}
        models={MODELS}
        effectiveDefaults={{
          provider: 'anthropic',
          model: 'claude-opus-4-6',
          inheritedProvider: true,
          inheritedModel: true,
        }}
      />
    );

    await openModelTab();

    expect(screen.queryByText(/inherited from/i)).not.toBeInTheDocument();
  });

  it('falls back to hardcoded defaults when neither agent nor effectiveDefaults supply values', async () => {
    // Belt-and-braces case: no agent (create mode), no effectiveDefaults
    // prop. The form should still render with sensible literals so the
    // dropdowns aren't blank.
    render(<AgentForm mode="create" providers={PROVIDERS} models={MODELS} />);

    await openModelTab();

    const providerTrigger = screen.getByRole('combobox', { name: /provider/i });
    expect(providerTrigger).toHaveTextContent(/anthropic/i);
  });
});
