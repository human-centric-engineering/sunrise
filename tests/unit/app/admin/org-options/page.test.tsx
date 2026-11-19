// @vitest-environment happy-dom

/**
 * Admin — Options page (§135 t-1054).
 *
 * A thin shell over `GET /api/v1/orgs/[id]/entitlements`: it hands what the
 * route answers to the form, explains when no org is entered (fetching
 * nothing), and shows a load failure as an alert, never as "no options".
 * Only `serverFetch` is faked.
 *
 * @see app/admin/org-options/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/auth/admin-page-viewer', () => ({ requestActingOrg: vi.fn() }));
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

import OrgOptionsPage from '@/app/admin/org-options/page';
import { requestActingOrg } from '@/lib/auth/admin-page-viewer';
import { serverFetch } from '@/lib/api/server-fetch';
import { apiFailure, apiSuccess } from '@/tests/helpers/api';

const ORG = { id: 'org-entered', name: 'Acme' };
const OPTIONS = {
  orgId: ORG.id,
  unreadable: false,
  mayChange: true,
  registrationFailed: false,
  switches: [],
};

describe('OrgOptionsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requestActingOrg).mockResolvedValue(ORG);
  });

  it("loads the entered org's options and hands them to the form", async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(OPTIONS));

    render(await OrgOptionsPage());

    expect(vi.mocked(serverFetch).mock.calls[0][0]).toBe('/api/v1/orgs/org-entered/entitlements');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Options for Acme');
    expect(formProps).toHaveBeenCalledWith({ orgId: ORG.id, options: OPTIONS });
  });

  it('says the options could not be loaded rather than showing none', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(500));

    render(await OrgOptionsPage());

    expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded');
    expect(screen.queryByTestId('options-form')).not.toBeInTheDocument();
  });

  it('explains, and fetches nothing, when no org is entered', async () => {
    vi.mocked(requestActingOrg).mockResolvedValue(null);

    render(await OrgOptionsPage());

    expect(screen.getByText(/not acting in an organisation/)).toBeInTheDocument();
    expect(serverFetch).not.toHaveBeenCalled(); // test-review:accept no_arg_called — nothing to load;
  });
});
