// @vitest-environment happy-dom

/**
 * AgentForm — providers the org is not approved for (§120 t-745)
 *
 * The provider list arrives with `approvedForOrg` per row. A provider the org
 * may not use is offered disabled with its reason, as primary and as fallback,
 * rather than hidden — unless the agent already holds it, because the save
 * refuses only what a write introduces. At `single` every row is approved and
 * nothing is disabled.
 *
 * @see components/admin/orchestration/agent-form.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AgentForm, type AgentFormProps } from '@/components/admin/orchestration/agent-form';

vi.mock('next/navigation', async () => {
  const { createMockRouter } = await import('@/tests/types/mocks');
  return {
    useRouter: () => createMockRouter(),
    useSearchParams: () => ({ get: () => null }),
  };
});

vi.mock('@/lib/api/client', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

type Provider = NonNullable<AgentFormProps['providers']>[number];

function provider(slug: string, name: string, approvedForOrg?: boolean | null): Provider {
  return {
    id: `prov-${slug}`,
    name,
    slug,
    providerType: 'openai-compatible',
    apiKeyEnvVar: null,
    apiKeyPresent: true,
    isActive: true,
    isLocal: false,
    createdBy: 'system',
    createdAt: new Date(),
    updatedAt: new Date(),
    baseUrl: null,
    metadata: {},
    timeoutMs: null,
    maxRetries: null,
    jurisdiction: null,
    approvedForOrg,
  };
}

const MODELS = [
  { provider: 'anthropic', id: 'claude-opus-4-6', tier: 'frontier' },
  { provider: 'openai', id: 'gpt-4o', tier: 'frontier' },
];

const DEFAULTS = {
  provider: 'anthropic',
  model: 'claude-opus-4-6',
  inheritedProvider: true,
  inheritedModel: true,
};

async function renderModelTab(props: Partial<AgentFormProps> & Pick<AgentFormProps, 'providers'>) {
  const user = userEvent.setup();
  render(<AgentForm mode="create" models={MODELS} effectiveDefaults={DEFAULTS} {...props} />);
  await user.click(screen.getByRole('tab', { name: /model/i }));
  return user;
}

async function openProviderOptions(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('combobox', { name: /provider/i }));
  return screen.getByRole('listbox');
}

describe('AgentForm — providers the org is not approved for', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers a non-approved primary provider disabled, with the reason', async () => {
    const user = await renderModelTab({
      providers: [provider('anthropic', 'Anthropic', true), provider('openai', 'OpenAI', false)],
    });

    const listbox = await openProviderOptions(user);
    const openai = within(listbox).getByRole('option', { name: /OpenAI/ });
    expect(openai).toHaveAttribute('aria-disabled', 'true');
    expect(openai).toHaveTextContent('not approved for this organisation');
    expect(within(listbox).getByRole('option', { name: /Anthropic/ })).not.toHaveAttribute(
      'aria-disabled',
      'true'
    );
  });

  it('offers a non-approved fallback disabled, with the reason, and explains why', async () => {
    await renderModelTab({
      providers: [
        provider('anthropic', 'Anthropic', true),
        provider('openai', 'OpenAI', false),
        provider('voyage', 'Voyage', true),
      ],
    });

    const openai = screen.getByRole('checkbox', { name: /OpenAI/ });
    expect(openai).toBeDisabled();
    expect(openai.closest('label')).toHaveTextContent('not approved for this organisation');
    // Greyed, and the same size as its neighbours.
    expect(openai.closest('label')).toHaveClass('text-sm', 'text-muted-foreground');
    expect(screen.getByRole('checkbox', { name: /Voyage/ }).closest('label')).not.toHaveClass(
      'text-muted-foreground'
    );
    expect(screen.getByRole('checkbox', { name: /Voyage/ })).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'Why some providers are unavailable' })
    ).toBeInTheDocument();
  });

  it('keeps a provider the agent already holds selectable, so it can be kept or dropped', async () => {
    const user = userEvent.setup();
    const agent = {
      id: 'agent-1',
      slug: 'stranded',
      name: 'Stranded',
      provider: 'openai',
      model: 'gpt-4o',
      fallbackProviders: ['voyage'],
    } as unknown as AgentFormProps['agent'];
    render(
      <AgentForm
        mode="edit"
        agent={agent}
        models={MODELS}
        providers={[
          provider('anthropic', 'Anthropic', true),
          provider('openai', 'OpenAI', false),
          provider('voyage', 'Voyage', false),
          provider('mistral', 'Mistral', false),
        ]}
      />
    );
    await user.click(screen.getByRole('tab', { name: /model/i }));

    // Held fallback: still reported as not approved, but can be unticked.
    const voyage = screen.getByRole('checkbox', { name: /Voyage/ });
    expect(voyage).toBeEnabled();
    expect(voyage).toBeChecked();
    await user.click(voyage);
    expect(voyage).not.toBeChecked();
    // Not held: cannot be introduced.
    expect(screen.getByRole('checkbox', { name: /Mistral/ })).toBeDisabled();

    const listbox = await openProviderOptions(user);
    expect(within(listbox).getByRole('option', { name: /OpenAI/ })).not.toHaveAttribute(
      'aria-disabled',
      'true'
    );
    expect(within(listbox).getByRole('option', { name: /Mistral/ })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
  });

  it('offers every provider at single, where every row is approved', async () => {
    const user = await renderModelTab({
      providers: [
        provider('anthropic', 'Anthropic', true),
        provider('openai', 'OpenAI', true),
        provider('voyage', 'Voyage', true),
      ],
    });

    for (const name of [/OpenAI/, /Voyage/]) {
      expect(screen.getByRole('checkbox', { name })).toBeEnabled();
    }
    expect(screen.queryByText(/not approved for this organisation/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Why some providers are unavailable' })
    ).not.toBeInTheDocument();

    const listbox = await openProviderOptions(user);
    for (const option of within(listbox).getAllByRole('option')) {
      expect(option).not.toHaveAttribute('aria-disabled', 'true');
    }
  });

  it('leaves a provider whose approval is unknown to the save to judge', async () => {
    await renderModelTab({
      providers: [
        provider('anthropic', 'Anthropic', null),
        provider('openai', 'OpenAI', null),
        provider('voyage', 'Voyage'),
      ],
    });

    expect(screen.getByRole('checkbox', { name: /OpenAI/ })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: /Voyage/ })).toBeEnabled();
  });
});
