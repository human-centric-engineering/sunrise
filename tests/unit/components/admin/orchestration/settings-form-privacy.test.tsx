// @vitest-environment happy-dom

/**
 * Tests: the LLM privacy card on the orchestration settings form (§127).
 *
 * The card holds the types to PROTECT; the API stores the ones to leave
 * alone. A stored mode the page cannot show (one a later version wrote, or an
 * unreadable one) must survive a save of anything else. The embeddings
 * policy, and the warning that embeddings still go to a vendor (t-992).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  SettingsForm,
  type OrchestrationSettings,
} from '@/components/admin/orchestration/settings-form';
import { apiClient } from '@/lib/api/client';

vi.mock('@/lib/api/client', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

function settings(privacy: Partial<OrchestrationSettings> = {}): OrchestrationSettings {
  return {
    escalationVersion: '"v0"',
    inputGuardMode: 'log_only',
    outputGuardMode: 'log_only',
    citationGuardMode: 'log_only',
    globalMonthlyBudgetUsd: null,
    defaultMaxCostPerExecutionUsd: null,
    defaultMaxCostPerTurnUsd: null,
    defaultApprovalTimeoutMs: null,
    approvalDefaultAction: 'deny',
    searchConfig: null,
    webhookRetentionDays: null,
    webhookDlqRetentionDays: null,
    costLogRetentionDays: null,
    auditLogRetentionDays: null,
    executionRetentionDays: null,
    evaluationRetentionDays: null,
    maxConversationsPerUser: null,
    maxMessagesPerConversation: null,
    privacyMode: 'detect',
    privacyIgnoredEntityTypes: ['DATE', 'LOCATION'],
    privacyProtectLocalProviders: false,
    privacyEmbeddingsPolicy: 'allow',
    ...privacy,
  };
}

function card(): HTMLElement {
  const heading = screen.getByText('LLM privacy');
  const el = heading.closest('[data-slot="card"]') ?? heading.parentElement?.parentElement;
  if (!(el instanceof HTMLElement)) throw new Error('privacy card not found');
  return el;
}

async function save(): Promise<Record<string, unknown>> {
  vi.mocked(apiClient.patch).mockResolvedValue({});
  const form = screen.getByRole('button', { name: /save settings/i }).closest('form');
  await act(async () => {
    fireEvent.submit(form!);
  });
  await waitFor(() => expect(apiClient.patch).toHaveBeenCalled());
  const [, options] = vi.mocked(apiClient.patch).mock.calls[0];
  return (options as { body: Record<string, unknown> }).body;
}

beforeEach(() => vi.clearAllMocks());

describe('the LLM privacy card', () => {
  it('says plainly that this is not anonymisation', () => {
    render(<SettingsForm initialSettings={settings()} />);
    expect(within(card()).getByText(/it is not anonymisation/i)).toBeInTheDocument();
  });

  it('gives each of its seven fields a help popover', () => {
    render(<SettingsForm initialSettings={settings()} />);
    const help = within(card()).getAllByRole('button', { name: 'More information' });
    expect(help).toHaveLength(7);
    // One beside each field: the mode, the types, local providers, embeddings.
    expect(within(card()).getByText('Privacy mode').contains(help[0])).toBe(true);
    expect(within(card()).getByText('What to look for').contains(help[1])).toBe(true);
    expect(
      within(card())
        .getByText(/apply to local providers too/i)
        .contains(help[2])
    ).toBe(true);
    expect(within(card()).getByText('Embeddings').contains(help[3])).toBe(true);
    // And one beside each confidential-content group (§130).
    expect(within(card()).getByText('Personal').contains(help[4])).toBe(true);
    expect(within(card()).getByText('Commercial').contains(help[5])).toBe(true);
    // And the model a conversation moves to (t-1038).
    expect(within(card()).getByText('Model for confidential messages').contains(help[6])).toBe(
      true
    );
  });

  it('offers only the modes this version can apply', async () => {
    const user = userEvent.setup();
    render(<SettingsForm initialSettings={settings()} />);
    await user.click(screen.getByRole('combobox', { name: /privacy mode/i }));
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      'Off',
      'Detect (count only)',
      'Pseudonymise (placeholders, restored)',
      'Redact (placeholders, not restored)',
      'Block (refuse calls with personal data)',
    ]);
  });

  it('ticks every type but the ignored ones, and saves the unticked ones as ignored', async () => {
    const user = userEvent.setup();
    render(<SettingsForm initialSettings={settings()} />);
    expect(within(card()).getByRole('checkbox', { name: 'Other dates' })).not.toBeChecked();
    expect(within(card()).getByRole('checkbox', { name: 'Place names' })).not.toBeChecked();
    expect(within(card()).getByRole('checkbox', { name: 'Email addresses' })).toBeChecked();

    await user.click(within(card()).getByRole('checkbox', { name: 'Email addresses' }));
    await user.click(within(card()).getByRole('checkbox', { name: 'Place names' }));
    await user.click(within(card()).getByRole('checkbox', { name: /apply to local providers/i }));
    const body = await save();

    expect([...(body.privacyIgnoredEntityTypes as string[])].sort()).toEqual(['DATE', 'EMAIL']);
    expect(body.privacyProtectLocalProviders).toBe(true);
    expect(body.privacyMode).toBe('detect');
  });

  it("keeps a fork detector's ignored type it does not list", async () => {
    render(
      <SettingsForm initialSettings={settings({ privacyIgnoredEntityTypes: ['US_SSN', 'DATE'] })} />
    );
    const body = await save();
    expect([...(body.privacyIgnoredEntityTypes as string[])].sort()).toEqual(['DATE', 'US_SSN']);
  });

  it('leaves a stored mode it cannot show alone on a save of anything else, and says so', async () => {
    render(<SettingsForm initialSettings={settings({ privacyMode: 'quarantine' })} />);
    expect(within(card()).getByText(/not\s+one this page can show/i)).toHaveTextContent(
      'quarantine'
    );
    const body = await save();
    expect(body).not.toHaveProperty('privacyMode');
  });

  it.each(['Off', 'Detect (count only)'])(
    'replaces a stored mode it cannot show with %s, and drops the warning once saved',
    async (label) => {
      const user = userEvent.setup();
      render(<SettingsForm initialSettings={settings({ privacyMode: 'quarantine' })} />);
      await user.click(screen.getByRole('combobox', { name: /privacy mode/i }));
      await user.click(within(screen.getByRole('listbox')).getByRole('option', { name: label }));
      const body = await save();
      expect(body.privacyMode).toBe(label === 'Off' ? 'off' : 'detect');
      await waitFor(() =>
        expect(within(card()).queryByText(/not\s+one this page can show/i)).toBeNull()
      );
    }
  );

  it('offers keeping the stored mode, and a kept mode is not sent', async () => {
    const user = userEvent.setup();
    render(<SettingsForm initialSettings={settings({ privacyMode: 'quarantine' })} />);
    await user.click(screen.getByRole('combobox', { name: /privacy mode/i }));
    await user.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'Off' }));
    await user.click(screen.getByRole('combobox', { name: /privacy mode/i }));
    await user.click(
      within(screen.getByRole('listbox')).getByRole('option', {
        name: /keep the stored mode \(quarantine\)/i,
      })
    );
    const body = await save();
    expect(body).not.toHaveProperty('privacyMode');
  });

  it('replaces a stored mode it cannot show when the admin chooses one', async () => {
    const user = userEvent.setup();
    render(<SettingsForm initialSettings={settings({ privacyMode: null })} />);
    await user.click(screen.getByRole('combobox', { name: /privacy mode/i }));
    await user.click(within(screen.getByRole('listbox')).getByRole('option', { name: /detect/i }));
    const body = await save();
    expect(body.privacyMode).toBe('detect');
  });
});

describe('the embeddings policy', () => {
  it('starts at the stored policy and saves the one chosen', async () => {
    const user = userEvent.setup();
    render(<SettingsForm initialSettings={settings()} />);
    const select = screen.getByRole('combobox', { name: /embeddings/i });
    expect(select).toHaveTextContent('Allow any provider');
    await user.click(select);
    await user.click(
      within(screen.getByRole('listbox')).getByRole('option', { name: 'Local providers only' })
    );
    const body = await save();
    expect(body.privacyEmbeddingsPolicy).toBe('local_only');
  });

  const warning = () => screen.queryByTestId('privacy-embeddings-warning');

  it.each(['pseudonymise', 'redact', 'block'])(
    'warns under %s when embeddings go to a provider that is not local and the policy allows it',
    (mode) => {
      render(
        <SettingsForm
          initialSettings={settings({ privacyMode: mode })}
          embeddingProviderIsLocal={false}
        />
      );
      expect(warning()).toHaveTextContent(/not local/);
    }
  );

  it.each([
    ['the mode does not protect', { privacyMode: 'detect' }, false],
    [
      'the policy is local only',
      { privacyMode: 'pseudonymise', privacyEmbeddingsPolicy: 'local_only' },
      false,
    ],
    ['the provider is local', { privacyMode: 'pseudonymise' }, true],
    ['the provider is unknown', { privacyMode: 'pseudonymise' }, null],
    ['the stored mode is unreadable and kept', { privacyMode: null }, false],
  ] as const)('does not warn when %s', (_why, privacy, isLocal) => {
    render(<SettingsForm initialSettings={settings(privacy)} embeddingProviderIsLocal={isLocal} />);
    expect(warning()).toBeNull();
  });

  it('follows the mode as the admin changes it, before saving', async () => {
    const user = userEvent.setup();
    render(<SettingsForm initialSettings={settings()} embeddingProviderIsLocal={false} />);
    expect(warning()).toBeNull();
    await user.click(screen.getByRole('combobox', { name: /privacy mode/i }));
    await user.click(
      within(screen.getByRole('listbox')).getByRole('option', { name: /pseudonymise/i })
    );
    expect(warning()).not.toBeNull();
  });

  it('warns that every embedding will be refused when local only meets a model that is not local', () => {
    render(
      <SettingsForm
        initialSettings={settings({
          privacyMode: 'pseudonymise',
          privacyEmbeddingsPolicy: 'local_only',
        })}
        embeddingProviderIsLocal={false}
      />
    );
    expect(screen.getByTestId('privacy-embeddings-refused')).toHaveTextContent(/uploads fail/);
    expect(warning()).toBeNull();
  });

  it('does not warn of refusals when the embedding model is local', () => {
    render(
      <SettingsForm
        initialSettings={settings({
          privacyMode: 'pseudonymise',
          privacyEmbeddingsPolicy: 'local_only',
        })}
        embeddingProviderIsLocal={true}
      />
    );
    expect(screen.queryByTestId('privacy-embeddings-refused')).toBeNull();
  });
});

describe('confidential content (§130 t-1037)', () => {
  it('shows each group’s stored policy and saves both', async () => {
    render(
      <SettingsForm
        initialSettings={settings({
          privacyConfidentialPersonal: 'warn',
          privacyConfidentialCommercial: 'approved_only',
        })}
      />
    );
    expect(screen.getByRole('combobox', { name: /^personal/i })).toHaveTextContent(
      'Warn (send, then tell the user)'
    );
    expect(screen.getByRole('combobox', { name: /^commercial/i })).toHaveTextContent(
      'Trusted or local providers only'
    );
    expect(await save()).toMatchObject({
      privacyConfidentialPersonal: 'warn',
      privacyConfidentialCommercial: 'approved_only',
    });
  });

  it('offers every policy, allow included, and saves the one chosen', async () => {
    const user = userEvent.setup();
    render(<SettingsForm initialSettings={settings()} />);
    await user.click(screen.getByRole('combobox', { name: /^personal/i }));
    expect(
      within(screen.getByRole('listbox'))
        .getAllByRole('option')
        .map((o) => o.textContent)
    ).toEqual([
      'Allow (record only)',
      'Warn (send, then tell the user)',
      'Trusted or local providers only',
      'Local providers only',
      'Block (never send)',
    ]);
    await user.click(
      within(screen.getByRole('listbox')).getByRole('option', { name: 'Local providers only' })
    );
    expect(await save()).toMatchObject({ privacyConfidentialPersonal: 'local_only' });
  });

  it('reads a policy it does not know as block, never as something looser', () => {
    render(
      <SettingsForm initialSettings={settings({ privacyConfidentialCommercial: 'ask_first' })} />
    );
    expect(screen.getByRole('combobox', { name: /^commercial/i })).toHaveTextContent(
      'Block (never send)'
    );
  });

  it('says plainly what a phrase list misses', () => {
    render(<SettingsForm initialSettings={settings()} />);
    expect(screen.getByTestId('privacy-confidential-section')).toHaveTextContent(
      'misses what is only implied'
    );
  });
});

describe('the model for confidential messages (§130 t-1038)', () => {
  const OPTIONS = [
    {
      providerSlug: 'ollama-local',
      model: 'llama3.1:8b',
      label: 'Llama 3.1 8B on Ollama',
      where: 'local' as const,
    },
    {
      providerSlug: 'anthropic',
      model: 'claude-x',
      label: 'Claude X on Anthropic',
      where: 'trusted' as const,
    },
  ];
  const select = () => screen.getByRole('combobox', { name: /model for confidential messages/i });

  it('offers none, then the models on local or trusted providers, saying which', async () => {
    const user = userEvent.setup();
    render(<SettingsForm initialSettings={settings()} confidentialModelOptions={OPTIONS} />);
    expect(select()).toHaveTextContent('None: refuse instead');
    await user.click(select());
    expect(
      within(screen.getByRole('listbox'))
        .getAllByRole('option')
        .map((o) => o.textContent)
    ).toEqual([
      'None: refuse instead',
      'Llama 3.1 8B on Ollama (local)',
      'Claude X on Anthropic (trusted)',
    ]);
  });

  it('saves the one chosen as a provider and a model', async () => {
    const user = userEvent.setup();
    render(<SettingsForm initialSettings={settings()} confidentialModelOptions={OPTIONS} />);
    await user.click(select());
    await user.click(
      within(screen.getByRole('listbox')).getByRole('option', { name: /Llama 3.1 8B/ })
    );
    expect(await save()).toMatchObject({
      confidentialModel: { providerSlug: 'ollama-local', model: 'llama3.1:8b' },
    });
  });

  it('saves none as null, clearing it', async () => {
    const user = userEvent.setup();
    render(
      <SettingsForm
        initialSettings={settings({ confidentialModel: OPTIONS[1] })}
        confidentialModelOptions={OPTIONS}
      />
    );
    expect(select()).toHaveTextContent('Claude X on Anthropic (trusted)');
    await user.click(select());
    await user.click(
      within(screen.getByRole('listbox')).getByRole('option', { name: 'None: refuse instead' })
    );
    expect(await save()).toMatchObject({ confidentialModel: null });
  });

  it('does not send it when unchanged, so a model no longer usable cannot stop another save', async () => {
    const stale = { providerSlug: 'gone', model: 'old-model' };
    render(
      <SettingsForm
        initialSettings={settings({ confidentialModel: stale })}
        confidentialModelOptions={OPTIONS}
      />
    );
    // Shown as saved, and said to be no longer usable, rather than as none.
    expect(select()).toHaveTextContent('old-model (gone, no longer usable)');
    expect(await save()).not.toHaveProperty('confidentialModel');
  });

  it('says a policy that moves conversations, with no model, refuses instead', async () => {
    const user = userEvent.setup();
    render(<SettingsForm initialSettings={settings()} confidentialModelOptions={OPTIONS} />);
    expect(screen.queryByTestId('privacy-confidential-no-model')).toBeNull();

    await user.click(screen.getByRole('combobox', { name: /^personal/i }));
    await user.click(
      within(screen.getByRole('listbox')).getByRole('option', { name: 'Local providers only' })
    );
    expect(screen.getByTestId('privacy-confidential-no-model')).toHaveTextContent(
      'refused rather than moved'
    );

    await user.click(select());
    await user.click(
      within(screen.getByRole('listbox')).getByRole('option', { name: /Llama 3.1 8B/ })
    );
    expect(screen.queryByTestId('privacy-confidential-no-model')).toBeNull();
  });
});
