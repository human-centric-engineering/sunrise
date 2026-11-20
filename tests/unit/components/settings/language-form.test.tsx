// @vitest-environment happy-dom

/**
 * LanguageForm (§138 t-1073)
 *
 * The settings picker for a person's own interface language. Saves
 * `User.locale` through `PATCH /api/v1/users/me` (null follows the org),
 * then refreshes the page so it re-renders in the new language.
 *
 * @see components/settings/language-form.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';
import { LanguageForm } from '@/components/settings/language-form';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { createMockRouter } from '@/tests/types/mocks';

vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { patch: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
}));

const OPTIONS = [
  { tag: 'en', name: 'English' },
  { tag: 'fr', name: 'Français' },
];

const FOLLOW_ORG = "Use my organisation's language";

function picker() {
  return screen.getByRole('combobox', { name: /screen language/i });
}

async function choose(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(picker());
  await user.click(within(screen.getByRole('listbox')).getByRole('option', { name }));
}

describe('components/settings/language-form', () => {
  let router: ReturnType<typeof createMockRouter>;

  beforeEach(() => {
    vi.clearAllMocks();
    router = createMockRouter();
    vi.mocked(useRouter).mockReturnValue(router);
    vi.mocked(apiClient.patch).mockResolvedValue({});
  });

  it('lists following the org first, then each language by its own name', async () => {
    const user = userEvent.setup();
    render(<LanguageForm locale={null} options={OPTIONS} />);

    await user.click(picker());
    const options = within(screen.getByRole('listbox')).getAllByRole('option');

    expect(options.map((o) => o.textContent)).toEqual([FOLLOW_ORG, 'English', 'Français']);
  });

  it('preselects the stored language', () => {
    render(<LanguageForm locale="fr" options={OPTIONS} />);

    expect(picker()).toHaveTextContent('Français');
  });

  it('preselects following the org when nothing is stored', () => {
    render(<LanguageForm locale={null} options={OPTIONS} />);

    expect(picker()).toHaveTextContent(FOLLOW_ORG);
  });

  it('preselects following the org when the stored language is no longer offered', () => {
    render(<LanguageForm locale="de" options={OPTIONS} />);

    expect(picker()).toHaveTextContent(FOLLOW_ORG);
  });

  it('lets a stored language that is no longer offered be cleared', async () => {
    const user = userEvent.setup();
    render(<LanguageForm locale="de" options={OPTIONS} />);

    // The stored "de" differs from what is shown, so there is something to save.
    const save = screen.getByRole('button', { name: 'Save Language' });
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith(API.USERS.ME, { body: { locale: null } })
    );
    await waitFor(() => expect(save).toBeDisabled());
  });

  it('keeps Save disabled until the choice changes', async () => {
    const user = userEvent.setup();
    render(<LanguageForm locale={null} options={OPTIONS} />);

    expect(screen.getByRole('button', { name: 'Save Language' })).toBeDisabled();
    await choose(user, 'Français');
    expect(screen.getByRole('button', { name: 'Save Language' })).toBeEnabled();
  });

  it('saves the chosen tag and refreshes the page', async () => {
    const user = userEvent.setup();
    render(<LanguageForm locale={null} options={OPTIONS} />);

    await choose(user, 'Français');
    await user.click(screen.getByRole('button', { name: 'Save Language' }));

    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith(API.USERS.ME, { body: { locale: 'fr' } })
    );
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Language saved')).toBeInTheDocument();
    // Saved: nothing left to save until it changes again.
    expect(screen.getByRole('button', { name: 'Save Language' })).toBeDisabled();
  });

  it('sends null to follow the org again', async () => {
    const user = userEvent.setup();
    render(<LanguageForm locale="fr" options={OPTIONS} />);

    await choose(user, FOLLOW_ORG);
    await user.click(screen.getByRole('button', { name: 'Save Language' }));

    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith(API.USERS.ME, { body: { locale: null } })
    );
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1));
  });

  it('shows a refused save beside Save, and does not refresh', async () => {
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('Language is not supported', 'VALIDATION_ERROR', 400)
    );
    const user = userEvent.setup();
    render(<LanguageForm locale={null} options={OPTIONS} />);

    await choose(user, 'Français');
    await user.click(screen.getByRole('button', { name: 'Save Language' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Language is not supported');
    expect(alert.nextElementSibling).toBe(screen.getByRole('button', { name: 'Save Language' }));
    expect(router.refresh).not.toHaveBeenCalled();
    expect(screen.queryByText('Language saved')).not.toBeInTheDocument();
  });

  it('shows its own message, not the browser text, for a network failure', async () => {
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('Failed to fetch', 'NETWORK_ERROR')
    );
    const user = userEvent.setup();
    render(<LanguageForm locale={null} options={OPTIONS} />);

    await choose(user, 'English');
    await user.click(screen.getByRole('button', { name: 'Save Language' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not save your language. Try again in a moment.');
    expect(alert).not.toHaveTextContent('Failed to fetch');
  });
});
