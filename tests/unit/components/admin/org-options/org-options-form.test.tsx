// @vitest-environment happy-dom

/**
 * OrgOptionsForm (§135 t-1054): an org's own admin sets the switches the app
 * registers `setBy: 'org'` through `PATCH /api/v1/orgs/[id]/entitlements`.
 * Pins: a save names only the switches the admin changed; a support session
 * and an unreadable slice show the options without a save; an install with
 * none says so.
 *
 * @see components/admin/org-options/org-options-form.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  OrgOptionsForm,
  type OrgOptionsView,
} from '@/components/admin/org-options/org-options-form';
import { apiClient } from '@/lib/api/client';

vi.mock('@/lib/api/client', () => ({
  apiClient: { patch: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

const ORG = 'cmorg000000000000000acme1';

function view(overrides: Partial<OrgOptionsView> = {}): OrgOptionsView {
  return {
    orgId: ORG,
    unreadable: false,
    mayChange: true,
    registrationFailed: false,
    switches: [
      {
        key: 'beta_editor',
        label: 'New editor (beta)',
        description: 'Try the new editor.',
        whenNothingSet: false,
        on: false,
        atDefault: true,
      },
      {
        key: 'digest',
        label: 'Weekly digest',
        description: '',
        whenNothingSet: true,
        on: true,
        atDefault: true,
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('OrgOptionsForm (t-1054)', () => {
  it('saves only the option the admin changed, leaving the other at its default', async () => {
    const user = userEvent.setup();
    const after = view();
    after.switches[0] = { ...after.switches[0], on: true, atDefault: false };
    vi.mocked(apiClient.patch).mockResolvedValue(after);
    render(<OrgOptionsForm orgId={ORG} options={view()} />);

    const save = screen.getByRole('button', { name: 'Save options' });
    expect(save).toBeDisabled();
    await user.click(screen.getByLabelText(/New editor \(beta\)/));
    await user.click(save);

    expect(apiClient.patch).toHaveBeenCalledWith(`/api/v1/orgs/${ORG}/entitlements`, {
      body: { on: ['beta_editor'], off: [] },
    });
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('shows a support session the options with no save', () => {
    render(<OrgOptionsForm orgId={ORG} options={view({ mayChange: false })} />);
    expect(
      screen.getByText('Support staff can see these options but cannot change them.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save options' })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/New editor \(beta\)/)).toBeDisabled();
  });

  it('says when the options could not be read, offering no save', () => {
    render(<OrgOptionsForm orgId={ORG} options={view({ unreadable: true, mayChange: false })} />);
    expect(screen.getByRole('note')).toHaveTextContent('could not be read');
    expect(screen.queryByRole('button', { name: 'Save options' })).not.toBeInTheDocument();
  });

  it('says there are none when the app registers no org-set switch', () => {
    render(<OrgOptionsForm orgId={ORG} options={view({ switches: [] })} />);
    expect(
      screen.getByText(/no parts of the app your organisation can turn on or off/)
    ).toBeInTheDocument();
  });
});
