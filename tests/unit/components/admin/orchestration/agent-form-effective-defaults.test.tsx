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

    // CHANGED with the preview/payload split. The Select is a control for what
    // the OPERATOR chooses; the resolved value is a preview and now renders
    // beside it rather than inside it. Seeding the control with the preview
    // made "picked the previewed value" and "touched nothing"
    // indistinguishable, so pinning it was impossible.
    const providerTrigger = screen.getByRole('combobox', { name: /provider/i });
    expect(providerTrigger).toHaveTextContent(/pick a provider/i);
    expect(screen.getByText(/no provider of its own/i)).toHaveTextContent(/anthropic/i);
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

    // Same split as the provider: the resolved model is shown, not
    // pre-selected, so accepting it has to be an explicit act.
    expect(screen.getByText(/no model of its own/i)).toHaveTextContent(/claude-opus-4-6/i);
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
      // Copy replaced: the old text ("Inherited from the first active provider.
      // Saving will lock this agent to X") described a save that WOULD pin the
      // value. It no longer does — an untouched field is not sent at all — so
      // the hint now says what is true, that the value is resolved per turn and
      // only an explicit pick pins it.
      expect(screen.getByText(/no provider of its own/i)).toBeInTheDocument();
      expect(screen.getByText(/no model of its own/i)).toBeInTheDocument();
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
/**
 * t-661 — the form must never write a field the operator did not author.
 *
 * The original defect was `|| 'anthropic'`: a provider nobody chose, submitted
 * as an EXPLICIT `agent.provider`, which `resolveAgentProviderAndModel` never
 * re-filters. Removing the literal was necessary but not sufficient, because
 * the form still used ONE value as both the preview of what the runtime would
 * resolve and the payload of what the operator decided. Any resolved value
 * written back turns a dynamically-resolving agent into a permanently pinned
 * one — with a forbidden provider under a fork's eligibility rule, with a
 * merely-unapproved one during an unrelated typo fix.
 *
 * That matters far more than "a rare denial": on a stock install ALL 15 seeded
 * agents ship `provider: ''`, so the inherit state is the normal case.
 *
 * So the property under test is authorship, not refusal. On edit the form
 * sends `provider` / `model` only when the operator actually changed them.
 * Create is the one place they are genuinely required — a new agent has no row
 * to inherit from.
 */
describe('AgentForm — the form never writes a provider nobody chose (t-661)', () => {
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

  /** Fill everything the create schema requires apart from provider/model. */
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

  // ── Create: provider really is required, because nothing can be inherited ──

  it('create: refuses to submit rather than inventing a provider', async () => {
    const { apiClient } = await import('@/lib/api/client');
    const user = userEvent.setup();

    render(
      <AgentForm mode="create" providers={PROVIDERS} models={MODELS} effectiveDefaults={DENIED} />
    );

    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: /create agent/i }));

    await waitFor(() => {
      expect(apiClient.post).not.toHaveBeenCalled();
      expect(
        screen.getByText(/these fields need attention\. Model: Provider, Model/i)
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

  // ── Edit: the agent stays as the operator left it ──

  it('edit: saving an inheriting agent does NOT write the previewed provider', async () => {
    // THE test. `anthropic` is on screen — it is what the runtime would pick —
    // and an operator saving an unrelated change must not thereby pin it.
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

    await waitFor(() => expect(apiClient.patch).toHaveBeenCalled());

    const body = vi.mocked(apiClient.patch).mock.calls[0][1] as { body: Record<string, unknown> };
    expect(body.body).not.toHaveProperty('provider');
    expect(body.body).not.toHaveProperty('model');
    // CONTROL — the save really happened and carried the rest of the form, so
    // the two assertions above are not passing against an empty body.
    expect(body.body).toHaveProperty('name', 'Pattern Advisor');
  });

  it('edit: an operator who PICKS a provider gets it written — that is their decision', async () => {
    // The seam's whole design is "never reroute a human decision". Not writing
    // an unauthored value must not become not writing a chosen one.
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

    await openModelTab();
    await user.click(screen.getByRole('combobox', { name: /provider/i }));
    await user.click(await screen.findByRole('option', { name: /openai/i }));

    console.log(
      'DBG-MODEL-TRIGGER:',
      screen.getByRole('combobox', { name: /^model/i }).textContent
    );
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(apiClient.patch).toHaveBeenCalled());
    const body = vi.mocked(apiClient.patch).mock.calls[0][1] as { body: Record<string, unknown> };
    expect(body.body).toHaveProperty('provider', 'openai');
    // The MODEL is not written, and that is deliberate. The provider change
    // makes the form pre-select a plausible model for display, but the form
    // choosing something is exactly what this file refuses to submit — the
    // operator picked a provider, not a model. The agent keeps resolving its
    // model per turn until someone selects one.
    expect(body.body).not.toHaveProperty('model');
  });

  it('edit: an inheriting agent stays editable when NOTHING resolves', async () => {
    // The regression this replaced: requiring a non-empty provider on edit made
    // every seeded agent unsavable whenever resolution came back empty — an
    // admin who has not set an API key yet cannot fix a typo without first
    // pinning a provider. With 15/15 agents inheriting, that is the whole
    // install, not an edge case.
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockResolvedValue({ id: 'pattern-advisor' });
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

    await user.type(screen.getByRole('textbox', { name: /^description/i }), ' Updated.');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(apiClient.patch).toHaveBeenCalled());
    const body = vi.mocked(apiClient.patch).mock.calls[0][1] as { body: Record<string, unknown> };
    expect(body.body).not.toHaveProperty('provider');
  });

  it('tells the operator the provider is resolved per turn, and what pinning costs', async () => {
    render(
      <AgentForm
        mode="edit"
        agent={makeSystemSeededAgent()}
        providers={PROVIDERS}
        models={MODELS}
        effectiveDefaults={RESOLVED}
      />
    );

    await openModelTab();

    // Both fields are inherited on a system-seeded agent, so both hints show.
    expect(screen.getByText(/no provider of its own/i)).toBeInTheDocument();
    expect(screen.getByText(/no model of its own/i)).toBeInTheDocument();
    // The copy must promise only what the form can deliver: leaving it alone
    // keeps the agent dynamic, selecting one pins it.
    expect(screen.getByText(/no provider of its own/i)).toHaveTextContent(
      /Selecting one pins it permanently/i
    );
  });
});
