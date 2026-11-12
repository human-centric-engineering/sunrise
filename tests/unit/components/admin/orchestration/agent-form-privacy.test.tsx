// @vitest-environment happy-dom

/**
 * AgentForm — the agent's LLM privacy mode (§127 t-1010): a select on the
 * Model tab that only offers modes stricter than none, saves `null` to
 * inherit the install's mode, and shows a stored value it does not know as
 * inheriting rather than as a mode it is not.
 *
 * @see components/admin/orchestration/agent-form.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AgentForm } from '@/components/admin/orchestration/agent-form';
import type { AiAgent, AiProviderConfig } from '@/types/prisma';

vi.mock('next/navigation', async () => {
  const { createMockRouter } = await import('@/tests/types/mocks');
  return {
    useRouter: () => createMockRouter(),
    useSearchParams: () => ({ get: () => null }),
  };
});

// The real APIClientError, so the form reads `details` as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/client')>();
  return {
    ...actual,
    apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  };
});

const PROVIDERS = [
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
    apiKeyPresent: true,
  } as AiProviderConfig & { apiKeyPresent: boolean },
];
const MODELS = [{ provider: 'anthropic', id: 'claude-opus-4-6', tier: 'frontier' }];

function makeAgent(privacyMode: string | null = null): AiAgent {
  const agent: Partial<AiAgent> = {
    id: 'agent-1',
    name: 'Test Agent',
    slug: 'test-agent',
    description: 'A test agent',
    systemInstructions: 'Be helpful.',
    provider: 'anthropic',
    providerConfig: null,
    model: 'claude-opus-4-6',
    temperature: 0.7,
    maxTokens: 4096,
    monthlyBudgetUsd: null,
    isActive: true,
    isSystem: false,
    kind: 'chat',
    createdBy: 'system',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    systemInstructionsHistory: [],
    metadata: {},
    topicBoundaries: [],
    brandVoiceInstructions: null,
    rateLimitRpm: null,
    inputGuardMode: null,
    outputGuardMode: null,
    citationGuardMode: null,
    privacyMode,
    maxHistoryTokens: null,
    maxHistoryMessages: null,
    retentionDays: null,
    visibility: 'internal',
    deletedAt: null,
    fallbackProviders: [],
  };
  return agent as AiAgent;
}

async function openPrivacySelect(privacyMode: string | null) {
  const user = userEvent.setup();
  render(
    <AgentForm mode="edit" agent={makeAgent(privacyMode)} providers={PROVIDERS} models={MODELS} />
  );
  await user.click(screen.getByRole('tab', { name: 'Model' }));
  return user;
}

async function savedBody(user: ReturnType<typeof userEvent.setup>) {
  const { apiClient } = await import('@/lib/api/client');
  await user.click(screen.getByRole('button', { name: /save changes/i }));
  expect(apiClient.patch).toHaveBeenCalledTimes(1);
  return (vi.mocked(apiClient.patch).mock.calls[0][1] as { body: Record<string, unknown> }).body;
}

describe('AgentForm — LLM privacy mode', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockResolvedValue({});
  });

  it("shows the agent's mode and saves the one chosen", async () => {
    const user = await openPrivacySelect('redact');
    const select = screen.getByRole('combobox', { name: /llm privacy mode/i });
    expect(select).toHaveTextContent(/^Redact/);

    await user.click(select);
    await user.click(within(screen.getByRole('listbox')).getByRole('option', { name: /^Block/ }));

    expect(await savedBody(user)).toMatchObject({ privacyMode: 'block' });
  });

  it("saves null for the install's mode, and offers no 'off'", async () => {
    const user = await openPrivacySelect('pseudonymise');

    await user.click(screen.getByRole('combobox', { name: /llm privacy mode/i }));
    const names = within(screen.getByRole('listbox'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(names).not.toContain('Off');
    await user.click(
      within(screen.getByRole('listbox')).getByRole('option', { name: "Use the install's mode" })
    );

    expect(await savedBody(user)).toMatchObject({ privacyMode: null });
  });

  it('keeps a stored value that is not a mode when a save leaves the field alone, and says so', async () => {
    const user = await openPrivacySelect('off');

    expect(screen.getByRole('combobox', { name: /llm privacy mode/i })).toHaveTextContent(
      'Not a mode this version knows'
    );
    expect(screen.getByTestId('privacy-mode-unknown')).toHaveTextContent(
      'every call this agent makes is refused'
    );
    // Sending null would loosen the agent without anyone choosing to.
    expect(await savedBody(user)).not.toHaveProperty('privacyMode');
  });

  it("clears a stored value that is not a mode when the admin chooses the install's mode", async () => {
    const user = await openPrivacySelect('off');

    await user.click(screen.getByRole('combobox', { name: /llm privacy mode/i }));
    await user.click(
      within(screen.getByRole('listbox')).getByRole('option', { name: "Use the install's mode" })
    );

    expect(await savedBody(user)).toMatchObject({ privacyMode: null });
  });

  it('replaces a stored value that is not a mode once the admin chooses one', async () => {
    const user = await openPrivacySelect('off');

    await user.click(screen.getByRole('combobox', { name: /llm privacy mode/i }));
    await user.click(within(screen.getByRole('listbox')).getByRole('option', { name: /^Redact/ }));

    expect(screen.queryByTestId('privacy-mode-unknown')).not.toBeInTheDocument();
    expect(await savedBody(user)).toMatchObject({ privacyMode: 'redact' });
  });
});
