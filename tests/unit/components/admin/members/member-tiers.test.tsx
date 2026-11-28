// @vitest-environment happy-dom

/**
 * Console access on the Members page (t-1123): the named tiers an org admin
 * grants a MEMBER, on the invite form and on a member's row.
 *
 * Nothing new shows when the app offers no tier; with some, a MEMBER row
 * opens a dialog that sends the whole list, owners and admins read "All",
 * and the invite form sends ticked tiers with a Member invitation only.
 *
 * @see components/admin/members/members-table.tsx
 * @see components/admin/members/member-invite-form.tsx
 * @see components/admin/members/member-tiers-dialog.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MembersTable, type OrgMember } from '@/components/admin/members/members-table';
import { MemberInviteForm } from '@/components/admin/members/member-invite-form';
import { apiClient, APIClientError } from '@/lib/api/client';

const mockRefresh = vi.fn();

vi.mock('next/navigation', async () => {
  const { createMockRouter } = await import('@/tests/types/mocks');
  return { useRouter: () => createMockRouter({ refresh: mockRefresh }) };
});

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
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

// Radix Select does not open in happy-dom; drive a native <select> instead.
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

vi.mock('@/components/ui/field-help', () => ({ FieldHelp: () => null }));

const ORG_ID = 'org-1';
const TIERS = [
  { name: 'media', label: 'Media library', description: 'Upload and manage images.' },
  { name: 'brand', label: 'Brand themes' },
];
const members: OrgMember[] = [
  {
    id: 'u-1',
    name: 'Alice Admin',
    email: 'alice@example.com',
    role: 'ADMIN',
    joinedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'u-2',
    name: 'Dana Designer',
    email: 'dana@example.com',
    role: 'MEMBER',
    tiers: ['media'],
    joinedAt: '2026-01-02T00:00:00.000Z',
  },
  {
    id: 'u-3',
    name: 'Mo Member',
    email: 'mo@example.com',
    role: 'MEMBER',
    joinedAt: '2026-01-03T00:00:00.000Z',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MembersTable — console access', () => {
  it('shows no Console access column when the app offers no tier', () => {
    render(<MembersTable orgId={ORG_ID} members={members} currentUserId={null} />);
    expect(screen.queryByText('Console access')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /console access/i })).not.toBeInTheDocument();
  });

  it('shows each MEMBER’s tiers by their label, None for none, and All for an admin', () => {
    render(
      <MembersTable orgId={ORG_ID} members={members} currentUserId={null} grantableTiers={TIERS} />
    );
    expect(
      screen.getByRole('button', { name: 'Change console access for Dana Designer' })
    ).toHaveTextContent('Media library');
    expect(
      screen.getByRole('button', { name: 'Change console access for Mo Member' })
    ).toHaveTextContent('None');
    expect(
      screen.queryByRole('button', { name: 'Change console access for Alice Admin' })
    ).not.toBeInTheDocument();
    expect(screen.getByText('All')).toBeInTheDocument();
  });

  it('sends the whole ticked list for the member, then refreshes', async () => {
    vi.mocked(apiClient.put).mockResolvedValue({});
    const user = userEvent.setup();
    render(
      <MembersTable orgId={ORG_ID} members={members} currentUserId={null} grantableTiers={TIERS} />
    );

    await user.click(
      screen.getByRole('button', { name: 'Change console access for Dana Designer' })
    );
    const dialog = await screen.findByRole('dialog');
    // Starts from the current grant.
    expect(within(dialog).getByLabelText('Media library')).toBeChecked();
    expect(within(dialog).getByLabelText('Brand themes')).not.toBeChecked();

    await user.click(within(dialog).getByLabelText('Brand themes'));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(apiClient.put).toHaveBeenCalledWith('/api/v1/orgs/org-1/members/u-2/tiers', {
        body: { tiers: ['media', 'brand'] },
      })
    );
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('sends an empty list when every tick is taken away', async () => {
    vi.mocked(apiClient.put).mockResolvedValue({});
    const user = userEvent.setup();
    render(
      <MembersTable orgId={ORG_ID} members={members} currentUserId={null} grantableTiers={TIERS} />
    );

    await user.click(
      screen.getByRole('button', { name: 'Change console access for Dana Designer' })
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByLabelText('Media library'));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(apiClient.put).toHaveBeenCalledWith('/api/v1/orgs/org-1/members/u-2/tiers', {
        body: { tiers: [] },
      })
    );
  });

  it('shows the API’s refusal in the dialog, which stays open, and refreshes nothing', async () => {
    vi.mocked(apiClient.put).mockRejectedValue(
      new APIClientError('These tiers cannot be granted: media', 'TIER_NOT_GRANTABLE', 400)
    );
    const user = userEvent.setup();
    render(
      <MembersTable orgId={ORG_ID} members={members} currentUserId={null} grantableTiers={TIERS} />
    );

    await user.click(screen.getByRole('button', { name: 'Change console access for Mo Member' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByLabelText('Media library'));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(
      await within(dialog).findByText('These tiers cannot be granted: media')
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});

describe('MemberTiersDialog — leaving without saving', () => {
  it('Cancel closes the dialog and sends nothing', async () => {
    const user = userEvent.setup();
    render(
      <MembersTable orgId={ORG_ID} members={members} currentUserId={null} grantableTiers={TIERS} />
    );

    await user.click(screen.getByRole('button', { name: 'Change console access for Mo Member' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByLabelText('Media library'));
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(apiClient.put).not.toHaveBeenCalled();
  });

  it('Escape closes it too, and the next opening starts from the grant again', async () => {
    const user = userEvent.setup();
    render(
      <MembersTable orgId={ORG_ID} members={members} currentUserId={null} grantableTiers={TIERS} />
    );
    const open = () =>
      user.click(screen.getByRole('button', { name: 'Change console access for Dana Designer' }));

    await open();
    let dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByLabelText('Brand themes'));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await open();
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Brand themes')).not.toBeChecked();
    expect(within(dialog).getByLabelText('Media library')).toBeChecked();
  });

  it('names a member with no name by their email', async () => {
    const user = userEvent.setup();
    const unnamed: OrgMember = { ...members[2], id: 'u-4', name: null, email: 'x@example.com' };
    render(
      <MembersTable
        orgId={ORG_ID}
        members={[unnamed]}
        currentUserId={null}
        grantableTiers={TIERS}
      />
    );

    await user.click(
      screen.getByRole('button', { name: 'Change console access for x@example.com' })
    );

    expect(
      await screen.findByRole('heading', { name: 'Console access for x@example.com' })
    ).toBeInTheDocument();
  });

  it('starts without a tier the app no longer offers, so Save is not refused and drops it', async () => {
    vi.mocked(apiClient.put).mockResolvedValue({});
    const user = userEvent.setup();
    const stale: OrgMember = { ...members[2], tiers: ['retired_tier', 'media'] };
    render(
      <MembersTable orgId={ORG_ID} members={[stale]} currentUserId={null} grantableTiers={TIERS} />
    );

    await user.click(screen.getByRole('button', { name: 'Change console access for Mo Member' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(apiClient.put).toHaveBeenCalledWith('/api/v1/orgs/org-1/members/u-3/tiers', {
        body: { tiers: ['media'] },
      })
    );
  });

  it('shows a granted tier the app no longer offers by its name', () => {
    const stale: OrgMember = { ...members[2], tiers: ['retired_tier'] };
    render(
      <MembersTable orgId={ORG_ID} members={[stale]} currentUserId={null} grantableTiers={TIERS} />
    );
    expect(
      screen.getByRole('button', { name: 'Change console access for Mo Member' })
    ).toHaveTextContent('retired_tier');
  });
});

describe('MemberInviteForm — console access', () => {
  async function fill(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText('Name'), 'New Person');
    await user.type(screen.getByLabelText(/^Email/, { selector: 'input' }), 'new@example.com');
  }
  const sent = {
    message: 'Invitation sent',
    invitation: { email: 'new@example.com', name: 'New Person' },
    emailStatus: 'sent' as const,
  };

  it('names console access in the pending notice only when the pending invitation carries some', async () => {
    const user = userEvent.setup();
    const pendingWith = (tiers: string[]) => ({
      message: 'Invitation already pending',
      invitation: { email: 'new@example.com', name: 'New Person', orgRole: 'MEMBER', tiers },
      emailStatus: 'pending' as const,
    });
    vi.mocked(apiClient.post).mockResolvedValueOnce(pendingWith([]));
    render(<MemberInviteForm orgId={ORG_ID} grantableTiers={TIERS} />);

    await fill(user);
    await user.click(screen.getByRole('button', { name: /send invitation/i }));
    expect(
      await screen.findByText(/pending as Member\. The form now shows that role\./)
    ).toBeInTheDocument();

    vi.mocked(apiClient.post).mockResolvedValueOnce(pendingWith(['media']));
    await user.click(screen.getByRole('button', { name: /send invitation/i }));
    expect(
      await screen.findByText(/pending as Member, with console access\. The form now shows both\./)
    ).toBeInTheDocument();
  });

  describe('"Send it again" sends what the form shows (t-1125)', () => {
    const pendingWith = (orgRole: string, tiers: string[]) => ({
      message: 'Invitation already pending',
      invitation: { email: 'new@example.com', name: 'New Person', orgRole, tiers },
      emailStatus: 'pending' as const,
    });
    async function toPending(
      user: ReturnType<typeof userEvent.setup>,
      pending: ReturnType<typeof pendingWith>
    ) {
      vi.mocked(apiClient.post).mockResolvedValueOnce(pending);
      vi.mocked(apiClient.post).mockResolvedValueOnce(sent);
      render(<MemberInviteForm orgId={ORG_ID} grantableTiers={TIERS} />);
      await fill(user);
      await user.click(screen.getByRole('button', { name: /send invitation/i }));
      await screen.findByRole('button', { name: 'Send it again' });
    }
    const resentBody = () => vi.mocked(apiClient.post).mock.calls[1]?.[1]?.body;

    it('shows the pending invitation’s ticks, and re-sends them untouched', async () => {
      const user = userEvent.setup();
      await toPending(user, pendingWith('MEMBER', ['media']));

      expect(screen.getByLabelText('Media library')).toBeChecked();
      expect(screen.getByLabelText('Brand themes')).not.toBeChecked();
      await user.click(screen.getByRole('button', { name: 'Send it again' }));

      await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(2));
      expect(resentBody()).toMatchObject({ orgRole: 'MEMBER', tiers: ['media'] });
    });

    it('sends a tier ticked after the notice', async () => {
      const user = userEvent.setup();
      await toPending(user, pendingWith('MEMBER', []));

      await user.click(screen.getByLabelText('Brand themes'));
      await user.click(screen.getByRole('button', { name: 'Send it again' }));

      await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(2));
      expect(resentBody()).toMatchObject({ orgRole: 'MEMBER', tiers: ['brand'] });
    });

    it('sends an empty list when every tick is removed, so the tiers go', async () => {
      const user = userEvent.setup();
      await toPending(user, pendingWith('MEMBER', ['media', 'brand']));

      await user.click(screen.getByLabelText('Media library'));
      await user.click(screen.getByLabelText('Brand themes'));
      await user.click(screen.getByRole('button', { name: 'Send it again' }));

      await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(2));
      expect(resentBody()).toEqual({
        name: 'New Person',
        email: 'new@example.com',
        orgRole: 'MEMBER',
        tiers: [],
      });
    });

    it('sends another role chosen after the notice, with no tiers', async () => {
      const user = userEvent.setup();
      await toPending(user, pendingWith('MEMBER', ['media']));

      await user.selectOptions(screen.getByTestId('role-select'), 'ADMIN');
      await user.click(screen.getByRole('button', { name: 'Send it again' }));

      await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(2));
      expect(resentBody()).toEqual({
        name: 'New Person',
        email: 'new@example.com',
        orgRole: 'ADMIN',
      });
    });

    it('does not tick a pending tier the app no longer offers', async () => {
      const user = userEvent.setup();
      await toPending(user, pendingWith('MEMBER', ['retired_tier', 'brand']));

      await user.click(screen.getByRole('button', { name: 'Send it again' }));

      await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(2));
      expect(resentBody()).toMatchObject({ tiers: ['brand'] });
    });
  });

  it('offers no ticks when the app offers no tier', () => {
    render(<MemberInviteForm orgId={ORG_ID} />);
    expect(screen.queryByText('Console access')).not.toBeInTheDocument();
  });

  it('sends the ticked tiers with a Member invitation', async () => {
    vi.mocked(apiClient.post).mockResolvedValue(sent);
    const user = userEvent.setup();
    render(<MemberInviteForm orgId={ORG_ID} grantableTiers={TIERS} />);

    await fill(user);
    await user.click(screen.getByLabelText('Brand themes'));
    await user.click(screen.getByRole('button', { name: /send invitation/i }));

    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith('/api/v1/orgs/org-1/invitations', {
        body: {
          name: 'New Person',
          email: 'new@example.com',
          orgRole: 'MEMBER',
          tiers: ['brand'],
        },
      })
    );
  });

  it('hides the ticks for another role, and sends no tiers with it', async () => {
    vi.mocked(apiClient.post).mockResolvedValue(sent);
    const user = userEvent.setup();
    render(<MemberInviteForm orgId={ORG_ID} grantableTiers={TIERS} />);

    await fill(user);
    await user.click(screen.getByLabelText('Media library'));
    await user.selectOptions(screen.getByTestId('role-select'), 'ADMIN');
    expect(screen.queryByLabelText('Media library')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /send invitation/i }));

    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith('/api/v1/orgs/org-1/invitations', {
        body: { name: 'New Person', email: 'new@example.com', orgRole: 'ADMIN' },
      })
    );
  });
});
