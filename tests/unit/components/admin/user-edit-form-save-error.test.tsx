// @vitest-environment happy-dom

/**
 * UserEditForm — failed save (§124)
 *
 * The form's Save is in the card footer, below the fields. A failed save must
 * show beside it, not at the top of the card, and a field the server names
 * gets its message and the focus.
 *
 * @see components/admin/user-edit-form.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { UserEditForm } from '@/components/admin/user-edit-form';
import type { AdminUser } from '@/types/admin';

vi.mock('next/navigation', async () => {
  const { createMockRouter } = await import('@/tests/types/mocks');
  return { useRouter: () => createMockRouter() };
});

// The real APIClientError, so the form reads `details` as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const USER: AdminUser = {
  id: 'user-1',
  name: 'John Doe',
  email: 'john@example.com',
  emailVerified: true,
  image: null,
  role: 'USER',
  bio: null,
  createdAt: new Date('2025-01-15T10:00:00Z'),
  updatedAt: new Date('2025-01-20T14:30:00Z'),
  phone: null,
  timezone: null,
  location: null,
};

/** Edits the name, so Save is enabled, and presses Save. */
async function editAndSave() {
  const user = userEvent.setup();
  render(<UserEditForm user={USER} currentUserId="admin-1" />);
  await user.type(screen.getByLabelText('Name'), ' Jr');
  const save = screen.getByRole('button', { name: /save changes/i });
  await user.click(save);
  return save;
}

describe('UserEditForm — failed save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows the failure beside Save, and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('Cannot demote the last admin', 'FORBIDDEN', 403)
    );

    const save = await editAndSave();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Cannot demote the last admin');
    expect(alert.parentElement).toContainElement(save);
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('puts a rejected field’s message under it and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('Invalid request body', 'VALIDATION_ERROR', 400, {
        errors: [{ path: 'name', message: 'Name cannot be empty' }],
      })
    );

    await editAndSave();

    await waitFor(() => expect(document.querySelector('[name="name"]')).toHaveFocus());
    expect(screen.getByText('Name cannot be empty')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('1 field needs fixing.');
  });

  it('focuses the role select when the server rejects the role', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('Invalid request body', 'VALIDATION_ERROR', 400, {
        errors: [{ path: 'role', message: 'You cannot change your own role' }],
      })
    );

    await editAndSave();

    // The trigger carries the field name as its id, so focus can reach it.
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Role' })).toHaveFocus());
    expect(screen.getByText('You cannot change your own role')).toBeInTheDocument();
  });
});
