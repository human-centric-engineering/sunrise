// @vitest-environment happy-dom

/**
 * OrgEntitlementsForm (§135 t-1033) — a platform admin sets the switches an
 * org has through `PUT /api/v1/admin/orgs/[id]/entitlements`.
 *
 * @see components/admin/orgs/org-entitlements-form.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  OrgEntitlementsForm,
  type OrgEntitlementsView,
} from '@/components/admin/orgs/org-entitlements-form';
import { apiClient } from '@/lib/api/client';

vi.mock('@/lib/api/client', () => ({
  apiClient: { put: vi.fn() },
  APIClientError: class APIClientError extends Error {
    constructor(
      message: string,
      public code?: string,
      public status?: number,
      public details?: Record<string, unknown>
    ) {
      super(message);
    }
  },
}));

const ORG = 'cmorg000000000000000acme1';
const PATH = `/api/v1/admin/orgs/${ORG}/entitlements`;

function view(overrides: Partial<OrgEntitlementsView> = {}): OrgEntitlementsView {
  return {
    orgId: ORG,
    nothingSet: false,
    unreadable: false,
    mayChange: true,
    switches: [
      {
        key: 'reports',
        label: 'Reports',
        description: 'Build reports.',
        whenNothingSet: false,
        on: true,
        atDefault: false,
      },
      {
        key: 'leads',
        label: 'Lead generation',
        description: 'Funnels and leads.',
        whenNothingSet: true,
        on: false,
        atDefault: false,
      },
    ],
    unregistered: [],
    ...overrides,
  };
}

/** Every switch at its default, as the route reports an org nothing was set on. */
const atDefaults = () =>
  view({
    nothingSet: true,
    switches: view().switches.map((s) => ({ ...s, on: s.whenNothingSet, atDefault: true })),
  });

function renderForm(initial: OrgEntitlementsView = view()) {
  const user = userEvent.setup();
  render(<OrgEntitlementsForm orgId={ORG} entitlements={initial} />);
  return user;
}

describe('OrgEntitlementsForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ticks the switches the org has, and marks the ones on by default', () => {
    renderForm();

    expect(screen.getByRole('checkbox', { name: /Reports/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Lead generation/ })).not.toBeChecked();
    expect(screen.getByText('on by default')).toBeInTheDocument();
    expect(screen.getByText('Funnels and leads.')).toBeInTheDocument();
  });

  it('saves exactly the ticked switches, and shows what the server stored', async () => {
    vi.mocked(apiClient.put).mockResolvedValue(
      view({
        switches: view().switches.map((s) => ({ ...s, on: s.key === 'leads' })),
      })
    );
    const user = renderForm();

    await user.click(screen.getByRole('checkbox', { name: /Reports/ }));
    await user.click(screen.getByRole('checkbox', { name: /Lead generation/ }));
    await user.click(screen.getByRole('button', { name: 'Save switches' }));

    expect(apiClient.put).toHaveBeenCalledWith(PATH, { body: { switches: ['leads'] } });
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Reports/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Lead generation/ })).toBeChecked();
  });

  it('locks the switches while a save runs, so a tick made meanwhile cannot be lost', async () => {
    let land: (value: OrgEntitlementsView) => void = () => {};
    vi.mocked(apiClient.put).mockReturnValue(
      new Promise<OrgEntitlementsView>((resolve) => {
        land = resolve;
      })
    );
    const user = renderForm();

    await user.click(screen.getByRole('button', { name: 'Save switches' }));

    expect(screen.getByRole('checkbox', { name: /Lead generation/ })).toBeDisabled();
    land(view());
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Lead generation/ })).toBeEnabled();
  });

  it('says an org with nothing set is at its defaults, and offers no clear', () => {
    renderForm(atDefaults());

    expect(screen.getByText(/Nothing has been set on this organisation/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Lead generation/ })).toBeChecked();
    expect(screen.queryByRole('button', { name: 'Clear to defaults' })).not.toBeInTheDocument();
    // Every switch is at its default, which the note already says once.
    expect(screen.queryByText(/Not set on this organisation yet/)).not.toBeInTheDocument();
  });

  it('says which switch of a saved org is still at its default', () => {
    renderForm(
      view({
        switches: view().switches.map((s) =>
          s.key === 'leads' ? { ...s, on: true, atDefault: true } : s
        ),
      })
    );

    expect(screen.getAllByText(/Not set on this organisation yet/)).toHaveLength(1);
  });

  it('clears a set org back to its defaults only once the dialog is confirmed', async () => {
    vi.mocked(apiClient.put).mockResolvedValue(atDefaults());
    const user = renderForm();

    await user.click(screen.getByRole('button', { name: 'Clear to defaults' }));

    expect(apiClient.put).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/goes back to its default/);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(apiClient.put).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Clear to defaults' }));
    const confirm = await screen.findByRole('alertdialog');
    await user.click(
      Array.from(confirm.querySelectorAll('button')).find(
        (b) => b.textContent === 'Clear to defaults'
      )!
    );

    expect(apiClient.put).toHaveBeenCalledWith(PATH, { body: { switches: null } });
    expect(
      await screen.findByText(/Nothing has been set on this organisation/)
    ).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('shows a failed clear in the dialog, which stays open', async () => {
    const { APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.put).mockRejectedValue(new APIClientError('Something went wrong'));
    const user = renderForm();

    await user.click(screen.getByRole('button', { name: 'Clear to defaults' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(
      Array.from(dialog.querySelectorAll('button')).find(
        (b) => b.textContent === 'Clear to defaults'
      )!
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('shows the switches but offers no change where they cannot be changed', () => {
    renderForm(view({ mayChange: false }));

    expect(screen.getByText(/only be changed from the install organisation/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Reports/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save switches' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear to defaults' })).not.toBeInTheDocument();
  });

  it('warns when the stored switches could not be read', () => {
    renderForm(
      view({ unreadable: true, switches: view().switches.map((s) => ({ ...s, on: false })) })
    );

    expect(screen.getByText(/could not be read/)).toBeInTheDocument();
  });

  it('names stored keys nothing registers, saying a save keeps them', () => {
    renderForm(view({ unregistered: ['retired'] }));

    expect(screen.getByText('retired')).toBeInTheDocument();
    expect(screen.getByText(/Saving keeps it/)).toBeInTheDocument();
  });

  it('shows the refusal beside Save and keeps the edit', async () => {
    const { APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.put).mockRejectedValue(new APIClientError('No switch has the key x'));
    const user = renderForm();

    await user.click(screen.getByRole('checkbox', { name: /Lead generation/ }));
    await user.click(screen.getByRole('button', { name: 'Save switches' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('No switch has the key x');
    expect(screen.getByRole('checkbox', { name: /Lead generation/ })).toBeChecked();
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });
});
