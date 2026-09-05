// @vitest-environment happy-dom

/**
 * AgentForm — the form must still be savable after a version restore.
 *
 * `AgentVersionHistoryTab` calls `onRestored()` after a successful restore, and
 * the parent re-pulls the agent and `reset(...)`s the form with it. RHF's
 * `reset(values)` REPLACES form state wholesale rather than merging, so every
 * field `agentFormSchema` requires must appear in that object — ten did not,
 * seven of them required enums or booleans, and the result was a form that
 * could never be saved again after a restore.
 *
 * `agent-form-reset-parity.test.ts` guards the same property by reading the
 * source, which is the cheap check that catches drift. This one drives the
 * actual handler, so it fails for the real reason (the save does not happen)
 * rather than because two lists disagree.
 *
 * The version-history tab itself is stubbed down to a single button: this is a
 * test of the PARENT's restore handler, and driving the real child would mean
 * mocking a version list, a confirm dialog and a restore POST to reach one
 * callback.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AgentForm } from '@/components/admin/orchestration/agent-form';
import type { EffectiveAgentDefaults } from '@/lib/orchestration/prefetch-helpers';
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
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
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

vi.mock('@/components/admin/orchestration/agent-version-history-tab', () => ({
  AgentVersionHistoryTab: ({ onRestored }: { onRestored?: () => void }) => (
    <button type="button" onClick={() => onRestored?.()}>
      simulate restore
    </button>
  ),
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
];

const MODELS = [{ provider: 'anthropic', id: 'claude-opus-4-6', tier: 'frontier' }];

function makeAgent(overrides: Partial<AiAgent> = {}): AiAgent {
  return {
    id: 'agent-1',
    name: 'Support Bot',
    slug: 'support-bot',
    description: 'Answers questions.',
    systemInstructions: 'Be helpful.',
    provider: 'anthropic',
    providerConfig: null,
    model: 'claude-opus-4-6',
    temperature: 0.7,
    maxTokens: 4096,
    reasoningEffort: null,
    monthlyBudgetUsd: null,
    maxCostPerTurnUsd: null,
    isActive: true,
    isSystem: false,
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
    ...overrides,
  } as AiAgent;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AgentForm — save after a version restore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function restoreThenSave(fresh: AiAgent, effectiveDefaults?: EffectiveAgentDefaults) {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(fresh);
    vi.mocked(apiClient.patch).mockResolvedValue({ id: fresh.id });

    const user = userEvent.setup();
    render(
      <AgentForm
        mode="edit"
        agent={makeAgent(effectiveDefaults ? { provider: '', model: '' } : {})}
        providers={PROVIDERS}
        models={MODELS}
        effectiveDefaults={effectiveDefaults}
      />
    );

    await user.click(screen.getByRole('tab', { name: /versions/i }));
    await user.click(screen.getByRole('button', { name: /simulate restore/i }));
    await waitFor(() => expect(apiClient.get).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: /save changes/i }));
    return { apiClient, user };
  }

  it('a restored agent can still be saved', async () => {
    // The regression: `reset()` omitted ten fields, seven of them required
    // enums/booleans, so this save silently did nothing at all.
    const { apiClient } = await restoreThenSave(
      makeAgent({ name: 'Restored Bot', systemInstructions: 'Older instructions.' })
    );

    await waitFor(() => {
      expect(apiClient.patch).toHaveBeenCalledWith(
        expect.stringContaining('agent-1'),
        expect.objectContaining({
          body: expect.objectContaining({
            name: 'Restored Bot',
            systemInstructions: 'Older instructions.',
          }),
        })
      );
    });
  });

  it('carries the restored values for every field reset() sets, not just the visible ones', async () => {
    // Each of these was `undefined` after a restore before the fix. They are
    // asserted by VALUE rather than merely "the save happened", so a reset that
    // dropped one back to a default would fail here too.
    const { apiClient } = await restoreThenSave(
      makeAgent({
        personaMode: 'append',
        voiceMode: 'append',
        guardrailsMode: 'append',
        enableVoiceInput: true,
        enableImageInput: true,
        enableDocumentInput: true,
        persona: 'A terse reviewer.',
        guardrails: 'Never speculate.',
      })
    );

    await waitFor(() => {
      expect(apiClient.patch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          body: expect.objectContaining({
            personaMode: 'append',
            voiceMode: 'append',
            guardrailsMode: 'append',
            enableVoiceInput: true,
            enableImageInput: true,
            enableDocumentInput: true,
            persona: 'A terse reviewer.',
            guardrails: 'Never speculate.',
          }),
        })
      );
    });
  });

  it('never sends `kind` on edit, so an agent of an unlisted kind stays savable', async () => {
    // `AiAgent.kind` is a free String column — `prisma/seeds/017` seeds
    // 'generator' — while the API's PATCH schema is
    // `z.enum(['chat','judge']).optional()`. The form renders no control for
    // `kind`, so echoing the row's own value back would 400 for any other
    // kind and leave that agent permanently unsavable. Omitting it leaves the
    // column alone, which is what "this form does not edit that field" has to
    // mean on the wire too.
    const { apiClient } = await restoreThenSave(makeAgent({ kind: 'generator' }));

    await waitFor(() => expect(apiClient.patch).toHaveBeenCalled());

    const body = vi.mocked(apiClient.patch).mock.calls[0][1] as { body: Record<string, unknown> };
    expect(body.body).not.toHaveProperty('kind');
    // CONTROL — the save really did carry the rest of the form, so the
    // assertion above is not passing on an empty body.
    expect(body.body).toHaveProperty('name', 'Support Bot');
  });

  it('restoring an inheriting agent does not blank its resolved provider', async () => {
    // A restore returns the ROW's values, and a system-seeded agent's row holds
    // '' — the dynamic-resolution contract, not an absence of configuration.
    // Writing that raw blanked the Select, fired the "no provider could be
    // resolved" hint (false — resolution had just succeeded on this very page),
    // and then `onInvalid` blocked the save until the operator pinned a
    // provider onto an agent designed to resolve one per turn. That is this
    // PR's own defect, reached from the other direction.
    const { apiClient } = await restoreThenSave(makeAgent({ provider: '', model: '' }), {
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      inheritedProvider: true,
      inheritedModel: true,
    });

    await waitFor(() => {
      expect(apiClient.patch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          body: expect.objectContaining({ provider: 'anthropic', model: 'claude-opus-4-6' }),
        })
      );
    });

    expect(
      screen.queryByText(/no provider could be resolved automatically/i)
    ).not.toBeInTheDocument();
  });

  it('falls back safely when the restored row carries nulls', async () => {
    // Covers the `??` arms — a version restored from a row whose optional
    // columns are null must still produce a schema-valid form.
    const { apiClient } = await restoreThenSave(
      makeAgent({
        monthlyBudgetUsd: null,
        maxCostPerTurnUsd: null,
        rateLimitRpm: null,
        maxHistoryTokens: null,
        maxHistoryMessages: null,
        retentionDays: null,
        runtimePromptNote: null,
        brandVoiceInstructions: null,
        fallbackProviders: [],
      })
    );

    await waitFor(() => expect(apiClient.patch).toHaveBeenCalled());
  });
});
