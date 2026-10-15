// @vitest-environment happy-dom

/**
 * MemberInviteForm (§111 t-813): posts to the org's invitations route and
 * shows the API's answer as given.
 *
 * @see components/admin/members/member-invite-form.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MemberInviteForm } from '@/components/admin/members/member-invite-form';
import { apiClient, APIClientError } from '@/lib/api/client';

const mockRefresh = vi.fn();

vi.mock('next/navigation', async () => {
  const { createMockRouter } = await import('@/tests/types/mocks');
  return { useRouter: () => createMockRouter({ refresh: mockRefresh }) };
});

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn() },
  APIClientError: class APIClientError extends Error {
    code?: string;
    status?: number;
    constructor(message: string, code?: string, status?: number) {
      super(message);
      this.name = 'APIClientError';
      this.code = code;
      this.status = status;
    }
  },
}));

vi.mock('@/lib/hooks/use-copy-to-clipboard', () => ({
  useCopyToClipboard: () => ({ copied: false, copy: vi.fn() }),
}));

// Radix Select does not open in jsdom/happy-dom; drive a native <select> instead.
vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    children: React.ReactNode;
  }) => (
    <select data-testid="role-select" value={value} onChange={(e) => onValueChange(e.target.value)}>
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value }: { value: string }) => <option value={value}>{value}</option>,
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

const URL = '/api/v1/orgs/org-1/invitations';

function sentResponse() {
  return {
    message: 'Invitation sent',
    invitation: { email: 'new@example.com', name: 'New Person' },
    emailStatus: 'sent' as const,
  };
}

async function fill(user: ReturnType<typeof userEvent.setup>, name: string, email: string) {
  await user.type(screen.getByLabelText('Name'), name);
  await user.type(screen.getByLabelText(/^Email/, { selector: 'input' }), email);
}

describe('MemberInviteForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('posts name, email and the default MEMBER role to the org invitations route', async () => {
    vi.mocked(apiClient.post).mockResolvedValue(sentResponse());
    const user = userEvent.setup();
    render(<MemberInviteForm orgId="org-1" />);

    await fill(user, 'New Person', 'new@example.com');
    await user.click(screen.getByRole('button', { name: /send invitation/i }));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(1));
    expect(apiClient.post).toHaveBeenCalledWith(URL, {
      body: { name: 'New Person', email: 'new@example.com', orgRole: 'MEMBER' },
    });
  });

  it('posts the chosen role', async () => {
    vi.mocked(apiClient.post).mockResolvedValue(sentResponse());
    const user = userEvent.setup();
    render(<MemberInviteForm orgId="org-1" />);

    await fill(user, 'New Person', 'new@example.com');
    await user.selectOptions(screen.getByTestId('role-select'), 'ADMIN');
    await user.click(screen.getByRole('button', { name: /send invitation/i }));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalled());
    expect(apiClient.post).toHaveBeenCalledWith(URL, {
      body: { name: 'New Person', email: 'new@example.com', orgRole: 'ADMIN' },
    });
  });

  it('shows the message, clears the form and refreshes after a send', async () => {
    vi.mocked(apiClient.post).mockResolvedValue(sentResponse());
    const user = userEvent.setup();
    render(<MemberInviteForm orgId="org-1" />);

    await fill(user, 'New Person', 'new@example.com');
    await user.click(screen.getByRole('button', { name: /send invitation/i }));

    expect(await screen.findByText(/Invitation sent \(new@example.com\)/)).toBeInTheDocument();
    expect(screen.queryByText(/did not go out/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('');
    expect(screen.getByLabelText(/^Email/, { selector: 'input' })).toHaveValue('');
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('says the email did not go out, and offers no link, when it was not sent', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      ...sentResponse(),
      message: 'Invitation created but email failed to send',
      emailStatus: 'failed' as const,
    });
    const user = userEvent.setup();
    render(<MemberInviteForm orgId="org-1" />);

    await fill(user, 'New Person', 'new@example.com');
    await user.click(screen.getByRole('button', { name: /send invitation/i }));

    expect(await screen.findByText(/did not go out/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Invitation link')).not.toBeInTheDocument();
  });

  it('shows the API error verbatim and neither clears nor refreshes', async () => {
    const message = 'An admin cannot invite an owner.';
    vi.mocked(apiClient.post).mockRejectedValue(new APIClientError(message, 'FORBIDDEN', 403));
    const user = userEvent.setup();
    render(<MemberInviteForm orgId="org-1" />);

    await fill(user, 'New Person', 'new@example.com');
    await user.click(screen.getByRole('button', { name: /send invitation/i }));

    expect((await screen.findByRole('alert')).textContent).toBe(message);
    expect(screen.getByLabelText(/^Email/, { selector: 'input' })).toHaveValue('new@example.com');
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('offers "Send it again" for a pending invitation, which re-posts with resend=true', async () => {
    vi.mocked(apiClient.post).mockResolvedValueOnce({
      message: 'Already invited',
      invitation: { email: 'new@example.com', name: 'New Person' },
      emailStatus: 'pending',
    });
    vi.mocked(apiClient.post).mockResolvedValueOnce(sentResponse());
    const user = userEvent.setup();
    render(<MemberInviteForm orgId="org-1" />);

    await fill(user, 'New Person', 'new@example.com');
    await user.click(screen.getByRole('button', { name: /send invitation/i }));

    expect(await screen.findByText(/already pending/)).toBeInTheDocument();
    // Pending is not a success: the form keeps its values and does not refresh.
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/^Email/, { selector: 'input' })).toHaveValue('new@example.com');

    await user.click(screen.getByRole('button', { name: 'Send it again' }));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(2));
    expect(apiClient.post).toHaveBeenLastCalledWith(URL, {
      body: { name: 'New Person', email: 'new@example.com' },
      params: { resend: 'true' },
    });
    expect(await screen.findByText(/Invitation sent/)).toBeInTheDocument();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('re-sends what was submitted, not what the fields hold after an edit', async () => {
    vi.mocked(apiClient.post).mockResolvedValueOnce({
      message: 'Already invited',
      invitation: { email: 'new@example.com', name: 'New Person' },
      emailStatus: 'pending',
    });
    vi.mocked(apiClient.post).mockResolvedValueOnce(sentResponse());
    const user = userEvent.setup();
    render(<MemberInviteForm orgId="org-1" />);

    await fill(user, 'New Person', 'new@example.com');
    await user.click(screen.getByRole('button', { name: /send invitation/i }));
    expect(await screen.findByText(/already pending/)).toBeInTheDocument();

    const email = screen.getByLabelText(/^Email/, { selector: 'input' });
    await user.clear(email);
    await user.type(email, 'other@example.com');
    await user.click(screen.getByRole('button', { name: 'Send it again' }));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(2));
    expect(apiClient.post).toHaveBeenLastCalledWith(URL, {
      body: { name: 'New Person', email: 'new@example.com' },
      params: { resend: 'true' },
    });
  });

  it('names the pending role and re-sends without one, so the API keeps it', async () => {
    vi.mocked(apiClient.post).mockResolvedValueOnce({
      message: 'Already invited',
      invitation: { email: 'new@example.com', name: 'New Person', orgRole: 'ADMIN' },
      emailStatus: 'pending',
    });
    vi.mocked(apiClient.post).mockResolvedValueOnce(sentResponse());
    const user = userEvent.setup();
    render(<MemberInviteForm orgId="org-1" />);

    await fill(user, 'New Person', 'new@example.com');
    await user.click(screen.getByRole('button', { name: /send invitation/i }));

    expect(await screen.findByText(/already pending as Admin/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send it again' }));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(2));
    expect(vi.mocked(apiClient.post).mock.calls[1][1]?.body).not.toHaveProperty('orgRole');
  });

  it('accepts an email pasted with spaces around it, as the API does', async () => {
    vi.mocked(apiClient.post).mockResolvedValue(sentResponse());
    const user = userEvent.setup();
    render(<MemberInviteForm orgId="org-1" />);

    await fill(user, 'New Person', '  New@Example.com ');
    await user.click(screen.getByRole('button', { name: /send invitation/i }));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(1));
    expect(vi.mocked(apiClient.post).mock.calls[0][1]?.body).toMatchObject({
      email: 'new@example.com',
    });
  });

  it('does not send resend=true on the first post', async () => {
    vi.mocked(apiClient.post).mockResolvedValue(sentResponse());
    const user = userEvent.setup();
    render(<MemberInviteForm orgId="org-1" />);

    await fill(user, 'New Person', 'new@example.com');
    await user.click(screen.getByRole('button', { name: /send invitation/i }));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalled());
    expect(vi.mocked(apiClient.post).mock.calls[0][1]).not.toHaveProperty('params');
  });

  it('blocks an empty name and a bad email with no API call', async () => {
    const user = userEvent.setup();
    render(<MemberInviteForm orgId="org-1" />);

    await user.click(screen.getByRole('button', { name: /send invitation/i }));
    expect(await screen.findByText('Name is required')).toBeInTheDocument();
    expect(screen.getByText('Email is required')).toBeInTheDocument();
    expect(apiClient.post).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('Name'), 'Someone');
    await user.type(screen.getByLabelText(/^Email/, { selector: 'input' }), 'not-an-email');
    await user.click(screen.getByRole('button', { name: /send invitation/i }));

    expect(await screen.findByText('Invalid email address')).toBeInTheDocument();
    expect(screen.queryByText('Name is required')).not.toBeInTheDocument();
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('has contextual help on the email and role fields', () => {
    render(<MemberInviteForm orgId="org-1" />);
    expect(screen.getAllByRole('button', { name: 'More information' })).toHaveLength(2);
  });
});
