// @vitest-environment happy-dom

/**
 * Shared settings, read-only outside the install org (§107 t-753)
 *
 * The provider, its hook, and the notice every shared-settings page renders.
 * Outside a provider nothing changes — that default is what keeps every
 * existing component test, and every page at `single`, as it was.
 *
 * @see components/admin/shared-settings-access.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  SharedSettingsAccessProvider,
  SharedSettingsReadOnlyNotice,
  useSharedSettingsReadOnly,
} from '@/components/admin/shared-settings-access';
import { API } from '@/lib/api/endpoints';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn() },
  APIClientError: class APIClientError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

import { apiClient, APIClientError } from '@/lib/api/client';

function Probe() {
  return <p data-testid="probe">{useSharedSettingsReadOnly() ? 'read-only' : 'editable'}</p>;
}

function renderIn(access: { readOnly: boolean; canSwitch: boolean } | null) {
  const tree = (
    <>
      <Probe />
      <SharedSettingsReadOnlyNotice />
    </>
  );
  return render(
    access ? <SharedSettingsAccessProvider {...access}>{tree}</SharedSettingsAccessProvider> : tree
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useSharedSettingsReadOnly', () => {
  it('is editable outside a provider', () => {
    renderIn(null);
    expect(screen.getByTestId('probe')).toHaveTextContent('editable');
  });

  it('reads the provider', () => {
    renderIn({ readOnly: true, canSwitch: true });
    expect(screen.getByTestId('probe')).toHaveTextContent('read-only');
  });
});

describe('SharedSettingsReadOnlyNotice', () => {
  it('renders nothing where shared settings can be changed', () => {
    renderIn({ readOnly: false, canSwitch: true });
    expect(screen.queryByTestId('shared-settings-read-only')).toBeNull();

    renderIn(null);
    expect(screen.queryByTestId('shared-settings-read-only')).toBeNull();
  });

  it('says why, and offers the switch, outside the install org', () => {
    renderIn({ readOnly: true, canSwitch: true });

    const notice = screen.getByTestId('shared-settings-read-only');
    expect(notice).toHaveTextContent('Read-only in this organisation');
    expect(notice).toHaveTextContent('can only be changed from the install organisation');
    expect(
      screen.getByRole('button', { name: 'Switch to the install organisation' })
    ).toBeEnabled();
  });

  it('switches the session to the install org, then re-renders the page', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ activeOrgId: INSTALL_ORG_ID });
    const user = userEvent.setup();
    renderIn({ readOnly: true, canSwitch: true });

    await user.click(screen.getByRole('button', { name: 'Switch to the install organisation' }));

    expect(apiClient.post).toHaveBeenCalledWith(API.ORGS.SWITCH, {
      body: { orgId: INSTALL_ORG_ID },
    });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('shows the server’s refusal and does not refresh', async () => {
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('You are not a member of that organisation')
    );
    const user = userEvent.setup();
    renderIn({ readOnly: true, canSwitch: true });

    await user.click(screen.getByRole('button', { name: 'Switch to the install organisation' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You are not a member of that organisation'
    );
    expect(refresh).not.toHaveBeenCalled();
    // The button is usable again for a retry.
    expect(
      screen.getByRole('button', { name: 'Switch to the install organisation' })
    ).toBeEnabled();
  });

  it('falls back to its own words when the failure is not the API’s', async () => {
    vi.mocked(apiClient.post).mockRejectedValue(new TypeError('Failed to fetch'));
    const user = userEvent.setup();
    renderIn({ readOnly: true, canSwitch: true });

    await user.click(screen.getByRole('button', { name: 'Switch to the install organisation' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not switch organisation. Try again.'
    );
  });

  it('offers no switch when the address decides the org, and says so', () => {
    renderIn({ readOnly: true, canSwitch: false });

    expect(screen.getByTestId('shared-settings-read-only')).toHaveTextContent(
      'open the admin from the install organisation’s address'
    );
    expect(screen.queryByRole('button')).toBeNull();
  });
});
