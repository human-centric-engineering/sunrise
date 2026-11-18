// @vitest-environment happy-dom

/**
 * ProviderKeysList (§137 t-1045): one card per provider, saying in words what
 * the org's calls to it go out on for every state the API reports, and
 * offering only the actions that apply — save or replace where saving is not
 * blocked and the provider is approved, test on an approved provider's key,
 * remove on any key. Test and remove go to the API and show its answer.
 *
 * @see components/admin/provider-keys/provider-keys-list.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockRefresh = vi.fn();
vi.mock('next/navigation', async () => {
  const { createMockRouter } = await import('@/tests/types/mocks');
  return { useRouter: () => createMockRouter({ refresh: mockRefresh }) };
});

vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

import { ProviderKeysList } from '@/components/admin/provider-keys/provider-keys-list';
import type {
  ProviderKeyRow,
  ProviderKeyState,
} from '@/components/admin/provider-keys/provider-key-states';
import { apiClient, APIClientError } from '@/lib/api/client';

const ORG = 'org-entered';

function row(state: ProviderKeyState | null, over: Partial<ProviderKeyRow> = {}): ProviderKeyRow {
  return {
    providerConfigId: 'prov-1',
    name: 'Anthropic',
    slug: 'anthropic',
    approved: true,
    takesKey: true,
    key:
      state === null
        ? null
        : {
            hint: 'wxyz',
            version: 1,
            savedAt: '2026-11-01T10:00:00.000Z',
            savedBy: { id: 'u1', name: 'Ada Admin' },
            state,
          },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('what each state says', () => {
  it.each<[ProviderKeyState | null, string, RegExp]>([
    [null, 'Platform key', /use the platform’s key/],
    ['in_use', 'Your key, in use', /go out on your key/],
    ['provider_off', 'Not in use: provider switched off', /switched Anthropic off.*refused/],
    ['switched_off', 'Not in use: switched off', /switched off on this platform.*refused/],
    ['not_approved', 'Not in use: provider not approved', /not approved to use Anthropic.*refused/],
    ['will_not_open', 'Not in use: key unreadable', /can no longer be read.*Save the key again/],
  ])('state %s: badge and sentence', (state, badge, sentence) => {
    render(
      <ProviderKeysList
        canChange
        masterKeyMissing={false}
        orgId={ORG}
        providers={[row(state)]}
        canSave
      />
    );

    expect(screen.getByText(badge)).toBeInTheDocument();
    expect(screen.getByText(sentence)).toBeInTheDocument();
  });

  it('shows the saved key’s last four characters, and who saved it', () => {
    render(
      <ProviderKeysList
        canChange
        masterKeyMissing={false}
        orgId={ORG}
        providers={[row('in_use')]}
        canSave
      />
    );

    expect(screen.getByText('…wxyz')).toBeInTheDocument();
    expect(screen.getByText(/by Ada Admin/)).toBeInTheDocument();
  });

  it('says so when the org is approved for no provider that takes a key', () => {
    render(
      <ProviderKeysList canChange masterKeyMissing={false} orgId={ORG} providers={[]} canSave />
    );

    expect(screen.getByText(/not approved for any provider/)).toBeInTheDocument();
  });
});

describe('which actions are offered', () => {
  it('offers adding a key where none is saved, and nothing else', () => {
    render(
      <ProviderKeysList
        canChange
        masterKeyMissing={false}
        orgId={ORG}
        providers={[row(null)]}
        canSave
      />
    );

    expect(screen.getByRole('button', { name: 'Add your own key' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Test key/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove key/ })).not.toBeInTheDocument();
  });

  it('offers replace, test and remove on a saved key', () => {
    render(
      <ProviderKeysList
        canChange
        masterKeyMissing={false}
        orgId={ORG}
        providers={[row('in_use')]}
        canSave
      />
    );

    expect(screen.getByRole('button', { name: 'Replace key' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Test key/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Remove key/ })).toBeInTheDocument();
  });

  it('offers no saving where saving is blocked, and keeps test and remove', () => {
    render(
      <ProviderKeysList
        canChange
        masterKeyMissing={false}
        orgId={ORG}
        providers={[row('in_use')]}
        canSave={false}
      />
    );

    expect(screen.queryByRole('button', { name: 'Replace key' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Test key/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Remove key/ })).toBeInTheDocument();
  });

  it('offers only removal on a key for a provider the org is not approved for', () => {
    render(
      <ProviderKeysList
        canChange
        masterKeyMissing={false}
        orgId={ORG}
        providers={[row('not_approved', { approved: false })]}
        canSave
      />
    );

    expect(screen.queryByRole('button', { name: 'Replace key' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Test key/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Remove key/ })).toBeInTheDocument();
  });

  it('offers only removal on a key for a provider that has been switched off or made local', () => {
    render(
      <ProviderKeysList
        canChange
        masterKeyMissing={false}
        orgId={ORG}
        providers={[row('provider_off', { takesKey: false })]}
        canSave
      />
    );

    expect(screen.queryByRole('button', { name: 'Replace key' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Test key/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Remove key/ })).toBeInTheDocument();
  });

  it('closes an open save form once saving is no longer offered', async () => {
    const user = userEvent.setup();
    const props = {
      orgId: ORG,
      providers: [row('in_use')],
      canChange: true,
      masterKeyMissing: false,
    };
    const { rerender } = render(<ProviderKeysList {...props} canSave />);
    await user.click(screen.getByRole('button', { name: 'Replace key' }));
    expect(screen.getByRole('button', { name: /Test and replace/ })).toBeInTheDocument();

    rerender(<ProviderKeysList {...props} canSave={false} />);

    expect(screen.queryByRole('button', { name: /Test and replace/ })).not.toBeInTheDocument();
  });

  it('opens the save form for that provider', async () => {
    const user = userEvent.setup();
    render(
      <ProviderKeysList
        canChange
        masterKeyMissing={false}
        orgId={ORG}
        providers={[row(null)]}
        canSave
      />
    );

    await user.click(screen.getByRole('button', { name: 'Add your own key' }));

    expect(screen.getByLabelText(/Anthropic key/, { selector: 'input' })).toHaveAttribute(
      'type',
      'password'
    );
    expect(screen.getByRole('button', { name: /Test and save/ })).toBeInTheDocument();
  });
});

describe('testing a saved key', () => {
  it('posts the test and says the vendor accepted the key', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.post).mockResolvedValue({ ok: true });
    render(
      <ProviderKeysList
        canChange
        masterKeyMissing={false}
        orgId={ORG}
        providers={[row('in_use')]}
        canSave
      />
    );

    await user.click(screen.getByRole('button', { name: /Test key/ }));

    expect(apiClient.post).toHaveBeenCalledWith(
      '/api/v1/orgs/org-entered/provider-keys/prov-1/test'
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Anthropic accepted the key.');
    // A passing test cannot change what the page shows.
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it.each([
    ['test_failed', /Anthropic did not accept the key, or could not be reached/],
    ['will_not_open', /can no longer be read. Save it again/],
  ])('says what a failed test (%s) means', async (reason, sentence) => {
    const user = userEvent.setup();
    vi.mocked(apiClient.post).mockResolvedValue({ ok: false, reason });
    render(
      <ProviderKeysList
        canChange
        masterKeyMissing={false}
        orgId={ORG}
        providers={[row('in_use')]}
        canSave
      />
    );

    await user.click(screen.getByRole('button', { name: /Test key/ }));

    expect(await screen.findByRole('status')).toHaveTextContent(sentence);
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('shows the API’s refusal, such as the rate limit, as worded', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Too many requests', 'RATE_LIMIT_EXCEEDED', 429)
    );
    render(
      <ProviderKeysList
        canChange
        masterKeyMissing={false}
        orgId={ORG}
        providers={[row('in_use')]}
        canSave
      />
    );

    await user.click(screen.getByRole('button', { name: /Test key/ }));

    expect(await screen.findByText('Too many requests')).toBeInTheDocument();
  });
});

describe('removing a key', () => {
  it('confirms, deletes and refreshes, saying calls go back to the platform’s key', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.delete).mockResolvedValue(undefined);
    render(
      <ProviderKeysList
        canChange
        masterKeyMissing={false}
        orgId={ORG}
        providers={[row('in_use')]}
        canSave
      />
    );

    await user.click(screen.getByRole('button', { name: /Remove key/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/Within a minute.*go back to the platform's key/);
    await user.click(within(dialog).getByRole('button', { name: 'Remove key' }));

    await waitFor(() =>
      expect(apiClient.delete).toHaveBeenCalledWith('/api/v1/orgs/org-entered/provider-keys/prov-1')
    );
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
  });

  it('says calls stay refused when the org is not approved for the provider', async () => {
    const user = userEvent.setup();
    render(
      <ProviderKeysList
        canChange
        masterKeyMissing={false}
        orgId={ORG}
        providers={[row('not_approved', { approved: false })]}
        canSave
      />
    );

    await user.click(screen.getByRole('button', { name: /Remove key/ }));

    expect(await screen.findByRole('alertdialog')).toHaveTextContent(/stay refused/);
  });

  it('keeps the dialog open with the failure when the delete fails', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.delete).mockRejectedValue(
      new APIClientError('Access denied', 'FORBIDDEN', 403)
    );
    render(
      <ProviderKeysList
        canChange
        masterKeyMissing={false}
        orgId={ORG}
        providers={[row('in_use')]}
        canSave
      />
    );

    await user.click(screen.getByRole('button', { name: /Remove key/ }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove key' }));

    expect(await within(dialog).findByText('Access denied')).toBeInTheDocument();
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});

describe('a read-only support session, and no master key', () => {
  it('offers neither test, replace nor remove when nothing can be changed', () => {
    render(
      <ProviderKeysList
        orgId={ORG}
        providers={[row('in_use')]}
        canSave={false}
        canChange={false}
        masterKeyMissing={false}
      />
    );

    expect(screen.getByText('…wxyz')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('tells the admin platform staff must fix an unreadable key when no master key is configured', () => {
    render(
      <ProviderKeysList
        orgId={ORG}
        providers={[row('will_not_open')]}
        canSave={false}
        canChange
        masterKeyMissing
      />
    );

    expect(
      screen.getByText(/nowhere to keep keys safely.*Platform staff need to configure it/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/Save the key again/)).not.toBeInTheDocument();
  });

  it('says calls stay refused when removing a key for a provider that has been switched off', async () => {
    const user = userEvent.setup();
    render(
      <ProviderKeysList
        canChange
        masterKeyMissing={false}
        orgId={ORG}
        providers={[row('provider_off', { takesKey: false })]}
        canSave
      />
    );

    await user.click(screen.getByRole('button', { name: /Remove key/ }));

    expect(await screen.findByRole('alertdialog')).toHaveTextContent(/stay refused/);
  });
});

describe('a card with nothing to offer', () => {
  it('draws no empty body when there is no key and saving is blocked', () => {
    const { container } = render(
      <ProviderKeysList
        canChange
        masterKeyMissing={false}
        orgId={ORG}
        providers={[row(null)]}
        canSave={false}
      />
    );

    expect(screen.getByText(/use the platform’s key/)).toBeInTheDocument();
    // The card holds its header and nothing else.
    const cardRoot = container.firstElementChild?.firstElementChild;
    expect(cardRoot?.children).toHaveLength(1);
    expect(cardRoot?.textContent).toContain('Anthropic');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
