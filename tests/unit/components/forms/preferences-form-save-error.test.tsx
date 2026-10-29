// @vitest-environment happy-dom

/**
 * PreferencesForm save-error behaviour (t-950)
 *
 * A refused save is shown through the shared `<SaveError>` directly before
 * Save Preferences, focused. The form has no fields to place a message under,
 * so a validation refusal's text joins the summary.
 *
 * @see components/forms/preferences-form.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PreferencesForm } from '@/components/forms/preferences-form';
import { apiClient, APIClientError } from '@/lib/api/client';
import { createMockRouter } from '@/tests/types/mocks';
import type { UserPreferences } from '@/types';

vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { patch: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
}));

vi.mock('@/lib/analytics', () => ({
  useAnalytics: vi.fn(() => ({ track: vi.fn() })),
  EVENTS: { PREFERENCES_UPDATED: 'preferences_updated' },
}));

const preferences: UserPreferences = {
  email: { marketing: false, productUpdates: true, securityAlerts: true },
};

describe('components/forms/preferences-form save errors', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { useRouter } = await import('next/navigation');
    vi.mocked(useRouter).mockReturnValue(createMockRouter());
  });

  it('should show a refused save directly before Save Preferences, focused', async () => {
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('Preferences are read-only', 'FORBIDDEN', 403)
    );
    const user = userEvent.setup();
    render(<PreferencesForm preferences={preferences} />);

    await user.click(screen.getByRole('button', { name: 'Save Preferences' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Preferences are read-only');
    expect(alert.nextElementSibling).toBe(screen.getByRole('button', { name: 'Save Preferences' }));
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('should keep what the server said about an unplaceable field in the summary', async () => {
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('Validation failed', 'VALIDATION_ERROR', 400, {
        errors: [{ path: 'email.marketing', message: 'Marketing must be a boolean' }],
      })
    );
    const user = userEvent.setup();
    render(<PreferencesForm preferences={preferences} />);

    await user.click(screen.getByRole('button', { name: 'Save Preferences' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Marketing must be a boolean');
  });

  it('should show the fallback, not the browser text, for a network failure', async () => {
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('Failed to fetch', 'NETWORK_ERROR')
    );
    const user = userEvent.setup();
    render(<PreferencesForm preferences={preferences} />);

    await user.click(screen.getByRole('button', { name: 'Save Preferences' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not save your preferences. Try again in a moment.');
    expect(alert).not.toHaveTextContent('Failed to fetch');
  });

  it('should remove the alert when the next save is pressed, and show no success text for the failed one', async () => {
    vi.mocked(apiClient.patch).mockRejectedValue(new APIClientError('Nope', 'FORBIDDEN', 403));
    const user = userEvent.setup();
    render(<PreferencesForm preferences={preferences} />);
    await user.click(screen.getByRole('button', { name: 'Save Preferences' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('Preferences saved successfully')).not.toBeInTheDocument();

    vi.mocked(apiClient.patch).mockImplementation(() => new Promise(() => {}));
    await user.click(screen.getByRole('button', { name: 'Save Preferences' }));

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});
