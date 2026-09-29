// @vitest-environment happy-dom

/**
 * AgentForm on a platform agent (§116 t-725).
 *
 * `GET /agents/:id` returns `platformAgent: { lockedFields, tunableFields,
 * bindingsLocked }` for a system agent, from the same rule the API enforces.
 * The form must:
 * - disable every group of controls whose fields are all locked, and leave
 *   the org's own (provider, model, spend, rate, retention) editable;
 * - never send a locked field on save, so a save the API would refuse for a
 *   field the admin never touched cannot happen;
 * - say in its banner what the org can change, naming the same fields;
 * - leave an org's own agent entirely editable.
 *
 * @see components/admin/orchestration/agent-form.tsx
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AgentForm, type AgentWithGrants } from '@/components/admin/orchestration/agent-form';
import { platformAgentFieldNames } from '@/lib/orchestration/agents/agent-field-registry';
import type { AiAgent } from '@/types/prisma';

vi.mock('next/navigation', async () => {
  const { createMockRouter } = await import('@/tests/types/mocks');
  return {
    useRouter: () => createMockRouter({ push: vi.fn() }),
    useSearchParams: () => ({ get: () => null }),
  };
});

vi.mock('@/lib/api/client', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

const MOCK_MODELS = [{ provider: 'anthropic', id: 'claude-opus-4-6', tier: 'frontier' }];

function makeAgent(overrides: Partial<AgentWithGrants> = {}): AgentWithGrants {
  return {
    id: 'agent-1',
    name: 'Pattern Advisor',
    slug: 'pattern-advisor',
    description: 'Explains the patterns',
    systemInstructions: 'You are the Pattern Advisor.',
    provider: 'anthropic',
    providerConfig: null,
    model: 'claude-opus-4-6',
    temperature: 0.7,
    maxTokens: 4096,
    monthlyBudgetUsd: null,
    isActive: true,
    isSystem: true,
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
    maxHistoryTokens: null,
    maxHistoryMessages: null,
    retentionDays: null,
    visibility: 'internal',
    deletedAt: null,
    fallbackProviders: [],
    grantedTagIds: ['tag-1'],
    grantedDocumentIds: [],
    platformAgent: {
      lockedFields: platformAgentFieldNames('code'),
      tunableFields: platformAgentFieldNames('org'),
      bindingsLocked: true,
    },
    ...overrides,
  } as AgentWithGrants & AiAgent;
}

function renderForm(agent: AgentWithGrants) {
  return render(<AgentForm mode="edit" agent={agent} providers={null} models={MOCK_MODELS} />);
}

describe('AgentForm — platform agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('disables the General group but leaves retention editable', () => {
    renderForm(makeAgent());

    expect(screen.getByRole('textbox', { name: /^name/i })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: /description/i })).toBeDisabled();
    expect(screen.getByRole('switch', { name: /active/i })).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: /retention/i })).toBeEnabled();
  });

  it('disables the platform settings on the Model tab but not provider, model or spend', async () => {
    const user = userEvent.setup();
    renderForm(makeAgent());

    await user.click(screen.getByRole('tab', { name: /^model$/i }));

    // Platform-owned
    expect(screen.getByRole('spinbutton', { name: /max output tokens/i })).toBeDisabled();
    expect(screen.getByRole('slider')).toHaveAttribute('data-disabled');
    expect(screen.getByRole('spinbutton', { name: /max history tokens/i })).toBeDisabled();
    // The org's
    expect(screen.getByRole('spinbutton', { name: /monthly budget/i })).toBeEnabled();
    expect(screen.getByRole('spinbutton', { name: /rate limit/i })).toBeEnabled();
    for (const id of ['provider', 'model']) {
      const control = document.getElementById(id);
      expect(control).not.toBeNull();
      expect(control).toBeEnabled();
      expect(control!.closest('[data-platform-locked]')).toBeNull();
    }
  });

  it('disables the whole Instructions tab', async () => {
    const user = userEvent.setup();
    renderForm(makeAgent());

    await user.click(screen.getByRole('tab', { name: /instructions/i }));

    expect(screen.getByRole('textbox', { name: /system instructions/i })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: /^persona/i })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: /topic boundaries/i })).toBeDisabled();
  });

  it('sends only what the org can change on save', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockResolvedValue({ id: 'agent-1' });
    const user = userEvent.setup();
    renderForm(makeAgent());

    await user.type(screen.getByRole('spinbutton', { name: /retention/i }), '30');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(apiClient.patch).toHaveBeenCalled());
    const body = (vi.mocked(apiClient.patch).mock.calls[0][1] as { body: Record<string, unknown> })
      .body;
    expect(body.retentionDays).toBe(30);
    for (const field of platformAgentFieldNames('code')) {
      expect(body).not.toHaveProperty(field);
    }
  });

  it('names what the org can change in its banner, from the API', () => {
    renderForm(makeAgent());

    const banner = screen.getByTestId('platform-agent-banner');
    expect(banner).toHaveTextContent('This is a platform agent');
    expect(banner).toHaveTextContent('knowledge and capabilities');
    for (const label of ['Model', 'Provider', 'Monthly budget (USD)', 'Retention (days)']) {
      expect(banner).toHaveTextContent(label);
    }
    // The old banner promised instruction editing the API refuses.
    expect(banner).not.toHaveTextContent(/editing instructions/i);
  });

  it("says mcp-system's capabilities are the org's when its bindings are", () => {
    renderForm(
      makeAgent({
        slug: 'mcp-system',
        platformAgent: {
          lockedFields: platformAgentFieldNames('code'),
          tunableFields: platformAgentFieldNames('org'),
          bindingsLocked: false,
        },
      })
    );

    const banner = screen.getByTestId('platform-agent-banner');
    expect(banner).not.toHaveTextContent('knowledge and capabilities');
    expect(banner).toHaveTextContent('which capabilities it may use');
  });

  it("leaves an org's own agent editable and sends its fields", async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockResolvedValue({ id: 'agent-1' });
    const user = userEvent.setup();
    const { container } = renderForm(
      makeAgent({ isSystem: false, slug: 'mine', platformAgent: null })
    );

    expect(container.querySelector('[data-platform-locked]')).toBeNull();
    expect(screen.queryByTestId('platform-agent-banner')).toBeNull();
    const name = screen.getByRole('textbox', { name: /^name/i });
    expect(name).toBeEnabled();

    await user.clear(name);
    await user.type(name, 'Renamed');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(apiClient.patch).toHaveBeenCalled());
    const body = (vi.mocked(apiClient.patch).mock.calls[0][1] as { body: Record<string, unknown> })
      .body;
    expect(body.name).toBe('Renamed');
    expect(body).toHaveProperty('systemInstructions');
  });

  it('marks exactly the locked groups', () => {
    const { container } = renderForm(makeAgent());

    const general = container.querySelectorAll('[data-platform-locked]');
    expect(general.length).toBeGreaterThan(0);
    // Retention sits outside every locked group.
    const retention = screen.getByRole('spinbutton', { name: /retention/i });
    expect(retention.closest('[data-platform-locked]')).toBeNull();
    expect(
      within(general[0] as HTMLElement).getByRole('textbox', { name: /^name/i })
    ).toBeDisabled();
  });
});
