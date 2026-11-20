// @vitest-environment happy-dom

/**
 * OrgLanguageForm (§138 t-1074)
 *
 * The org-tier picker for the language an org's members see when they have
 * not chosen one. Saves `Org.settings.locale` through
 * `PUT /api/v1/orgs/[id]/locale` (null leaves members to their browser's),
 * then refreshes so the page re-renders in it.
 *
 * @see components/admin/org-options/org-language-form.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';
import { OrgLanguageForm } from '@/components/admin/org-options/org-language-form';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { createMockRouter } from '@/tests/types/mocks';

vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { put: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
}));

const ORG = 'org-1';
const OPTIONS = [
  { tag: 'en', name: 'English' },
  { tag: 'fr', name: 'Français' },
];
const FOLLOW_BROWSER = 'Each member’s browser language';

function picker() {
  return screen.getByRole('combobox', { name: /organisation language/i });
}

async function choose(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(picker());
  await user.click(within(screen.getByRole('listbox')).getByRole('option', { name }));
}

describe('components/admin/org-options/org-language-form', () => {
  let router: ReturnType<typeof createMockRouter>;

  beforeEach(() => {
    vi.clearAllMocks();
    router = createMockRouter();
    vi.mocked(useRouter).mockReturnValue(router);
    vi.mocked(apiClient.put).mockResolvedValue({ orgId: ORG, locale: 'fr' });
  });

  it('lists the browser default first, then each language by its own name', async () => {
    const user = userEvent.setup();
    render(<OrgLanguageForm orgId={ORG} locale={null} options={OPTIONS} />);

    await user.click(picker());
    const options = within(screen.getByRole('listbox')).getAllByRole('option');

    expect(options.map((o) => o.textContent)).toEqual([FOLLOW_BROWSER, 'English', 'Français']);
  });

  it('preselects the stored language, and the browser default when none is stored', () => {
    const { unmount } = render(<OrgLanguageForm orgId={ORG} locale="fr" options={OPTIONS} />);
    expect(picker()).toHaveTextContent('Français');
    unmount();

    render(<OrgLanguageForm orgId={ORG} locale={null} options={OPTIONS} />);
    expect(picker()).toHaveTextContent(FOLLOW_BROWSER);
  });

  it('keeps Save off until the choice changes', async () => {
    const user = userEvent.setup();
    render(<OrgLanguageForm orgId={ORG} locale={null} options={OPTIONS} />);

    expect(screen.getByRole('button', { name: 'Save language' })).toBeDisabled();
    await choose(user, 'Français');
    expect(screen.getByRole('button', { name: 'Save language' })).toBeEnabled();
  });

  it("saves the chosen language to the org's locale route and refreshes the page", async () => {
    const user = userEvent.setup();
    render(<OrgLanguageForm orgId={ORG} locale={null} options={OPTIONS} />);

    await choose(user, 'Français');
    await user.click(screen.getByRole('button', { name: 'Save language' }));

    await waitFor(() =>
      expect(apiClient.put).toHaveBeenCalledWith(API.ORGS.locale(ORG), {
        body: { locale: 'fr' },
      })
    );
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    // What was saved is now the stored choice, so there is nothing left to save.
    expect(screen.getByRole('button', { name: 'Save language' })).toBeDisabled();
  });

  it('clears the default with null when the browser default is chosen', async () => {
    const user = userEvent.setup();
    render(<OrgLanguageForm orgId={ORG} locale="fr" options={OPTIONS} />);

    await choose(user, FOLLOW_BROWSER);
    await user.click(screen.getByRole('button', { name: 'Save language' }));

    await waitFor(() =>
      expect(apiClient.put).toHaveBeenCalledWith(API.ORGS.locale(ORG), {
        body: { locale: null },
      })
    );
  });

  it('lets a stored language the install no longer offers be cleared', async () => {
    const user = userEvent.setup();
    render(<OrgLanguageForm orgId={ORG} locale="de" options={OPTIONS} />);

    expect(picker()).toHaveTextContent(FOLLOW_BROWSER);
    await user.click(screen.getByRole('button', { name: 'Save language' }));

    await waitFor(() =>
      expect(apiClient.put).toHaveBeenCalledWith(API.ORGS.locale(ORG), {
        body: { locale: null },
      })
    );
  });

  it("shows the route's refusal beside Save and does not refresh", async () => {
    vi.mocked(apiClient.put).mockRejectedValue(
      new APIClientError('Support staff cannot change an organisation’s language', 'FORBIDDEN', 403)
    );
    const user = userEvent.setup();
    render(<OrgLanguageForm orgId={ORG} locale={null} options={OPTIONS} />);

    await choose(user, 'English');
    await user.click(screen.getByRole('button', { name: 'Save language' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Support staff cannot change an organisation’s language'
    );
    expect(router.refresh).not.toHaveBeenCalled();
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });
});
