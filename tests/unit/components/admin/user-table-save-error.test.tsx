// @vitest-environment happy-dom

/**
 * UserTable — failed delete (§124)
 *
 * A refused delete keeps its dialog open with the failure inside it, directly
 * above the dialog's buttons.
 *
 * @see components/admin/user-table.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { UserTable } from '@/components/admin/user-table';
import type { UserListItem } from '@/types';
import type { PaginationMeta } from '@/types/api';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/users',
  useSearchParams: () => ({ get: () => null }),
}));

// The real APIClientError, so the table reads the failure as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const users: UserListItem[] = [
  {
    id: 'user-2',
    name: 'Bob Smith',
    email: 'bob@example.com',
    image: null,
    role: 'USER',
    emailVerified: false,
    createdAt: new Date('2025-02-20T14:30:00Z'),
  },
];
const meta: PaginationMeta = { page: 1, limit: 10, total: 1, totalPages: 1 };
const twoUsers: UserListItem[] = [
  ...users,
  { ...users[0], id: 'user-3', name: 'Carol Jones', email: 'carol@example.com' },
];

async function openDelete(user: ReturnType<typeof userEvent.setup>, row: number) {
  await user.click(screen.getAllByRole('button', { name: /open menu/i })[row]);
  await user.click(screen.getByRole('menuitem', { name: /delete/i }));
  return screen.findByRole('alertdialog');
}

describe('UserTable — failed delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('keeps the delete dialog open with the failure above its buttons', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.delete).mockRejectedValue(
      new APIClientError('User has pending erasure', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    render(<UserTable initialUsers={users} initialMeta={meta} />);

    await user.click(screen.getByRole('button', { name: /open menu/i }));
    await user.click(screen.getByRole('menuitem', { name: /delete/i }));
    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: /^delete$/i });
    await user.click(confirm);

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('User has pending erasure');
    expect(alert.nextElementSibling).toContainElement(confirm);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(alert).toHaveFocus();
  });

  it('is committed to a delete in flight: no second request, no Cancel, no Escape', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.delete).mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    render(<UserTable initialUsers={users} initialMeta={meta} />);

    const dialog = await openDelete(user, 0);
    await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));

    const pending = within(dialog).getByRole('button', { name: 'Deleting...' });
    expect(pending).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await user.click(pending);
    await user.keyboard('{Escape}');

    expect(apiClient.delete).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it("never shows one row's failed delete in the next row's dialog", async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    let reject: (err: unknown) => void = () => {};
    vi.mocked(apiClient.delete).mockReturnValue(
      new Promise((_, rej) => {
        reject = rej;
      })
    );
    const user = userEvent.setup();
    render(<UserTable initialUsers={twoUsers} initialMeta={{ ...meta, total: 2 }} />);

    const first = await openDelete(user, 0);
    await user.click(within(first).getByRole('button', { name: /^delete$/i }));
    // An attempt to leave while the request is in flight, then it fails.
    await user.keyboard('{Escape}');
    await act(async () => reject(new APIClientError('User has pending erasure', 'CONFLICT', 409)));
    // Leave the dialog if it is still open (it should be: it ignored the Escape).
    const open = screen.queryByRole('alertdialog');
    if (open) await user.click(within(open).getByRole('button', { name: 'Cancel' }));

    const dialog = await openDelete(user, 1);
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    expect(dialog).not.toHaveTextContent('User has pending erasure');
  });
});
