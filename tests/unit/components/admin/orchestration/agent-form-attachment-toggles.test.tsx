/**
 * AgentForm — image / document attachment toggle gating
 *
 * Phase 6C: the toggles must reflect the capabilities of the currently
 * selected model. A model with no `'vision'` capability disables the
 * image toggle; same for `'documents'`. The saved on/off value is
 * preserved when disabled — switching back to a capable model restores
 * the operator's intent.
 *
 * Models with no capability metadata at all (registry-only entries
 * that don't have a matrix row) fall through to "enabled" — the
 * runtime gate is the authoritative check.
 *
 * @see components/admin/orchestration/agent-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AgentForm } from '@/components/admin/orchestration/agent-form';

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

const PROVIDERS = [
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
    timeoutMs: null,
    maxRetries: null,
  },
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
    timeoutMs: null,
    maxRetries: null,
  },
];

// Three models exercising every combination of vision/documents flags:
//   - Claude (vision + documents)
//   - Gemini-style (vision only, no documents)
//   - Plain text-only chat
// Plus an "unknown capabilities" variant that simulates a registry-only
// model with no matrix row → both toggles should default to enabled.
const MODELS = [
  {
    provider: 'anthropic',
    id: 'claude-sonnet-4',
    tier: 'frontier',
    capabilities: ['chat', 'vision', 'documents'],
  },
  {
    provider: 'openai',
    id: 'gpt-4o-mini',
    tier: 'budget',
    capabilities: ['chat', 'vision', 'documents'],
  },
  {
    provider: 'openai',
    id: 'gpt-3.5-turbo',
    tier: 'budget',
    capabilities: ['chat'], // no vision, no documents
  },
  {
    provider: 'openai',
    id: 'vision-only-model',
    tier: 'budget',
    capabilities: ['chat', 'vision'], // vision but no documents
  },
  {
    provider: 'openai',
    id: 'mystery-model',
    tier: 'budget',
    // No capabilities array at all — simulates a registry-only entry.
  },
];

function makeAgent(model: string, provider: string = 'openai') {
  return {
    id: 'agent-toggle-test',
    name: 'Toggle Test Agent',
    slug: 'toggle-test',
    description: 'fixture',
    systemInstructions: 'You help with stuff.',
    systemInstructionsHistory: [],
    model,
    provider,
    providerConfig: null,
    temperature: 0.7,
    maxTokens: 4096,
    monthlyBudgetUsd: null,
    metadata: null,
    isActive: true,
    inputGuardMode: null,
    outputGuardMode: null,
    citationGuardMode: null,
    rateLimitRpm: null,
    knowledgeCategories: [],
    topicBoundaries: [],
    brandVoiceInstructions: null,
    visibility: 'internal',
    fallbackProviders: [],
    maxHistoryTokens: null,
    retentionDays: null,
    widgetConfig: null,
    enableVoiceInput: false,
    enableImageInput: false,
    enableDocumentInput: false,
    deletedAt: null,
    isSystem: false,
    createdBy: 'u',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Parameters<typeof AgentForm>[0]['agent'];
}

async function openModelTab() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('tab', { name: /model/i }));
  return user;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AgentForm — attachment toggle gating by current model', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('enables both toggles when the current model has vision + documents', async () => {
    render(
      <AgentForm
        mode="edit"
        agent={makeAgent('gpt-4o-mini')}
        providers={PROVIDERS}
        models={MODELS}
      />
    );
    await openModelTab();

    expect(screen.getByRole('switch', { name: /enable image input/i })).not.toBeDisabled();
    expect(screen.getByRole('switch', { name: /enable document/i })).not.toBeDisabled();
  });

  it('disables BOTH toggles when the current model lacks vision and documents', async () => {
    render(
      <AgentForm
        mode="edit"
        agent={makeAgent('gpt-3.5-turbo')}
        providers={PROVIDERS}
        models={MODELS}
      />
    );
    await openModelTab();

    expect(screen.getByRole('switch', { name: /enable image input/i })).toBeDisabled();
    expect(screen.getByRole('switch', { name: /enable document/i })).toBeDisabled();
  });

  it('disables only the document toggle on a vision-only model (e.g., Gemini)', async () => {
    render(
      <AgentForm
        mode="edit"
        agent={makeAgent('vision-only-model')}
        providers={PROVIDERS}
        models={MODELS}
      />
    );
    await openModelTab();

    expect(screen.getByRole('switch', { name: /enable image input/i })).not.toBeDisabled();
    expect(screen.getByRole('switch', { name: /enable document/i })).toBeDisabled();
  });

  it('falls through to enabled when the model has no capability metadata at all', async () => {
    // Registry-only models that don't carry a matrix row arrive without
    // a `capabilities` array. We default-allow rather than default-deny
    // so operators aren't locked out of working configurations the
    // matrix simply hasn't been told about yet.
    render(
      <AgentForm
        mode="edit"
        agent={makeAgent('mystery-model')}
        providers={PROVIDERS}
        models={MODELS}
      />
    );
    await openModelTab();

    expect(screen.getByRole('switch', { name: /enable image input/i })).not.toBeDisabled();
    expect(screen.getByRole('switch', { name: /enable document/i })).not.toBeDisabled();
  });

  it("preserves the toggle's saved on/off state when disabled (model swap doesn't reset intent)", async () => {
    // Agent was saved with image input on but a text-only model. The
    // toggle should render visually CHECKED (preserving operator
    // intent) but DISABLED (matching the current model's capability).
    // If the user switches the model back to one with vision, the
    // toggle re-enables in its on state.
    const agent = makeAgent('gpt-3.5-turbo');
    agent!.enableImageInput = true;
    agent!.enableDocumentInput = true;

    render(<AgentForm mode="edit" agent={agent} providers={PROVIDERS} models={MODELS} />);
    await openModelTab();

    const imageSwitch = screen.getByRole('switch', { name: /enable image input/i });
    const docSwitch = screen.getByRole('switch', { name: /enable document/i });

    // Both disabled (model lacks both capabilities)…
    expect(imageSwitch).toBeDisabled();
    expect(docSwitch).toBeDisabled();
    // …but their CHECKED state is preserved.
    expect(imageSwitch).toHaveAttribute('aria-checked', 'true');
    expect(docSwitch).toHaveAttribute('aria-checked', 'true');
  });

  it('explanation copy adapts when the toggle is disabled', async () => {
    // When the toggle is disabled because the model can't handle the
    // modality, the description below it should point the operator at
    // the Model tab rather than describing the feature as available.
    render(
      <AgentForm
        mode="edit"
        agent={makeAgent('gpt-3.5-turbo')}
        providers={PROVIDERS}
        models={MODELS}
      />
    );
    await openModelTab();

    expect(screen.getByText(/current model doesn't support image input/i)).toBeInTheDocument();
    expect(screen.getByText(/current model doesn't support PDF input/i)).toBeInTheDocument();
  });
});
