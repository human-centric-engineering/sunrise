// @vitest-environment happy-dom

/**
 * ActiveQuarantinesPanel — render tests (item #42)
 *
 * Dashboard panel listing every currently-quarantined capability. Pure
 * render: hidden when empty, one row per item otherwise.
 *
 * @see components/admin/orchestration/active-quarantines-panel.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ActiveQuarantinesPanel } from '@/components/admin/orchestration/active-quarantines-panel';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

describe('ActiveQuarantinesPanel', () => {
  it('renders nothing when empty (absence is the all-clear signal)', () => {
    const { container } = render(<ActiveQuarantinesPanel rows={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the count badge + each row with mode + slug + reason', () => {
    render(
      <ActiveQuarantinesPanel
        rows={[
          {
            id: 'cap-1',
            slug: 'stripe_charge',
            name: 'Stripe Charge',
            mode: 'quarantined-soft',
            reason: 'Vendor 5xx',
            expiresAt: null,
          },
          {
            id: 'cap-2',
            slug: 'send_sms',
            name: 'Send SMS',
            mode: 'quarantined-hard',
            reason: 'Suspended',
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
        ]}
      />
    );

    expect(screen.getByText('Active quarantines')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('Stripe Charge')).toBeInTheDocument();
    expect(screen.getByText('Send SMS')).toBeInTheDocument();
    expect(screen.getByText('Soft')).toBeInTheDocument();
    expect(screen.getByText('Hard')).toBeInTheDocument();
    expect(screen.getByText('Vendor 5xx')).toBeInTheDocument();
    // Auto-lift only rendered when present.
    expect(screen.getByText(/Auto-lift at/)).toBeInTheDocument();
  });

  it('links each row to the capability detail page', () => {
    render(
      <ActiveQuarantinesPanel
        rows={[
          {
            id: 'cap-1',
            slug: 'stripe_charge',
            name: 'Stripe Charge',
            mode: 'quarantined-soft',
            reason: null,
            expiresAt: null,
          },
        ]}
      />
    );

    const link = screen.getByRole('link', { name: 'Stripe Charge' });
    expect(link).toHaveAttribute('href', '/admin/orchestration/capabilities/cap-1');
  });
});
