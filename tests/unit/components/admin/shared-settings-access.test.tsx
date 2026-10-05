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
  SharedSettingsEditOnly,
  SharedSettingsReadOnlyNotice,
  SharedSettingsSaveHint,
  useIsInstallOrg,
  useSharedSettingsReadOnly,
} from '@/components/admin/shared-settings-access';
import { API } from '@/lib/api/endpoints';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

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

// The switch reloads the page, so everything is recomputed from the session.
let reload: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
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

  it('switches the session to the install org, then reloads the page', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ activeOrgId: INSTALL_ORG_ID });
    const user = userEvent.setup();
    renderIn({ readOnly: true, canSwitch: true });

    await user.click(screen.getByRole('button', { name: 'Switch to the install organisation' }));

    expect(apiClient.post).toHaveBeenCalledWith(API.ORGS.SWITCH, {
      body: { orgId: INSTALL_ORG_ID },
    });
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    // Held until the reload replaces the page: no second POST meanwhile.
    expect(screen.getByRole('button', { name: 'Switching…' })).toBeDisabled();
    expect(apiClient.post).toHaveBeenCalledTimes(1);
  });

  it('shows the server’s refusal and does not reload', async () => {
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('You are not a member of that organisation')
    );
    const user = userEvent.setup();
    renderIn({ readOnly: true, canSwitch: true });

    await user.click(screen.getByRole('button', { name: 'Switch to the install organisation' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You are not a member of that organisation'
    );
    expect(reload).not.toHaveBeenCalled();
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

describe('SharedSettingsReadOnlyNotice — no membership of the install org', () => {
  it('offers no switch it could not make, and says who can make the change', () => {
    render(
      <SharedSettingsAccessProvider readOnly canSwitch={false} installOrgMember={false}>
        <SharedSettingsReadOnlyNotice />
      </SharedSettingsAccessProvider>
    );

    const notice = screen.getByTestId('shared-settings-read-only');
    expect(notice).toHaveTextContent('You are not a member of the install organisation');
    expect(notice).toHaveTextContent('ask one of its admins');
    // Not the address explanation, which is for a member the header holds back.
    expect(notice).not.toHaveTextContent('address');
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('useIsInstallOrg', () => {
  function InstallProbe() {
    return <p data-testid="install">{useIsInstallOrg() ? 'install' : 'other'}</p>;
  }

  it('is not the install org outside a provider, so install-only actions stay hidden', () => {
    render(<InstallProbe />);
    expect(screen.getByTestId('install')).toHaveTextContent('other');
  });

  it('reads the provider, and is not the install org unless the provider says so', () => {
    const { unmount } = render(
      <SharedSettingsAccessProvider readOnly={false} canSwitch={false} isInstallOrg>
        <InstallProbe />
      </SharedSettingsAccessProvider>
    );
    expect(screen.getByTestId('install')).toHaveTextContent('install');
    unmount();

    // Editable is not the same as install: at `single` a session can point
    // at another org and still edit, but the audit is the install org's.
    render(
      <SharedSettingsAccessProvider readOnly={false} canSwitch={false}>
        <InstallProbe />
      </SharedSettingsAccessProvider>
    );
    expect(screen.getByTestId('install')).toHaveTextContent('other');
  });
});

describe('SharedSettingsEditOnly and SharedSettingsSaveHint', () => {
  function renderBoth(readOnly: boolean | null) {
    const tree = (
      <>
        <SharedSettingsEditOnly>
          <a href="/new">New thing</a>
        </SharedSettingsEditOnly>
        <SharedSettingsSaveHint />
      </>
    );
    return render(
      readOnly === null ? (
        tree
      ) : (
        <SharedSettingsAccessProvider readOnly={readOnly} canSwitch>
          {tree}
        </SharedSettingsAccessProvider>
      )
    );
  }

  it('shows the action and no hint where settings can be changed', () => {
    for (const readOnly of [false, null]) {
      const { unmount } = renderBoth(readOnly);
      expect(screen.getByRole('link', { name: 'New thing' })).toBeInTheDocument();
      expect(screen.queryByText(/Read-only here/)).toBeNull();
      unmount();
    }
  });

  it('hides the action and explains the disabled save where they cannot', () => {
    renderBoth(true);
    expect(screen.queryByRole('link', { name: 'New thing' })).toBeNull();
    expect(
      screen.getByText('Read-only here: changes save from the install organisation.')
    ).toBeInTheDocument();
  });
});
