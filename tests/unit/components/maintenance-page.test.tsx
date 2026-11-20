// @vitest-environment happy-dom

/**
 * MaintenancePage: the catalogue's text around the admin's own message and
 * downtime, which render as given (§138 t-1073).
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import en from '@/lib/i18n/messages/en.json';
import { MaintenancePage } from '@/components/maintenance-page';

describe('MaintenancePage', () => {
  it('shows the catalogue title and default message when the admin set none', () => {
    render(<MaintenancePage />);

    expect(screen.getByText(en.maintenance.title)).toBeInTheDocument();
    expect(screen.getByText(en.maintenance.defaultMessage)).toBeInTheDocument();
    expect(screen.queryByText(/Estimated downtime/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it("shows the admin's message and downtime as given", () => {
    render(<MaintenancePage message="Database upgrade in progress" estimatedDowntime="2 hours" />);

    expect(screen.getByText('Database upgrade in progress')).toBeInTheDocument();
    expect(screen.queryByText(en.maintenance.defaultMessage)).not.toBeInTheDocument();
    expect(screen.getByText('Estimated downtime: 2 hours')).toBeInTheDocument();
  });

  it('offers an admin the way into the admin dashboard', () => {
    render(<MaintenancePage isAdmin />);

    expect(screen.getByText(en.maintenance.adminBypass)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: en.maintenance.goToAdmin })).toHaveAttribute(
      'href',
      '/admin'
    );
  });
});
