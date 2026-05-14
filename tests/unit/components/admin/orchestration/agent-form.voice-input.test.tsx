/**
 * AgentForm — Voice input toggle (Tab 2, Model)
 *
 * Covers:
 * - Toggle is rendered on the Model tab with the correct label
 * - Default value reflects `agent.enableVoiceInput`
 * - Toggling changes the form's dirty state and the persisted value on save
 *
 * @see components/admin/orchestration/agent-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AgentForm } from '@/components/admin/orchestration/agent-form';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
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
    patch: vi.fn().mockResolvedValue({}),
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

const MOCK_PROVIDERS = [
  {
    id: 'prov-1',
    name: 'Anthropic',
    slug: 'anthropic',
    providerType: 'anthropic',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
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

const MOCK_MODELS = [{ provider: 'anthropic', id: 'claude-opus-4-6', tier: 'frontier' }];

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent-1',
    name: 'Sample',
    slug: 'sample',
    description: 'desc',
    systemInstructions: 'you are helpful',
    provider: 'anthropic',
    providerConfig: null,
    model: 'claude-opus-4-6',
    temperature: 0.7,
    maxTokens: 4096,
    monthlyBudgetUsd: null,
    isActive: true,
    isSystem: false,
    createdBy: 'system',
    createdAt: new Date(),
    updatedAt: new Date(),
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
    maxHistoryMessages: null,
    retentionDays: null,
    visibility: 'internal',
    deletedAt: null,
    fallbackProviders: [],
    widgetConfig: null,
    enableVoiceInput: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AgentForm — voice input toggle', () => {
  it('renders the toggle on the Model tab with descriptive copy', async () => {
    const user = userEvent.setup();
    render(
      <AgentForm
        mode="edit"
        agent={makeAgent() as never}
        providers={MOCK_PROVIDERS}
        models={MOCK_MODELS}
      />
    );

    await user.click(screen.getByRole('tab', { name: /model/i }));

    await waitFor(() => {
      expect(screen.getByRole('switch', { name: /enable voice input/i })).toBeInTheDocument();
    });
    expect(screen.getByText(/lets users speak instead of typing/i)).toBeInTheDocument();
  });

  it('reflects the current agent value (off by default)', async () => {
    const user = userEvent.setup();
    render(
      <AgentForm
        mode="edit"
        agent={makeAgent({ enableVoiceInput: false }) as never}
        providers={MOCK_PROVIDERS}
        models={MOCK_MODELS}
      />
    );

    await user.click(screen.getByRole('tab', { name: /model/i }));

    const toggle = await screen.findByRole('switch', { name: /enable voice input/i });
    expect(toggle.getAttribute('data-state')).toBe('unchecked');
  });

  it('reflects an agent that already has voice input enabled', async () => {
    const user = userEvent.setup();
    render(
      <AgentForm
        mode="edit"
        agent={makeAgent({ enableVoiceInput: true }) as never}
        providers={MOCK_PROVIDERS}
        models={MOCK_MODELS}
      />
    );

    await user.click(screen.getByRole('tab', { name: /model/i }));

    const toggle = await screen.findByRole('switch', { name: /enable voice input/i });
    expect(toggle.getAttribute('data-state')).toBe('checked');
  });

  it('persists `enableVoiceInput: true` to the API on save', async () => {
    const user = userEvent.setup();
    const { apiClient } = await import('@/lib/api/client');
    render(
      <AgentForm
        mode="edit"
        agent={makeAgent() as never}
        providers={MOCK_PROVIDERS}
        models={MOCK_MODELS}
      />
    );

    await user.click(screen.getByRole('tab', { name: /model/i }));
    const toggle = await screen.findByRole('switch', { name: /enable voice input/i });
    await user.click(toggle);

    const saveButton = screen.getByRole('button', { name: /save changes/i });
    await user.click(saveButton);

    await waitFor(() => expect(apiClient.patch).toHaveBeenCalled());
    const call = vi.mocked(apiClient.patch).mock.calls[0];
    const options = call?.[1] as { body: Record<string, unknown> };
    expect(options.body).toMatchObject({ enableVoiceInput: true });
  });
});
