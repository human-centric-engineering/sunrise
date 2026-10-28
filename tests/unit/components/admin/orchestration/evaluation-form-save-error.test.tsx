// @vitest-environment happy-dom

/**
 * EvaluationForm — failed save (§124)
 *
 * A refused create shows directly above Create Evaluation, and a field the
 * server named gets its message and the focus.
 *
 * @see components/admin/orchestration/evaluation-form.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { EvaluationForm } from '@/components/admin/orchestration/evaluation-form';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, refresh: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));

// The real APIClientError, so the form reads `details` as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const AGENTS = [{ id: 'agent-1', name: 'Bot Alpha' }];

/** Fills the form so client validation passes, and returns the Create button. */
async function fillValid(user: ReturnType<typeof userEvent.setup>) {
  render(<EvaluationForm agents={AGENTS} />);
  await user.click(screen.getByRole('combobox'));
  await user.click(await screen.findByRole('option', { name: /bot alpha/i }));
  await user.type(screen.getByRole('textbox', { name: /title/i }), 'Tone Check');
  return screen.getByRole('button', { name: /create evaluation/i });
}

describe('EvaluationForm — failed save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows the failure beside Create Evaluation, and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Agent not found', 'NOT_FOUND', 404)
    );
    const user = userEvent.setup();
    const create = await fillValid(user);

    await user.click(create);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Agent not found');
    expect(alert.parentElement).toContainElement(create);
    // The form holds every field too: the error's container is Save's own.
    expect(alert.parentElement).not.toContainElement(
      screen.getByRole('textbox', { name: /title/i })
    );
    expect(alert).toHaveFocus();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('puts a field the server rejected under that field and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Invalid request body', 'VALIDATION_ERROR', 400, {
        errors: [{ path: 'title', message: 'Title must be less than 200 characters' }],
      })
    );
    const user = userEvent.setup();
    const create = await fillValid(user);

    await user.click(create);

    expect(await screen.findByText('Title must be less than 200 characters')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('1 field needs fixing.');
    await waitFor(() => expect(document.querySelector('[name="title"]')).toHaveFocus());
  });

  it('clears the failure on the next press, even one client validation blocks', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Agent not found', 'NOT_FOUND', 404)
    );
    const user = userEvent.setup();
    const create = await fillValid(user);
    await user.click(create);
    await screen.findByRole('alert');

    await user.clear(screen.getByRole('textbox', { name: /title/i }));
    await user.click(create);

    expect(await screen.findByText('Title is required')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
