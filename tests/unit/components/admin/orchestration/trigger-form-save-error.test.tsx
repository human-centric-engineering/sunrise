// @vitest-environment happy-dom

/**
 * TriggerForm — failed save (§124)
 *
 * The form is long and its Save is at the bottom, so a refused save shows
 * beside Save, not at the top. No field renders its own error, so every
 * server message joins that summary.
 *
 * @see components/admin/orchestration/trigger-form.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TriggerForm, type WorkflowOption } from '@/components/admin/orchestration/trigger-form';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));

// The real APIClientError, so the form reads `details` as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const WORKFLOWS: WorkflowOption[] = [
  { id: 'wf_1', name: 'Inbound conversation', slug: 'inbound-conv', isActive: true },
];

function renderForm() {
  render(
    <TriggerForm
      mode="create"
      workflows={WORKFLOWS}
      agents={[]}
      enabledChannels={['slack']}
      baseUrl="https://app.example.com"
    />
  );
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My trigger' } });
}

describe('TriggerForm — failed save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows the failure beside Save at the bottom of the form, and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('A trigger already exists for this workflow', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    renderForm();

    const save = screen.getByRole('button', { name: 'Create trigger' });
    await user.click(save);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('A trigger already exists for this workflow');
    expect(alert.parentElement).toContainElement(save);
    // Directly above the button row, not at the top of the form.
    expect(alert.nextElementSibling).toContainElement(save);
    expect(alert).toHaveFocus();
  });

  it('puts a field-level server message in the summary, since no field shows one', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Invalid request body', 'VALIDATION_ERROR', 400, {
        errors: [{ path: 'name', message: 'Name is too long' }],
      })
    );
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('button', { name: 'Create trigger' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Name is too long');
    expect(alert).not.toHaveTextContent('field needs fixing');
    expect(alert).toHaveFocus();
  });

  it('shows the fallback for an error the server never wrote', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(new TypeError('x is undefined'));
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('button', { name: 'Create trigger' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Save failed');
  });

  it('clears the failure on the next press of Save', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post)
      .mockRejectedValueOnce(new APIClientError('Conflict', 'CONFLICT', 409))
      .mockImplementationOnce(() => new Promise(() => {}));
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('button', { name: 'Create trigger' }));
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Create trigger' }));

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});
