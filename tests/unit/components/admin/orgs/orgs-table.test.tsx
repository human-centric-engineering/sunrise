// @vitest-environment happy-dom

/**
 * OrgsTable (§120 t-745) — every org, linking to its page.
 *
 * @see components/admin/orgs/orgs-table.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';

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

  it('says so when there is nothing to list', () => {
    render(<OrgsTable installOrgId={INSTALL} orgs={[]} />);
    expect(screen.getByText('No organisations could be loaded.')).toBeInTheDocument();
  });
});
