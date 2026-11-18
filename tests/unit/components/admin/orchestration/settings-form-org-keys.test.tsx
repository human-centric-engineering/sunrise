// @vitest-environment happy-dom

/**
 * Tests: the switch for organisations' own AI keys on the orchestration
 * settings form (§137 t-1044).
 *
 * Shown at `multi` only. It cannot be turned on without a master key (the API
 * refuses it too), and a page loaded with it on must still save everything
 * else when the master key has since gone, so it is sent only when changed.
 * Turning it off while orgs hold keys says what that will refuse.
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

function settings(overrides: Partial<OrchestrationSettings> = {}): OrchestrationSettings {
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
    privacyMode: 'off',
    privacyIgnoredEntityTypes: [],
    privacyProtectLocalProviders: false,
    privacyEmbeddingsPolicy: 'allow',
    orgProviderKeysEnabled: false,
    orgsWithProviderKeys: 0,
    sealedSecretKeyConfigured: true,
    ...overrides,
  };
}

function section(): HTMLElement {
  return screen.getByTestId('org-provider-keys-section');
}

function toggle(): HTMLInputElement {
  return within(section()).getByRole('checkbox', {
    name: /let organisations use their own ai keys/i,
  });
}

async function save(): Promise<Record<string, unknown>> {
  vi.mocked(apiClient.patch).mockResolvedValue({});
  const form = screen.getByRole('button', { name: /save settings/i }).closest('form');
  await act(async () => {
    fireEvent.submit(form!);
  });
  await waitFor(() => expect(apiClient.patch).toHaveBeenCalled());
  const [, options] = vi.mocked(apiClient.patch).mock.calls.at(-1)!;
  return (options as { body: Record<string, unknown> }).body;
}

beforeEach(() => vi.clearAllMocks());

describe("the switch for organisations' own AI keys", () => {
  it('is not shown at single, where it would change nothing', () => {
    render(<SettingsForm initialSettings={settings()} />);
    expect(screen.queryByTestId('org-provider-keys-section')).toBeNull();
  });

  it('is shown at multi, off by default, with a help popover', () => {
    render(<SettingsForm initialSettings={settings()} showOrgProviderKeys />);
    expect(toggle()).not.toBeChecked();
    expect(within(section()).getByRole('button', { name: 'More information' })).toBeInTheDocument();
  });

  it('is sent when turned on, and only then', async () => {
    const user = userEvent.setup();
    render(<SettingsForm initialSettings={settings()} showOrgProviderKeys />);

    expect(await save()).not.toHaveProperty('orgProviderKeysEnabled');

    await user.click(toggle());
    expect(await save()).toMatchObject({ orgProviderKeysEnabled: true });
  });

  it('cannot be turned on with no master key configured, and says why', () => {
    render(
      <SettingsForm
        initialSettings={settings({ sealedSecretKeyConfigured: false })}
        showOrgProviderKeys
      />
    );
    expect(toggle()).toBeDisabled();
    expect(screen.getByTestId('org-provider-keys-no-master')).toHaveTextContent(
      /SEALED_SECRET_KEYS/
    );
  });

  it('can still be turned off, and other settings saved, once the master key has gone', async () => {
    const user = userEvent.setup();
    render(
      <SettingsForm
        initialSettings={settings({
          orgProviderKeysEnabled: true,
          sealedSecretKeyConfigured: false,
        })}
        showOrgProviderKeys
      />
    );
    expect(toggle()).toBeEnabled();
    // A save of anything else does not resend `true`, which the API would refuse.
    expect(await save()).not.toHaveProperty('orgProviderKeysEnabled');

    await user.click(toggle());
    expect(await save()).toMatchObject({ orgProviderKeysEnabled: false });
  });

  it('lets an accidental untick be undone when the master key has gone', async () => {
    const user = userEvent.setup();
    render(
      <SettingsForm
        initialSettings={settings({
          orgProviderKeysEnabled: true,
          sealedSecretKeyConfigured: false,
        })}
        showOrgProviderKeys
      />
    );

    await user.click(toggle());
    expect(toggle()).toBeEnabled();
    await user.click(toggle());

    expect(toggle()).toBeChecked();
    expect(await save()).not.toHaveProperty('orgProviderKeysEnabled');
  });

  it('says the count is unknown, rather than nothing, when it could not be read', async () => {
    const user = userEvent.setup();
    render(
      <SettingsForm
        initialSettings={settings({ orgProviderKeysEnabled: true, orgsWithProviderKeys: null })}
        showOrgProviderKeys
      />
    );
    await user.click(toggle());
    expect(screen.getByTestId('org-provider-keys-turning-off')).toHaveTextContent(
      /could not be read/
    );
  });

  it('says how many orgs turning it off will refuse, before it is saved', async () => {
    const user = userEvent.setup();
    render(
      <SettingsForm
        initialSettings={settings({ orgProviderKeysEnabled: true, orgsWithProviderKeys: 3 })}
        showOrgProviderKeys
      />
    );
    expect(screen.queryByTestId('org-provider-keys-turning-off')).toBeNull();

    await user.click(toggle());

    const warning = screen.getByTestId('org-provider-keys-turning-off');
    expect(warning).toHaveTextContent('3 organisations have saved their own keys');
    expect(warning).toHaveTextContent(/refused until it is turned back on/);
  });

  it('says nothing when no org holds a key', async () => {
    const user = userEvent.setup();
    render(
      <SettingsForm
        initialSettings={settings({ orgProviderKeysEnabled: true, orgsWithProviderKeys: 0 })}
        showOrgProviderKeys
      />
    );
    await user.click(toggle());
    expect(screen.queryByTestId('org-provider-keys-turning-off')).toBeNull();
  });
});
