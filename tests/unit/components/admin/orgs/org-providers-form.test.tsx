// @vitest-environment happy-dom

/**
 * OrgProvidersForm (§120 t-745) — a platform admin edits an org's approved
 * providers and jurisdictions through `PUT /api/v1/admin/orgs/[id]/providers`.
 *
 * @see components/admin/orgs/org-providers-form.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  OrgProvidersForm,
  type OrgProviderOption,
  type OrgProviderPolicyView,
} from '@/components/admin/orgs/org-providers-form';
import { apiClient } from '@/lib/api/client';

vi.mock('@/lib/api/client', () => ({
  apiClient: { put: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

const ORG = 'cmorg00000000000000grant';

const PROVIDERS: OrgProviderOption[] = [
  { id: 'id-anthropic', slug: 'anthropic', name: 'Anthropic', isActive: true, jurisdiction: 'US' },
  { id: 'id-mistral', slug: 'mistral', name: 'Mistral', isActive: true, jurisdiction: 'EU' },
  { id: 'id-local', slug: 'local', name: 'Local', isActive: false, jurisdiction: null },
];

function policy(overrides: Partial<OrgProviderPolicyView> = {}): OrgProviderPolicyView {
  return {
    orgId: ORG,
    unrestricted: false,
    enforced: true,
    approved: [{ id: 'id-anthropic', slug: 'anthropic' }],
    jurisdictions: null,
    ...overrides,
  };
}

function renderForm(view: OrgProviderPolicyView = policy()) {
  const user = userEvent.setup();
  render(<OrgProvidersForm orgId={ORG} policy={view} providers={PROVIDERS} />);
  return user;
}

describe('OrgProvidersForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ticks the providers the org is approved for, and only those', () => {
    renderForm();
    expect(screen.getByRole('checkbox', { name: /Anthropic/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Mistral/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Local/ })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: /Restrict to jurisdictions/ })).not.toBeChecked();
  });

  it('replaces the policy by slug and shows what the API saved', async () => {
    vi.mocked(apiClient.put).mockResolvedValue(
      policy({
        approved: [
          { id: 'id-anthropic', slug: 'anthropic' },
          { id: 'id-mistral', slug: 'mistral' },
        ],
      })
    );
    const user = renderForm();

    await user.click(screen.getByRole('checkbox', { name: /Mistral/ }));
    await user.click(screen.getByRole('button', { name: 'Save approved providers' }));

    expect(apiClient.put).toHaveBeenCalledWith(`/api/v1/admin/orgs/${ORG}/providers`, {
      body: { approved: ['anthropic', 'mistral'], jurisdictions: null },
    });
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Mistral/ })).toBeChecked();
  });

  it('sends the jurisdictions when restricted, and flags an approved provider outside them', async () => {
    vi.mocked(apiClient.put).mockResolvedValue(policy({ jurisdictions: ['EU', 'UK'] }));
    const user = renderForm();

    await user.click(screen.getByRole('switch', { name: /Restrict to jurisdictions/ }));
    await user.type(screen.getByRole('textbox', { name: 'Jurisdictions' }), 'eu, uk');

    // Anthropic is approved but recorded in the US: still refused.
    expect(screen.getByRole('checkbox', { name: /Anthropic/ }).closest('label')).toHaveTextContent(
      'outside the jurisdictions below'
    );
    expect(
      screen.getByRole('checkbox', { name: /Mistral/ }).closest('label')
    ).not.toHaveTextContent('outside the jurisdictions');

    await user.click(screen.getByRole('button', { name: 'Save approved providers' }));
    expect(apiClient.put).toHaveBeenCalledWith(`/api/v1/admin/orgs/${ORG}/providers`, {
      body: { approved: ['anthropic'], jurisdictions: ['eu', 'uk'] },
    });
    expect(await screen.findByRole('textbox', { name: 'Jurisdictions' })).toHaveValue('EU, UK');
  });

  it('shows the API’s refusal and keeps the edit', async () => {
    const { APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.put).mockRejectedValue(
      new APIClientError('Jurisdiction must be a short code')
    );
    const user = renderForm();

    await user.click(screen.getByRole('checkbox', { name: /Mistral/ }));
    await user.click(screen.getByRole('button', { name: 'Save approved providers' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Jurisdiction must be a short code');
    expect(screen.getByRole('checkbox', { name: /Mistral/ })).toBeChecked();
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('says the policy is not enforced at single, and still lets it be edited', () => {
    renderForm(policy({ enforced: false }));
    expect(screen.getByText(/Provider policy is not enforced on this install/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Mistral/ })).toBeEnabled();
  });

  it('says nothing about enforcement where the policy applies', () => {
    renderForm();
    expect(screen.queryByText(/not enforced/)).not.toBeInTheDocument();
  });

  it('says the install org is unrestricted, with nothing to edit', () => {
    renderForm(policy({ unrestricted: true, approved: [] }));
    expect(screen.getByText(/may use every provider by rule/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save/ })).not.toBeInTheDocument();
  });

  it('says a grant to a deleted provider is inert and that saving drops it', () => {
    renderForm(
      policy({
        approved: [
          { id: 'id-anthropic', slug: 'anthropic' },
          { id: 'id-gone', slug: null },
        ],
      })
    );
    expect(
      screen.getByText(/1 grant names a provider that has since been deleted/)
    ).toHaveTextContent('saving removes it');
  });

  it('explains both fields', () => {
    renderForm();
    expect(screen.getAllByRole('button', { name: 'More information' })).toHaveLength(2);
  });
});
