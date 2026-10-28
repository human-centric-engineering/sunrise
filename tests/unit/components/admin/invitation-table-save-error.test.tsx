// @vitest-environment happy-dom

/**
 * InvitationTable — failed saves (§124)
 *
 * A refused resend (shown nowhere before) appears in the box above the table
 * and takes focus; a refused delete keeps its dialog open with the failure
 * inside it.
 *
 * @see components/admin/invitation-table.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { InvitationTable } from '@/components/admin/invitation-table';
import type { InvitationListItem } from '@/types';
import type { PaginationMeta } from '@/types/api';

// The real APIClientError, so the table reads the failure as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const invitations: InvitationListItem[] = [
  {
    email: 'alice@example.com',
    name: 'Alice Johnson',
    role: 'USER',
    invitedBy: 'admin-1',
    invitedByName: 'Admin User',
    invitedAt: new Date('2025-01-15T10:00:00Z'),
    expiresAt: new Date('2099-01-27T10:00:00Z'),
  },
];
const meta: PaginationMeta = { page: 1, limit: 20, total: 1, totalPages: 1 };

describe('InvitationTable — failed saves', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows a refused resend above the table and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Email service is not configured', 'SERVICE_UNAVAILABLE', 503)
    );
    const user = userEvent.setup();
    render(<InvitationTable initialInvitations={invitations} initialMeta={meta} />);

    await user.click(screen.getByRole('button', { name: /open menu/i }));
    await user.click(screen.getByRole('menuitem', { name: /resend/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Email service is not configured');
    expect(alert.nextElementSibling).toContainElement(screen.getByRole('table'));
    expect(alert).toHaveFocus();
  });

  it('keeps the delete dialog open with the failure inside it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.delete).mockRejectedValue(
      new APIClientError('Invitation not found', 'NOT_FOUND', 404)
    );
    const user = userEvent.setup();
    render(<InvitationTable initialInvitations={invitations} initialMeta={meta} />);

    await user.click(screen.getByRole('button', { name: /open menu/i }));
    await user.click(screen.getByRole('menuitem', { name: /delete/i }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Invitation not found');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(alert).toHaveFocus();
  });
});
