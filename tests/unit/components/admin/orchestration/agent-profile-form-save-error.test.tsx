// @vitest-environment happy-dom

/**
 * AgentProfileForm — failed save (§124)
 *
 * The error sits in the sticky bar beside Save, so it stays in view; a field
 * the server named gets its message under it and takes focus.
 *
 * @see components/admin/orchestration/agent-profile-form.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  AgentProfileForm,
  type AgentProfileRow,
} from '@/components/admin/orchestration/agent-profile-form';

vi.mock('next/navigation', async () => {
  const { createMockRouter } = await import('@/tests/types/mocks');
  return {
    useRouter: () => createMockRouter(),
    useSearchParams: () => ({ get: () => null }),
  };
});

// The real APIClientError, so the form reads `details` as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const PROFILE: AgentProfileRow = {
  id: 'prof-1',
  name: 'Support Family',
  slug: 'support-family',
  description: 'Shared profile.',
  persona: 'You are a calm senior support specialist.',
  brandVoiceInstructions: 'Friendly and concise.',
  guardrails: 'Never give medical advice.',
};

describe('AgentProfileForm — failed save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows the failure in the sticky bar beside Save, and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('Profile name already taken', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    render(<AgentProfileForm mode="edit" profile={PROFILE} />);

    const save = screen.getByRole('button', { name: /save changes/i });
    await user.click(save);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Profile name already taken');
    const bar = alert.parentElement;
    expect(bar).toHaveClass('sticky');
    expect(bar).toContainElement(save);
    expect(alert).toHaveFocus();
  });

  it('puts a field the server rejected under that field and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('Invalid request body', 'VALIDATION_ERROR', 400, {
        errors: [{ path: 'persona', message: 'Persona is too long' }],
      })
    );
    const user = userEvent.setup();
    render(<AgentProfileForm mode="edit" profile={PROFILE} />);

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText('Persona is too long')).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('[name="persona"]')).toHaveFocus());
    expect(screen.getByRole('alert')).toHaveTextContent('1 field needs fixing.');
  });

  it('clears the last failure when Save is pressed again', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch)
      .mockRejectedValueOnce(new APIClientError('Profile name already taken', 'CONFLICT', 409))
      .mockResolvedValueOnce(PROFILE);
    const user = userEvent.setup();
    render(<AgentProfileForm mode="edit" profile={PROFILE} />);

    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(apiClient.patch).toHaveBeenCalledTimes(2);
  });
});
