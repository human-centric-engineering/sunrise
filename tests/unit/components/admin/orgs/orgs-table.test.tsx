// @vitest-environment happy-dom

/**
 * OrgsTable (§120 t-745) — every org, linking to its page.
 *
 * @see components/admin/orgs/orgs-table.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

import { apiClient, APIClientError } from '@/lib/api/client';

import { OrgsTable, type OrgListItem } from '@/components/admin/orgs/orgs-table';

const INSTALL = 'cminstall0000000000000org';

function org(overrides: Partial<OrgListItem>): OrgListItem {
  return {
    id: 'cmorg00000000000000grant',
    slug: 'acme',
    name: 'Acme',
    status: 'ACTIVE',
    createdAt: '2026-09-01T00:00:00.000Z',
    memberCount: 3,
    ownerCount: 1,
    supportGrant: null,
    ...overrides,
  };
}

describe('OrgsTable', () => {
  it('lists each org, linking to its page, and marks the install org', () => {
    render(
      <OrgsTable
        installOrgId={INSTALL}
        orgs={[
          org({ id: INSTALL, slug: 'default', name: 'Default' }),
          org({ status: 'SUSPENDED', ownerCount: 0 }),
        ]}
      />
    );

    expect(screen.getByRole('link', { name: 'Acme' })).toHaveAttribute(
      'href',
      '/admin/orgs/cmorg00000000000000grant'
    );
    const [, installRow, acmeRow] = screen.getAllByRole('row');
    expect(within(installRow).getByText('Install org')).toBeInTheDocument();
    expect(within(acmeRow).queryByText('Install org')).not.toBeInTheDocument();
    expect(acmeRow).toHaveTextContent('suspended');
  });

  it('says which orgs have an open support grant, and at what level', () => {
    render(
      <OrgsTable
        installOrgId={INSTALL}
        orgs={[
          org({ id: 'cmorg0000000000000000none' }),
          org({
            id: 'cmorg0000000000000000open',
            name: 'Globex',
            supportGrant: { level: 'READ_ONLY', expiresAt: '2026-10-17T09:00:00.000Z' },
          }),
          org({
            id: 'cmorg00000000000000admin',
            name: 'Initech',
            supportGrant: { level: 'ADMIN', expiresAt: '2026-10-17T09:00:00.000Z' },
          }),
        ]}
      />
    );
    const [, noneRow, readOnlyRow, adminRow] = screen.getAllByRole('row');
    expect(noneRow).toHaveTextContent('None');
    expect(readOnlyRow).toHaveTextContent('Read-only until');
    expect(adminRow).toHaveTextContent('Admin until');
    expect(adminRow).not.toHaveTextContent('None');
    // Enter is offered on an org with an open grant, and only there (§121 t-824).
    expect(within(noneRow).queryByRole('button')).not.toBeInTheDocument();
    expect(
      within(readOnlyRow).getByRole('button', { name: 'Enter Globex as support' })
    ).toBeInTheDocument();
  });

  describe('Enter as support (§121 t-824)', () => {
    const assign = vi.fn();
    const originalLocation = window.location;
    const granted = org({
      id: 'cmorg0000000000000000open',
      name: 'Globex',
      supportGrant: { level: 'ADMIN', expiresAt: '2030-01-01T00:00:00.000Z' },
    });

    beforeEach(() => {
      vi.clearAllMocks();
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...originalLocation, assign },
      });
    });

    afterEach(() => {
      Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
    });

    it('switches into the org, then loads the console there', async () => {
      vi.mocked(apiClient.post).mockResolvedValue({});
      render(<OrgsTable installOrgId={INSTALL} orgs={[granted]} />);

      await userEvent.click(screen.getByRole('button', { name: 'Enter Globex as support' }));

      expect(apiClient.post).toHaveBeenCalledWith('/api/v1/orgs/switch', {
        body: { orgId: 'cmorg0000000000000000open' },
      });
      await waitFor(() => expect(assign).toHaveBeenCalledWith('/admin'));
    });

    it('shows the refusal and stays put when the grant no longer admits', async () => {
      vi.mocked(apiClient.post).mockRejectedValue(
        new APIClientError('You are not a member of that organisation')
      );
      render(<OrgsTable installOrgId={INSTALL} orgs={[granted]} />);

      await userEvent.click(screen.getByRole('button', { name: 'Enter Globex as support' }));

      expect(
        await screen.findByText('You are not a member of that organisation')
      ).toBeInTheDocument();
      expect(assign).not.toHaveBeenCalled();
    });
  });

  it('says so when there is nothing to list', () => {
    render(<OrgsTable installOrgId={INSTALL} orgs={[]} />);
    expect(screen.getByText('No organisations could be loaded.')).toBeInTheDocument();
  });
});
