// @vitest-environment happy-dom

/**
 * ProfileForm save-error behaviour (t-950)
 *
 * A field-level validation refusal lands under the named field and focuses
 * it; a plain refusal shows its server message directly before Save Changes.
 *
 * @see components/forms/profile-form.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProfileForm } from '@/components/forms/profile-form';
import { apiClient, APIClientError } from '@/lib/api/client';
import { createMockRouter } from '@/tests/types/mocks';

vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { patch: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
}));

vi.mock('@/lib/analytics', () => ({
  useAnalytics: vi.fn(() => ({ track: vi.fn() })),
  EVENTS: { PROFILE_UPDATED: 'profile_updated' },
}));

const user = {
  name: 'Jane Doe',
  email: 'jane@example.com',
  bio: null,
  phone: null,
  timezone: 'UTC',
  location: null,
};

async function editAndSave(u: ReturnType<typeof userEvent.setup>) {
  // Save Changes is disabled until the form is dirty.
  await u.type(screen.getByLabelText('Name'), ' Jr');
  await u.click(screen.getByRole('button', { name: 'Save Changes' }));
}

describe('components/forms/profile-form save errors', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { useRouter } = await import('next/navigation');
    vi.mocked(useRouter).mockReturnValue(createMockRouter());
  });

  it('should put a named-field message under that field and focus it', async () => {
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('Validation failed', 'VALIDATION_ERROR', 400, {
        errors: [{ path: 'name', message: 'That name is reserved' }],
      })
    );
    const u = userEvent.setup();
    render(<ProfileForm user={user} />);

    await editAndSave(u);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('1 field needs fixing.');
    const name = screen.getByLabelText('Name');
    expect(name.closest('.space-y-2')).toContainElement(screen.getByText('That name is reserved'));
    await waitFor(() => expect(name).toHaveFocus());
  });

  it('should show a plain refusal directly before Save Changes, focused', async () => {
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('Profile is locked', 'FORBIDDEN', 403)
    );
    const u = userEvent.setup();
    render(<ProfileForm user={user} />);

    await editAndSave(u);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Profile is locked');
    expect(alert.nextElementSibling).toBe(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('should show the fallback for a network failure', async () => {
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('Failed to fetch', 'NETWORK_ERROR')
    );
    const u = userEvent.setup();
    render(<ProfileForm user={user} />);

    await editAndSave(u);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not update your profile. Try again in a moment.'
    );
  });

  it('should clear the previous alert when Save Changes is pressed again', async () => {
    vi.mocked(apiClient.patch).mockRejectedValue(new APIClientError('Nope', 'FORBIDDEN', 403));
    const u = userEvent.setup();
    render(<ProfileForm user={user} />);
    await editAndSave(u);
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    vi.mocked(apiClient.patch).mockImplementation(() => new Promise(() => {}));
    await u.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});
