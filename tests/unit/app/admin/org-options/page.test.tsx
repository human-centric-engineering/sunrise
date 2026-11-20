// @vitest-environment happy-dom

/**
 * Admin — Options page (§135 t-1054, §138 t-1074).
 *
 * A thin shell over `GET /api/v1/orgs/[id]` (the org's default language) and
 * `GET /api/v1/orgs/[id]/entitlements`: it hands what each route answers to
 * its form, explains when no org is entered (fetching nothing), and shows a
 * load failure as an alert in that section's place, never as "no language"
 * or "no options". A support session is told why the language is not shown,
 * and the page does not ask a route that would refuse it. Only `serverFetch`
 * is faked.
 *
 * @see app/admin/org-options/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/auth/admin-page-viewer', () => ({
  requestActingOrg: vi.fn(),
  requestSupportSession: vi.fn(),
}));
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
const formProps = vi.fn();
vi.mock('@/components/admin/org-options/org-options-form', () => ({
  OrgOptionsForm: (props: unknown) => {
    formProps(props);
    return <div data-testid="options-form" />;
  },
}));
const languageProps = vi.fn();
vi.mock('@/components/admin/org-options/org-language-form', () => ({
  OrgLanguageForm: (props: unknown) => {
    languageProps(props);
    return <div data-testid="language-form" />;
  },
}));

import OrgOptionsPage from '@/app/admin/org-options/page';
import { requestActingOrg, requestSupportSession } from '@/lib/auth/admin-page-viewer';
import { serverFetch } from '@/lib/api/server-fetch';
import { localeOptions } from '@/lib/i18n/locale-options';
import { apiFailure, apiSuccess } from '@/tests/helpers/api';

const ORG = { id: 'org-entered', name: 'Acme' };
const OPTIONS = {
  orgId: ORG.id,
  unreadable: false,
  mayChange: true,
  registrationFailed: false,
  switches: [],
};
const ENTITLEMENTS_URL = '/api/v1/orgs/org-entered/entitlements';
const ORG_URL = '/api/v1/orgs/org-entered';

/** Answer each route the page reads by its URL. */
function answer(routes: Record<string, () => Response>) {
  vi.mocked(serverFetch).mockImplementation(async (url) => {
    const route = routes[String(url)];
    if (!route) throw new Error(`unexpected fetch ${String(url)}`);
    return route();
  });
}

describe('OrgOptionsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requestActingOrg).mockResolvedValue(ORG);
    vi.mocked(requestSupportSession).mockResolvedValue(null);
  });

  it("loads the entered org's language and options and hands each to its form", async () => {
    answer({
      [ENTITLEMENTS_URL]: () => apiSuccess(OPTIONS),
      [ORG_URL]: () => apiSuccess({ id: ORG.id, settings: { retention: null, locale: 'en-XA' } }),
    });

    render(await OrgOptionsPage());

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Options for Acme');
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Language');
    expect(formProps).toHaveBeenCalledWith({ orgId: ORG.id, options: OPTIONS });
    expect(languageProps).toHaveBeenCalledWith({
      orgId: ORG.id,
      locale: 'en-XA',
      options: localeOptions(),
    });
  });

  it('hands the form null when the org has no default language', async () => {
    answer({
      [ENTITLEMENTS_URL]: () => apiSuccess(OPTIONS),
      [ORG_URL]: () => apiSuccess({ id: ORG.id, settings: { retention: null, locale: null } }),
    });

    render(await OrgOptionsPage());

    expect(languageProps).toHaveBeenCalledWith(expect.objectContaining({ locale: null }));
  });

  it('says the language could not be loaded, and still shows the options', async () => {
    answer({
      [ENTITLEMENTS_URL]: () => apiSuccess(OPTIONS),
      [ORG_URL]: () => apiFailure(500),
    });

    render(await OrgOptionsPage());

    expect(screen.getByRole('alert')).toHaveTextContent(
      'This organisation’s language could not be loaded.'
    );
    expect(screen.queryByTestId('language-form')).not.toBeInTheDocument();
    expect(screen.getByTestId('options-form')).toBeInTheDocument();
  });

  it('says the options could not be loaded rather than showing none', async () => {
    answer({
      [ENTITLEMENTS_URL]: () => apiFailure(500),
      [ORG_URL]: () => apiSuccess({ id: ORG.id, settings: { locale: null } }),
    });

    render(await OrgOptionsPage());

    expect(screen.getByRole('alert')).toHaveTextContent(
      'This organisation’s options could not be loaded.'
    );
    expect(screen.queryByTestId('options-form')).not.toBeInTheDocument();
    expect(screen.getByTestId('language-form')).toBeInTheDocument();
  });

  it('tells a support session the language is not shown, and does not read it', async () => {
    vi.mocked(requestSupportSession).mockResolvedValue({
      state: 'active',
      orgId: ORG.id,
      orgName: ORG.name,
      level: 'ADMIN',
    } as Awaited<ReturnType<typeof requestSupportSession>>);
    answer({ [ENTITLEMENTS_URL]: () => apiSuccess(OPTIONS) });

    render(await OrgOptionsPage());

    expect(screen.getByRole('note')).toHaveTextContent(
      'Support staff cannot see or change this organisation’s language.'
    );
    expect(vi.mocked(serverFetch).mock.calls.map(([url]) => url)).toEqual([ENTITLEMENTS_URL]);
    expect(screen.getByTestId('options-form')).toBeInTheDocument();
  });

  it('explains, and fetches nothing, when no org is entered', async () => {
    vi.mocked(requestActingOrg).mockResolvedValue(null);

    render(await OrgOptionsPage());

    expect(screen.getByText(/not acting in an organisation/)).toBeInTheDocument();
    expect(serverFetch).not.toHaveBeenCalled(); // test-review:accept no_arg_called — nothing to load;
  });
});
