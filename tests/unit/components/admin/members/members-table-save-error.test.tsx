// @vitest-environment happy-dom

/**
 * MembersTable — failed saves (§124)
 *
 * A refused role change shows in the box above the table and takes focus; a
 * refused removal keeps its dialog open with the refusal inside it.
 *
 * @see components/admin/members/members-table.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MembersTable, type OrgMember } from '@/components/admin/members/members-table';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

// The real APIClientError, so the table reads the failure as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

// A native select stands in for Radix's, which happy-dom can't open.
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
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

const members: OrgMember[] = [
  {
    id: 'u-1',
    name: 'Alice Owner',
    email: 'alice@example.com',
    role: 'OWNER',
    joinedAt: '2026-01-01',
  },
  { id: 'u-2', name: null, email: 'bob@example.com', role: 'MEMBER', joinedAt: '2026-01-02' },
];

describe('MembersTable — failed saves', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows a refused role change above the table and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('Cannot demote the last owner.', 'FORBIDDEN', 403)
    );
    const user = userEvent.setup();
    render(<MembersTable orgId="org-1" members={members} currentUserId="u-1" />);

    await user.selectOptions(screen.getAllByTestId('role-select')[0], 'MEMBER');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Cannot demote the last owner.');
    expect(alert.nextElementSibling).toContainElement(screen.getByRole('table'));
    expect(alert).toHaveFocus();
  });

  it('keeps the remove dialog open with the refusal inside it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.delete).mockRejectedValue(
      new APIClientError('Cannot remove the last owner of an organisation.', 'FORBIDDEN', 403)
    );
    const user = userEvent.setup();
    render(<MembersTable orgId="org-1" members={members} currentUserId="u-1" />);

    await user.click(screen.getByRole('button', { name: 'Remove Alice Owner' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Cannot remove the last owner of an organisation.');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(alert).toHaveFocus();
  });
});
