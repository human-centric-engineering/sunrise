// @vitest-environment happy-dom

/**
 * Admin — Support access page (§121 t-823).
 *
 * The page is a thin shell, so what is under test is what it chooses to show:
 * the grant form to an owner of the entered org only (the vendor never sees
 * it), the list to everyone it admits, and a plain explanation in place of
 * either at `single` and in the install org — where it fetches nothing.
 * Grants that cannot be loaded render the page's own alert, and are logged,
 * never an empty list (#518). Only `serverFetch` is faked: the real parser and
 * `loadServerData` run.
 *
 * @see app/admin/support-access/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/auth/admin-page-viewer', () => ({
  requestActingOrg: vi.fn(),
  requestPrincipal: vi.fn(),
}));

// Only the network is faked: the real parseApiResponse and server-load run.
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
}));

const multi = vi.hoisted(() => ({ on: true }));
vi.mock('@/lib/tenancy/context', () => ({ isMultiTenant: () => multi.on }));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const tableProps = vi.fn();
const formProps = vi.fn();
const activityProps = vi.fn();

vi.mock('@/components/admin/support-access/support-grants-table', () => ({
  SupportGrantsTable: (props: unknown) => {
    tableProps(props);
    return <div data-testid="grants-table" />;
  },
}));

vi.mock('@/components/admin/support-access/support-grant-form', () => ({
  SupportGrantForm: (props: unknown) => {
    formProps(props);
    return <div data-testid="grant-form" />;
  },
}));

vi.mock('@/components/admin/support-access/support-activity-table', () => ({
  SupportActivityTable: (props: unknown) => {
    activityProps(props);
    return <div data-testid="activity-table" />;
  },
}));

import SupportAccessPage from '@/app/admin/support-access/page';
import { requestActingOrg, requestPrincipal } from '@/lib/auth/admin-page-viewer';
import { serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { apiFailure, apiSuccess } from '@/tests/helpers/api';

const ORG = { id: 'org-entered', name: 'Acme' };
const OPEN = { id: 'g-1', open: true };
const ENDED = { id: 'g-0', open: false };

function actAs(org: { id: string; name: string } | null, orgId: string | null, orgRole: string) {
  vi.mocked(requestActingOrg).mockResolvedValue(org);
  vi.mocked(requestPrincipal).mockResolvedValue({ principal: { orgId, orgRole } } as never);
}

function grantsAre(grants: unknown[]) {
  vi.mocked(serverFetch).mockResolvedValue(apiSuccess({ grants }));
}

describe('SupportAccessPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    multi.on = true;
  });

  it('gives an owner of the entered org the form, saying it replaces an open grant, and the list', async () => {
    actAs(ORG, ORG.id, 'OWNER');
    grantsAre([OPEN, ENDED]);

    render(await SupportAccessPage());

    expect(vi.mocked(serverFetch).mock.calls[0][0]).toBe('/api/v1/orgs/org-entered/support-grants');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Support access for Acme');
    expect(formProps).toHaveBeenCalledWith({ orgId: ORG.id, replacesOpenGrant: true });
    expect(tableProps).toHaveBeenCalledWith({ orgId: ORG.id, grants: [OPEN, ENDED] });
  });

  it('tells the form there is nothing to replace when no grant is open', async () => {
    actAs(ORG, ORG.id, 'OWNER');
    grantsAre([ENDED]);

    render(await SupportAccessPage());

    expect(formProps).toHaveBeenCalledWith({ orgId: ORG.id, replacesOpenGrant: false });
  });

  it('shows an ADMIN the list but not the form', async () => {
    actAs(ORG, ORG.id, 'ADMIN');
    grantsAre([OPEN]);

    render(await SupportAccessPage());

    expect(screen.queryByTestId('grant-form')).not.toBeInTheDocument();
    expect(screen.getByText(/Only an owner of this organisation/)).toBeInTheDocument();
    expect(screen.getByTestId('grants-table')).toBeInTheDocument();
  });

  it('does not give the form to an OWNER of another org, such as a platform admin', async () => {
    actAs(ORG, INSTALL_ORG_ID, 'OWNER');
    grantsAre([]);

    render(await SupportAccessPage());

    expect(screen.queryByTestId('grant-form')).not.toBeInTheDocument();
  });

  it('explains, and fetches nothing, in the install org', async () => {
    actAs({ id: INSTALL_ORG_ID, name: 'Default' }, INSTALL_ORG_ID, 'OWNER');

    render(await SupportAccessPage());

    expect(screen.getByText(/belongs to the platform/)).toBeInTheDocument();
    expect(serverFetch).not.toHaveBeenCalled();
    expect(screen.queryByTestId('grant-form')).not.toBeInTheDocument();
    expect(screen.queryByTestId('grants-table')).not.toBeInTheDocument();
  });

  it('explains, and shows neither form nor list, at single', async () => {
    multi.on = false;
    actAs(ORG, ORG.id, 'OWNER');
    grantsAre([]);

    render(await SupportAccessPage());

    expect(screen.getByText(/more than one organisation/)).toBeInTheDocument();
    expect(screen.queryByTestId('grant-form')).not.toBeInTheDocument();
    expect(screen.queryByTestId('grants-table')).not.toBeInTheDocument();
  });

  it('withholds the form from an owner when the grants could not be loaded', async () => {
    // Without the list the page cannot say whether granting replaces an open
    // grant, so it offers no grant rather than one that might silently replace.
    actAs(ORG, ORG.id, 'OWNER');
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(500));

    render(await SupportAccessPage());

    expect(formProps).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('cannot be granted until they can');
  });

  it('says so when the grants could not be loaded', async () => {
    actAs(ORG, ORG.id, 'ADMIN');
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(500));

    render(await SupportAccessPage());

    expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded');
    expect(screen.queryByTestId('grants-table')).not.toBeInTheDocument();
    // Before #518 a non-OK answer was not logged at all.
    expect(logger.error).toHaveBeenCalled();
  });

  it('says so, and logs, when the fetch rejects', async () => {
    actAs(ORG, ORG.id, 'ADMIN');
    const failure = new Error('ECONNREFUSED');
    vi.mocked(serverFetch).mockRejectedValue(failure);

    render(await SupportAccessPage());

    expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded');
    expect(screen.queryByTestId('grants-table')).not.toBeInTheDocument();
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), failure, expect.any(Object));
  });

  it('shows what support did, for the same org and grants, when there are grants', async () => {
    actAs(ORG, ORG.id, 'ADMIN');
    grantsAre([OPEN, ENDED]);

    render(await SupportAccessPage());

    expect(screen.getByTestId('activity-table')).toBeInTheDocument();
    expect(activityProps).toHaveBeenCalledWith({ orgId: ORG.id, grants: [OPEN, ENDED] });
  });

  it('shows no activity table when the org has never had a grant', async () => {
    actAs(ORG, ORG.id, 'OWNER');
    grantsAre([]);

    render(await SupportAccessPage());

    expect(screen.getByTestId('grants-table')).toBeInTheDocument();
    expect(screen.queryByTestId('activity-table')).not.toBeInTheDocument();
    expect(activityProps).not.toHaveBeenCalled();
  });

  it('shows no activity table when the grants could not be loaded', async () => {
    actAs(ORG, ORG.id, 'ADMIN');
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(500));

    render(await SupportAccessPage());

    expect(screen.queryByTestId('activity-table')).not.toBeInTheDocument();
    expect(activityProps).not.toHaveBeenCalled();
  });
});
