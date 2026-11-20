// @vitest-environment happy-dom

/**
 * LanguageSwitch — a visitor's language switch on the public pages (§138 t-1073).
 *
 * The route it calls (`PUT /api/v1/locale`) has its own tests; these cover the
 * component: when it shows, what it lists, what it sends, and what a failed
 * store leaves on the page.
 *
 * @see components/layouts/language-switch.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';
import { createMockRouter } from '@/tests/types/mocks';

const { mockPut } = vi.hoisted(() => ({ mockPut: vi.fn() }));

vi.mock('@/lib/api/client', () => ({
  apiClient: { put: mockPut },
}));

vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { LanguageSwitch } from '@/components/layouts/language-switch';
import { API } from '@/lib/api/endpoints';

const OPTIONS = [
  { tag: 'en', name: 'English' },
  { tag: 'fr', name: 'Français' },
  { tag: 'de', name: 'Deutsch' },
];

let router: ReturnType<typeof createMockRouter>;

beforeEach(() => {
  vi.clearAllMocks();
  router = createMockRouter();
  vi.mocked(useRouter).mockReturnValue(router);
});

describe('LanguageSwitch', () => {
  it('renders nothing when there is only one language', () => {
    const { container } = render(
      <LanguageSwitch options={[{ tag: 'en', name: 'English' }]} current="en" />
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('is labelled from the catalogue and shows the current language in its own name', () => {
    render(<LanguageSwitch options={OPTIONS} current="fr" />);

    const trigger = screen.getByRole('combobox', { name: 'Language' });
    expect(trigger).toHaveTextContent('Français');
  });

  it('shows its label, not an empty switch, on a page in a language it does not list', () => {
    render(<LanguageSwitch options={OPTIONS} current="en-XA" />);

    expect(screen.getByRole('combobox', { name: 'Language' })).toHaveTextContent('Language');
  });

  it('lists every language by its native name', async () => {
    const user = userEvent.setup();
    render(<LanguageSwitch options={OPTIONS} current="en" />);

    await user.click(screen.getByRole('combobox', { name: 'Language' }));

    const names = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(names).toEqual(['English', 'Français', 'Deutsch']);
    // Each item says which language it is in, so a screen reader reads it right.
    expect(screen.getByRole('option', { name: 'Deutsch' })).toHaveAttribute('lang', 'de');
  });

  it('stores the picked language and refreshes the page', async () => {
    let store!: (value: unknown) => void;
    mockPut.mockReturnValue(new Promise((resolve) => (store = resolve)));
    const user = userEvent.setup();
    render(<LanguageSwitch options={OPTIONS} current="en" />);

    await user.click(screen.getByRole('combobox', { name: 'Language' }));
    await user.click(await screen.findByRole('option', { name: 'Deutsch' }));

    expect(mockPut).toHaveBeenCalledWith(API.PUBLIC.LOCALE, { body: { locale: 'de' } });
    // The pick shows while it is being stored.
    expect(screen.getByRole('combobox', { name: 'Language' })).toHaveTextContent('Deutsch');

    store({ locale: 'de' });
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it("shows the page's language again when the refreshed page comes back unchanged", async () => {
    mockPut.mockResolvedValue({ locale: 'de' });
    const user = userEvent.setup();
    render(<LanguageSwitch options={OPTIONS} current="en" />);

    await user.click(screen.getByRole('combobox', { name: 'Language' }));
    await user.click(await screen.findByRole('option', { name: 'Deutsch' }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1));

    // The refresh settled with the page still in English (a signed-in user's
    // own choice outranks the cookie): the pick is not left showing.
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Language' })).toHaveTextContent('English')
    );
  });

  it('follows the language the refreshed page renders in, dropping the pending pick', async () => {
    mockPut.mockResolvedValue({ locale: 'de' });
    const user = userEvent.setup();
    const { rerender } = render(<LanguageSwitch options={OPTIONS} current="en" />);

    await user.click(screen.getByRole('combobox', { name: 'Language' }));
    await user.click(await screen.findByRole('option', { name: 'Deutsch' }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1));

    // The page came back in a language other than the pick (a user's own
    // choice outranks the cookie): the switch shows what the page is in.
    rerender(<LanguageSwitch options={OPTIONS} current="fr" />);

    expect(screen.getByRole('combobox', { name: 'Language' })).toHaveTextContent('Français');
  });

  it('does not store anything when the current language is picked again', async () => {
    const user = userEvent.setup();
    render(<LanguageSwitch options={OPTIONS} current="en" />);

    await user.click(screen.getByRole('combobox', { name: 'Language' }));
    await user.click(await screen.findByRole('option', { name: 'English' }));

    expect(mockPut).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('says so when the language cannot be stored, and stays on the current one', async () => {
    mockPut.mockRejectedValue(new Error('Network down'));
    const user = userEvent.setup();
    render(<LanguageSwitch options={OPTIONS} current="en" />);

    await user.click(screen.getByRole('combobox', { name: 'Language' }));
    await user.click(await screen.findByRole('option', { name: 'Français' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Couldn’t change the language. Please try again.');
    expect(router.refresh).not.toHaveBeenCalled();
    const trigger = screen.getByRole('combobox', { name: 'Language' });
    expect(trigger).toHaveTextContent('English');
    expect(trigger).not.toBeDisabled();
    expect(trigger).toHaveAttribute('aria-describedby', alert.id);
  });

  it('clears the failure once a later pick is stored', async () => {
    mockPut
      .mockRejectedValueOnce(new Error('Network down'))
      .mockResolvedValueOnce({ locale: 'fr' });
    const user = userEvent.setup();
    render(<LanguageSwitch options={OPTIONS} current="en" />);

    await user.click(screen.getByRole('combobox', { name: 'Language' }));
    await user.click(await screen.findByRole('option', { name: 'Français' }));
    await screen.findByRole('alert');

    await user.click(screen.getByRole('combobox', { name: 'Language' }));
    await user.click(await screen.findByRole('option', { name: 'Français' }));

    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
