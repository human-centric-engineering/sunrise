// @vitest-environment happy-dom

/**
 * MembersTable (§111 t-813): role change, removal, and the API's refusals
 * shown verbatim.
 *
 * @see components/admin/members/members-table.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MembersTable, type OrgMember } from '@/components/admin/members/members-table';
import { apiClient, APIClientError } from '@/lib/api/client';

const mockRefresh = vi.fn();

vi.mock('next/navigation', async () => {
  const { createMockRouter } = await import('@/tests/types/mocks');
  return { useRouter: () => createMockRouter({ refresh: mockRefresh }) };
});

vi.mock('@/lib/api/client', () => ({
  apiClient: { patch: vi.fn(), delete: vi.fn() },
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

// Radix Select does not open in jsdom/happy-dom; drive a native <select> instead.
vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    disabled?: boolean;
    children: React.ReactNode;
  }) => (
    <select
      data-testid="role-select"
      value={value}
      disabled={disabled}
      onChange={(e) => onValueChange(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value }: { value: string }) => <option value={value}>{value}</option>,
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

vi.mock('@/components/ui/field-help', () => ({
  FieldHelp: () => null,
}));

const ORG_ID = 'org-1';
const members: OrgMember[] = [
  {
    id: 'u-1',
    name: 'Alice Owner',
    email: 'alice@example.com',
    role: 'OWNER',
    joinedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'u-2',
    name: null,
    email: 'bob@example.com',
    role: 'MEMBER',
    joinedAt: '2026-02-01T00:00:00.000Z',
  },
];

function renderTable(overrides: Partial<React.ComponentProps<typeof MembersTable>> = {}) {
  return render(
    <MembersTable orgId={ORG_ID} members={members} currentUserId="u-1" {...overrides} />
  );
}

describe('MembersTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiClient.patch).mockResolvedValue({});
    vi.mocked(apiClient.delete).mockResolvedValue({});
  });

  it('lists each member, falling back to a dash for a missing name, and marks only the current user', () => {
    renderTable();

    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('bob@example.com')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    const rows = screen.getAllByRole('row');
    expect(within(rows[1]).getByText('(you)')).toBeInTheDocument();
    expect(within(rows[2]).queryByText('(you)')).not.toBeInTheDocument();
    expect(screen.getAllByText('(you)')).toHaveLength(1);
  });

  it('marks nobody as you when currentUserId is null', () => {
    renderTable({ currentUserId: null });
    expect(screen.queryByText('(you)')).not.toBeInTheDocument();
  });

  it('shows the empty state when there are no members', () => {
    renderTable({ members: [] });
    expect(screen.getByText('No members yet.')).toBeInTheDocument();
    expect(screen.queryByTestId('role-select')).not.toBeInTheDocument();
  });

  it('patches the changed role for that member, then refreshes', async () => {
    const user = userEvent.setup();
    renderTable();

    await user.selectOptions(screen.getAllByTestId('role-select')[1], 'ADMIN');

    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
    expect(apiClient.patch).toHaveBeenCalledTimes(1);
    expect(apiClient.patch).toHaveBeenCalledWith('/api/v1/orgs/org-1/members/u-2', {
      body: { role: 'ADMIN' },
    });
  });

  it('makes no call when the chosen role is the one already held', async () => {
    const user = userEvent.setup();
    renderTable();

    await user.selectOptions(screen.getAllByTestId('role-select')[1], 'MEMBER');

    expect(apiClient.patch).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('shows the API refusal verbatim and does not refresh when a role change is refused', async () => {
    const message = 'Cannot demote the last owner. Make another member an owner first.';
    vi.mocked(apiClient.patch).mockRejectedValue(new APIClientError(message, 'FORBIDDEN', 403));
    const user = userEvent.setup();
    renderTable();

    await user.selectOptions(screen.getAllByTestId('role-select')[0], 'MEMBER');

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('alert').textContent).toBe(message);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('shows a generic message for a non-API failure', async () => {
    vi.mocked(apiClient.patch).mockRejectedValue(new Error('boom: internal detail'));
    const user = userEvent.setup();
    renderTable();

    await user.selectOptions(screen.getAllByTestId('role-select')[1], 'ADMIN');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('An unexpected error occurred');
    expect(alert).not.toHaveTextContent('boom');
  });

  it('asks for confirmation before removing, and removes nothing on cancel', async () => {
    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByRole('button', { name: 'Remove bob@example.com' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/bob@example.com will lose access/)).toBeInTheDocument();
    expect(apiClient.delete).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(apiClient.delete).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('tells the current user that removing themself takes their own access', async () => {
    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByRole('button', { name: 'Remove Alice Owner' }));
    const dialog = await screen.findByRole('alertdialog');

    expect(
      within(dialog).getByText(/You will lose access to this organisation/)
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/Alice Owner will lose access/)).not.toBeInTheDocument();
  });

  it('deletes the confirmed member and refreshes', async () => {
    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByRole('button', { name: 'Remove Alice Owner' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
    expect(apiClient.delete).toHaveBeenCalledTimes(1);
    expect(apiClient.delete).toHaveBeenCalledWith('/api/v1/orgs/org-1/members/u-1');
  });

  it('shows the API refusal verbatim and does not refresh when removal is refused', async () => {
    const message = 'Cannot remove the last owner of an organisation.';
    vi.mocked(apiClient.delete).mockRejectedValue(new APIClientError(message, 'FORBIDDEN', 403));
    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByRole('button', { name: 'Remove Alice Owner' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

    expect((await screen.findByRole('alert')).textContent).toBe(message);
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
