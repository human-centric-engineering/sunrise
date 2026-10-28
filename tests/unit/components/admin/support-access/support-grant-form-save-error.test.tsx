// @vitest-environment happy-dom

/**
 * SupportGrantForm — failed save (§124)
 *
 * A refused grant shows beside the button that sent it; a rejected reason
 * gets its message under the field and the focus.
 *
 * @see components/admin/support-access/support-grant-form.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SupportGrantForm } from '@/components/admin/support-access/support-grant-form';

vi.mock('next/navigation', async () => {
  const { createMockRouter } = await import('@/tests/types/mocks');
  return { useRouter: () => createMockRouter() };
});

// The real APIClientError, so the form reads `details` as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

/** Gives a reason and presses Grant. */
async function grant() {
  const user = userEvent.setup();
  render(<SupportGrantForm orgId="org-1" replacesOpenGrant={false} />);
  await user.type(screen.getByLabelText(/^Reason/, { selector: 'textarea' }), 'Ticket 42');
  const button = screen.getByRole('button', { name: 'Grant access' });
  await user.click(button);
  return button;
}

describe('SupportGrantForm — failed save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows the failure beside Grant, and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Only an owner of this organisation may grant support access', 'X', 403)
    );

    const button = await grant();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Only an owner of this organisation may grant support access');
    expect(alert.parentElement).toContainElement(button);
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('puts a rejected reason’s message under it and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Invalid request body', 'VALIDATION_ERROR', 400, {
        errors: [{ path: 'reason', message: 'Reason must be 1000 characters or fewer' }],
      })
    );

    await grant();

    await waitFor(() => expect(document.querySelector('[name="reason"]')).toHaveFocus());
    expect(screen.getByText('Reason must be 1000 characters or fewer')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('1 field needs fixing.');
  });
});
