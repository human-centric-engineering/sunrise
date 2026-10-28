// @vitest-environment happy-dom

/**
 * FeatureFlagForm — failed save (§124)
 *
 * The dialog shows a refused save directly above its footer's Save, and a
 * field the server named gets its message and the focus.
 *
 * @see components/admin/feature-flag-form.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { FeatureFlagForm } from '@/components/admin/feature-flag-form';

// The real APIClientError, so the form reads `details` as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

function renderForm() {
  render(<FeatureFlagForm open={true} onOpenChange={vi.fn()} onSuccess={vi.fn()} />);
}

describe('FeatureFlagForm — failed save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows the failure directly above the footer holding Save, and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Flag already exists', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByLabelText('Name'), 'NEW_FLAG');
    const save = screen.getByRole('button', { name: /create flag/i });
    await user.click(save);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Flag already exists');
    expect(alert.parentElement).toContainElement(save);
    // The next thing after the error is the footer with Save in it.
    expect(alert.nextElementSibling).toContainElement(save);
    expect(alert).toHaveFocus();
  });

  it('puts a field the server rejected under that field and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Invalid request body', 'VALIDATION_ERROR', 400, {
        errors: [{ path: 'description', message: 'Description is not allowed here' }],
      })
    );
    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByLabelText('Name'), 'NEW_FLAG');
    await user.click(screen.getByRole('button', { name: /create flag/i }));

    expect(await screen.findByText('Description is not allowed here')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('1 field needs fixing.');
    await waitFor(() => expect(document.querySelector('[name="description"]')).toHaveFocus());
  });

  it('clears the failure on the next press of Save', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post)
      .mockRejectedValueOnce(new APIClientError('Flag already exists', 'CONFLICT', 409))
      .mockImplementationOnce(() => new Promise(() => {}));
    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByLabelText('Name'), 'NEW_FLAG');
    await user.click(screen.getByRole('button', { name: /create flag/i }));
    await screen.findByRole('alert');

    await user.click(screen.getByRole('button', { name: /create flag/i }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});
