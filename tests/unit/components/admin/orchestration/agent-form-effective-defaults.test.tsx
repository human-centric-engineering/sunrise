// @vitest-environment happy-dom

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

vi.mock('next/navigation', async () => {
  const { createMockRouter } = await import('@/tests/types/mocks');
  return {
    useRouter: () => createMockRouter(),
    useSearchParams: () => ({ get: () => null }),
  };
});

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
    reasoningEffort: null,
    monthlyBudgetUsd: null,
    maxCostPerTurnUsd: null,
    isActive: true,
    isSystem: true,
    kind: 'chat',
    createdBy: 'system',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    systemInstructionsHistory: [],
    metadata: {},
    knowledgeCategories: [],
    knowledgeAccessMode: 'full',
    knowledgeRetrievalMode: 'model',
    knowledgeTriggerKeywords: [],
    topicBoundaries: [],
    brandVoiceInstructions: null,
    persona: null,
    guardrails: null,
    personaMode: 'override',
    voiceMode: 'override',
    guardrailsMode: 'override',
    profileId: null,
    rateLimitRpm: null,
    inputGuardMode: null,
    outputGuardMode: null,
    citationGuardMode: null,
    maxHistoryTokens: null,
    maxHistoryMessages: null,
    retentionDays: null,
    visibility: 'internal',
    deletedAt: null,
    lastActiveAt: null,
    fallbackProviders: [],
    enableVoiceInput: false,
    enableImageInput: false,
    enableDocumentInput: false,
    runtimePromptManaged: false,
    runtimePromptNote: null,
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

  it('leaves the provider unselected when neither agent nor effectiveDefaults supply one', async () => {
    // INVERTED for t-661. This used to assert the opposite — that the form
    // "should still render with sensible literals so the dropdowns aren't
    // blank" — and that literal was the defect: a value nobody chose, which
    // the form submits as an explicit `agent.provider`. An unselected Select
    // showing its placeholder is the correct rendering of "nothing resolved".
    render(<AgentForm mode="create" providers={PROVIDERS} models={MODELS} />);

    await openModelTab();

    const providerTrigger = screen.getByRole('combobox', { name: /provider/i });
    expect(providerTrigger).toHaveTextContent(/pick a provider/i);
    expect(providerTrigger).not.toHaveTextContent(/anthropic/i);
  });
});

/**
 * t-661 — a policy denial must never be written as an explicit provider.
 *
 * `getEffectiveAgentDefaults` mirrors the runtime's own eligibility check and
 * returns `provider: ''` when a fork's `registerProviderEligibility` rule
 * permits nothing for `source: 'primary'` — including when the rule THROWS,
 * which fails closed to the same empty set, so both are covered by these
 * assertions. The form used to `|| 'anthropic'` past that empty string and
 * submit the literal, and `resolveAgentProviderAndModel` never filters an
 * explicit `agent.provider` — so the denial became a permanent pinned choice
 * the seam then honoured.
 *
 * Every deny case here is paired with a CONTROL that performs the identical
 * fill against a resolved provider and asserts the request DOES go out. Green
 * on the deny tests alone would also be what a harness that cannot reach the
 * submit path at all looks like.
 */
describe('AgentForm — a denied provider is never written (t-661)', () => {
  const DENIED = {
    provider: '',
    model: '',
    inheritedProvider: true,
    inheritedModel: true,
  } as const;

  const RESOLVED = {
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    inheritedProvider: true,
    inheritedModel: true,
  } as const;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Fill EVERY field the schema requires apart from provider/model, so the
   * only thing that can block the submit is the provider. Leaving one out
   * (description, first time round) makes the deny assertions pass for a
   * reason that has nothing to do with the policy — the control below is what
   * exposed it.
   */
  async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.type(screen.getByRole('textbox', { name: /^name/i }), 'Denied Bot');
    await user.type(
      screen.getByRole('textbox', { name: /^description/i }),
      'An agent for the denial test.'
    );
    await user.click(screen.getByRole('tab', { name: /instructions/i }));
    await user.type(
      screen.getByRole('textbox', { name: /system instructions/i }),
      'You are helpful.'
    );
    await user.click(screen.getByRole('tab', { name: /general/i }));
  }

  it('create: refuses to submit rather than inventing a provider', async () => {
    const { apiClient } = await import('@/lib/api/client');
    const user = userEvent.setup();

    render(
      <AgentForm mode="create" providers={PROVIDERS} models={MODELS} effectiveDefaults={DENIED} />
    );

    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: /create agent/i }));

    // Both claims inside one waitFor, the write first. A bare synchronous
    // `not.toHaveBeenCalled()` straight after the click would pass simply
    // because the submit path had not run yet; polling until the banner
    // appears means the form has finished deciding, and a regression that
    // writes fails here on the write rather than on a banner's wording.
    // The provider is why it was blocked — every other required field was
    // filled above, so nothing else can appear in that list.
    await waitFor(() => {
      expect(apiClient.post).not.toHaveBeenCalled();
      expect(
        screen.getByText(/these fields need attention: provider, model\./i)
      ).toBeInTheDocument();
    });
  });

  it('CONTROL — create: the identical fill DOES submit when a provider was resolved', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockResolvedValue({ id: 'new-id', slug: 'denied-bot' });
    const user = userEvent.setup();

    render(
      <AgentForm mode="create" providers={PROVIDERS} models={MODELS} effectiveDefaults={RESOLVED} />
    );

    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: /create agent/i }));

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith(
        expect.stringContaining('/agents'),
        expect.objectContaining({ body: expect.objectContaining({ provider: 'anthropic' }) })
      );
    });
  });

  it('edit: an inheriting agent cannot be saved into a provider the policy denies', async () => {
    const { apiClient } = await import('@/lib/api/client');
    const user = userEvent.setup();

    render(
      <AgentForm
        mode="edit"
        agent={makeSystemSeededAgent()}
        providers={PROVIDERS}
        models={MODELS}
        effectiveDefaults={DENIED}
      />
    );

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(apiClient.patch).not.toHaveBeenCalled();
      expect(
        screen.getByText(/these fields need attention: provider, model\./i)
      ).toBeInTheDocument();
    });
  });

  it('CONTROL — edit: the identical save DOES submit when a provider was resolved', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockResolvedValue({ id: 'pattern-advisor' });
    const user = userEvent.setup();

    render(
      <AgentForm
        mode="edit"
        agent={makeSystemSeededAgent()}
        providers={PROVIDERS}
        models={MODELS}
        effectiveDefaults={RESOLVED}
      />
    );

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(apiClient.patch).toHaveBeenCalledWith(
        expect.stringContaining('pattern-advisor'),
        expect.objectContaining({ body: expect.objectContaining({ provider: 'anthropic' }) })
      );
    });
  });

  it('explains the empty provider instead of offering to lock the agent to nothing', async () => {
    render(
      <AgentForm
        mode="edit"
        agent={makeSystemSeededAgent()}
        providers={PROVIDERS}
        models={MODELS}
        effectiveDefaults={DENIED}
      />
    );

    await openModelTab();

    expect(screen.getByText(/no provider could be resolved automatically/i)).toBeInTheDocument();
    // The "Saving will lock this agent to X" hint needs an X to name; with
    // nothing resolved it would read "lock this agent to <blank>", which is a
    // warning about the wrong thing.
    expect(screen.queryByText(/inherited from the first active provider/i)).not.toBeInTheDocument();
  });
});
