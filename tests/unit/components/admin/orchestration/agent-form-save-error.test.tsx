// @vitest-environment happy-dom

/**
 * AgentForm — failed save (§124)
 *
 * The form's eight tabs unmount what they don't show, so a field the server
 * rejected can be on a tab that isn't showing. The save error must bring that
 * tab forward and focus the field, and sit in the sticky bar beside Save.
 *
 * @see components/admin/orchestration/agent-form.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

function makeAgent(): AiAgent {
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
    maxHistoryTokens: null,
    maxHistoryMessages: null,
    retentionDays: null,
    visibility: 'internal',
    deletedAt: null,
    fallbackProviders: [],
  };
  return agent as AiAgent;
}

/** `validateRequestBody`'s shape, as the PATCH route sends it. */
async function rejectWith(errors: Array<{ path: string; message: string }>) {
  const { apiClient, APIClientError } = await import('@/lib/api/client');
  vi.mocked(apiClient.patch).mockRejectedValue(
    new APIClientError('Invalid request body', 'VALIDATION_ERROR', 400, { errors })
  );
}

function renderForm() {
  render(<AgentForm mode="edit" agent={makeAgent()} providers={PROVIDERS} models={MODELS} />);
}

function field(name: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[name="${name}"]`);
  if (!el) throw new Error(`no field named ${name} on the page`);
  return el;
}

describe('AgentForm — failed save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows the failure in the sticky bar beside Save', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('Name already taken', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    renderForm();

    const save = screen.getByRole('button', { name: /save changes/i });
    await user.click(save);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Name already taken');
    // The bar is sticky, so the error stays in view with Save.
    const bar = alert.parentElement;
    expect(bar).toHaveClass('sticky');
    expect(bar).toContainElement(save);
    expect(alert).toHaveFocus();
  });

  it('brings forward the tab holding a field the server rejected, and focuses it', async () => {
    await rejectWith([{ path: 'systemInstructions', message: 'Too long for this model' }]);
    const user = userEvent.setup();
    renderForm();
    // On General; the field is on Instructions, not mounted.
    expect(document.querySelector('[name="systemInstructions"]')).toBeNull();

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(field('systemInstructions')).toHaveFocus());
    expect(screen.getByRole('tab', { name: /instructions/i })).toHaveAttribute(
      'data-state',
      'active'
    );
    expect(screen.getByText('Too long for this model')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('1 field needs fixing.');
  });

  it('with errors on two tabs, brings forward the earlier one and focuses its field', async () => {
    await rejectWith([
      { path: 'systemInstructions', message: 'Too long for this model' },
      { path: 'maxTokens', message: 'Above this model’s limit' },
    ]);
    const user = userEvent.setup();
    renderForm();
    await user.click(screen.getByRole('tab', { name: /instructions/i }));

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    // Model comes before Instructions, so it wins even from Instructions.
    await waitFor(() => expect(field('maxTokens')).toHaveFocus());
    expect(screen.getByRole('tab', { name: /^model/i })).toHaveAttribute('data-state', 'active');
    expect(screen.getByRole('alert')).toHaveTextContent('2 fields need fixing.');
  });

  it('says a rejected field that is not showing by Save, so its message is not lost', async () => {
    // Trigger keywords show only in keyword retrieval mode, which this agent
    // is not in: put under the field, the message would show nowhere.
    await rejectWith([{ path: 'knowledgeTriggerKeywords', message: 'At most 50 keywords' }]);
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('At most 50 keywords');
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('brings forward the tab of a field client validation blocked', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(screen.getByRole('tab', { name: /instructions/i }));
    await user.clear(screen.getByRole('textbox', { name: /^system instructions/i }));
    await user.click(screen.getByRole('tab', { name: /general/i }));

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(field('systemInstructions')).toHaveFocus());
    expect(screen.getByRole('alert')).toHaveTextContent(/cannot save/i);
    const { apiClient } = await import('@/lib/api/client');
    expect(apiClient.patch).not.toHaveBeenCalled();
  });
});
