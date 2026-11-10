// @vitest-environment happy-dom

/**
 * Tests: AcceptInviteExistingAccount and DeclineInvitationButton (#1199,
 * t-1006) — the accept page for an address that already has an account.
 *
 * The three session states each show their own step, and only the one signed
 * in as the invited address can accept. The server enforces the same rule
 * (`accept-invitation.test.ts`); these prove the page does not offer a step
 * that would only be refused, and sends the right request when it does.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn() },
}));

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ push: mockPush, replace: vi.fn(), refresh: vi.fn() })),
}));

const mockUseSession = vi.fn();
const mockSignOut = vi.fn();
vi.mock('@/lib/auth/client', () => ({
  authClient: {
    useSession: () => mockUseSession(),
    signOut: (...args: unknown[]) => mockSignOut(...args),
  },
}));

import { AcceptInviteExistingAccount } from '@/components/forms/accept-invite-existing-account';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';

const props = { token: 'tok-123', email: 'pat@example.com', orgName: 'Acme' };
const returnTo = '/accept-invite?token=tok-123&email=pat%40example.com';

function signedInAs(email: string | null) {
  mockUseSession.mockReturnValue({
    data: email ? { user: { email } } : null,
    isPending: false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AcceptInviteExistingAccount', () => {
  it('signed out: offers sign-in that returns to this invitation, and no accept', async () => {
    signedInAs(null);
    const user = userEvent.setup();
    render(<AcceptInviteExistingAccount {...props} />);

    expect(screen.queryByRole('button', { name: /join acme/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /sign in to accept/i }));

    expect(mockPush).toHaveBeenCalledWith(`/login?callbackUrl=${encodeURIComponent(returnTo)}`);
  });

  it('signed out with an unverified account: says to verify on sign-in first', () => {
    signedInAs(null);
    render(<AcceptInviteExistingAccount {...props} accountVerified={false} />);

    expect(screen.getByText(/has not been verified yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in to accept/i })).toBeInTheDocument();
  });

  it('signed in as the invited but unverified account: no Join, says to verify (code review, t-1006)', () => {
    signedInAs('pat@example.com');
    render(<AcceptInviteExistingAccount {...props} accountVerified={false} />);

    expect(screen.queryByRole('button', { name: /join acme/i })).not.toBeInTheDocument();
    expect(screen.getByText(/accepting needs a\s+verified address/i)).toBeInTheDocument();
  });

  it('signed in and unverified: sends a verification email to the invited address', async () => {
    // Seen on the final look (t-1006): an install that does not require
    // verification to sign in never offers the email, so the page does.
    signedInAs('pat@example.com');
    vi.mocked(apiClient.post).mockResolvedValue({});
    const user = userEvent.setup();
    render(<AcceptInviteExistingAccount {...props} accountVerified={false} />);

    await user.click(screen.getByRole('button', { name: /send verification email/i }));

    expect(
      await screen.findByText(/verification email sent to pat@example.com/i)
    ).toBeInTheDocument();
    expect(apiClient.post).toHaveBeenCalledWith(API.AUTH.SEND_VERIFICATION_EMAIL, {
      body: { email: 'pat@example.com' },
    });
  });

  it('signed in and unverified: a failed send shows why and keeps the button', async () => {
    signedInAs('pat@example.com');
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Too many requests', 'RATE_LIMIT_EXCEEDED', 429)
    );
    const user = userEvent.setup();
    render(<AcceptInviteExistingAccount {...props} accountVerified={false} />);

    await user.click(screen.getByRole('button', { name: /send verification email/i }));

    expect(await screen.findByText(/too many requests/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send verification email/i })).toBeEnabled();
  });

  it('signed in as someone else: names both addresses and offers sign-out, not accept', async () => {
    signedInAs('other@example.com');
    const user = userEvent.setup();
    render(<AcceptInviteExistingAccount {...props} />);

    expect(screen.getByText('other@example.com')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /join acme/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /sign out/i }));
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('signed in as the invited address (any case): accepts, then switches to the org', async () => {
    signedInAs('Pat@Example.com');
    vi.mocked(apiClient.post).mockImplementation((url: string) =>
      Promise.resolve(
        url === API.INVITATIONS.ACCEPT ? { membership: { orgId: 'org-a', role: 'MEMBER' } } : {}
      )
    );
    const user = userEvent.setup();
    render(<AcceptInviteExistingAccount {...props} />);

    await user.click(screen.getByRole('button', { name: /join acme/i }));

    await waitFor(() => expect(screen.getByText(/you have joined acme/i)).toBeInTheDocument());
    expect(apiClient.post).toHaveBeenNthCalledWith(1, API.INVITATIONS.ACCEPT, {
      body: { token: 'tok-123', email: 'pat@example.com' },
    });
    expect(apiClient.post).toHaveBeenNthCalledWith(2, API.ORGS.SWITCH, {
      body: { orgId: 'org-a' },
    });
  });

  it('shows a loading state while the session is being read, and no action', () => {
    mockUseSession.mockReturnValue({ data: null, isPending: true });
    render(<AcceptInviteExistingAccount {...props} />);

    expect(screen.getByText(/checking your sign-in/i)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('wrong account: signing out returns to this invitation', async () => {
    signedInAs('other@example.com');
    const location = { href: '' };
    vi.stubGlobal('location', location);
    mockSignOut.mockImplementation(
      ({ fetchOptions }: { fetchOptions: { onSuccess: () => void } }) => {
        fetchOptions.onSuccess();
        return Promise.resolve();
      }
    );
    const user = userEvent.setup();
    render(<AcceptInviteExistingAccount {...props} />);

    await user.click(screen.getByRole('button', { name: /sign out/i }));

    expect(location.href).toBe(returnTo);
    vi.unstubAllGlobals();
  });

  it('wrong account: a failed sign-out lets them try again', async () => {
    signedInAs('other@example.com');
    mockSignOut.mockImplementation(
      ({ fetchOptions }: { fetchOptions: { onError: () => void } }) => {
        fetchOptions.onError();
        return Promise.resolve();
      }
    );
    const user = userEvent.setup();
    render(<AcceptInviteExistingAccount {...props} />);

    await user.click(screen.getByRole('button', { name: /sign out/i }));

    expect(screen.getByRole('button', { name: /^sign out$/i })).toBeEnabled();
  });

  it('a failed switch after accepting still reports the invitation accepted', async () => {
    signedInAs('pat@example.com');
    vi.mocked(apiClient.post).mockImplementation((url: string) =>
      url === API.INVITATIONS.ACCEPT
        ? Promise.resolve({ membership: { orgId: 'org-a', role: 'MEMBER' } })
        : Promise.reject(new Error('switch failed'))
    );
    const user = userEvent.setup();
    render(<AcceptInviteExistingAccount {...props} />);

    await user.click(screen.getByRole('button', { name: /join acme/i }));

    expect(await screen.findByText(/you have joined acme/i)).toBeInTheDocument();
  });

  it('shows the server’s refusal beside the button', async () => {
    signedInAs('pat@example.com');
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError(
        'Verify your email address before accepting this invitation.',
        'EMAIL_NOT_VERIFIED',
        403
      )
    );
    const user = userEvent.setup();
    render(<AcceptInviteExistingAccount {...props} />);

    await user.click(screen.getByRole('button', { name: /join acme/i }));

    expect(await screen.findByText(/verify your email address/i)).toBeInTheDocument();
    expect(screen.queryByText(/you have joined/i)).not.toBeInTheDocument();
  });

  it('declines after confirming, with the token, signed out', async () => {
    signedInAs(null);
    vi.mocked(apiClient.post).mockResolvedValue({});
    const user = userEvent.setup();
    render(<AcceptInviteExistingAccount {...props} />);

    await user.click(screen.getByRole('button', { name: /decline invitation/i }));
    expect(apiClient.post).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /^decline$/i }));

    expect(await screen.findByText(/invitation declined/i)).toBeInTheDocument();
    expect(apiClient.post).toHaveBeenCalledWith(API.INVITATIONS.DECLINE, {
      body: { token: 'tok-123', email: 'pat@example.com' },
    });
    // Found by looking (t-1006): the step above the button stayed on screen
    // after a decline, offering an action that could only fail.
    expect(screen.queryByRole('button', { name: /sign in to accept/i })).not.toBeInTheDocument();
  });

  it('a decline signed in as the invited account removes the Join button with it', async () => {
    signedInAs('pat@example.com');
    vi.mocked(apiClient.post).mockResolvedValue({});
    const user = userEvent.setup();
    render(<AcceptInviteExistingAccount {...props} />);

    await user.click(screen.getByRole('button', { name: /decline invitation/i }));
    await user.click(screen.getByRole('button', { name: /^decline$/i }));

    expect(await screen.findByText(/invitation declined/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /join acme/i })).not.toBeInTheDocument();
  });

  it('a failed decline keeps the page and shows why', async () => {
    signedInAs('pat@example.com');
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Invitation not found', 'NOT_FOUND', 404)
    );
    const user = userEvent.setup();
    render(<AcceptInviteExistingAccount {...props} />);

    await user.click(screen.getByRole('button', { name: /decline invitation/i }));
    await user.click(screen.getByRole('button', { name: /^decline$/i }));

    expect(await screen.findByText(/invitation not found/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /join acme/i })).toBeInTheDocument();
  });
});
