// @vitest-environment happy-dom

/**
 * QuarantinedCapabilitiesBanner — render tests (item #42)
 *
 * Pure render: renders one item per quarantined capability, or nothing
 * when the list is empty. No client state, no fetching.
 *
 * @see components/admin/orchestration/agents/quarantined-capabilities-banner.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { QuarantinedCapabilitiesBanner } from '@/components/admin/orchestration/agents/quarantined-capabilities-banner';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

describe('QuarantinedCapabilitiesBanner', () => {
  it('renders nothing when there are no quarantines', () => {
    const { container } = render(<QuarantinedCapabilitiesBanner items={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders one item with a soft badge and reason', () => {
    render(
      <QuarantinedCapabilitiesBanner
        items={[
          {
            capabilityId: 'cap-1',
            capabilitySlug: 'stripe_charge',
            capabilityName: 'Stripe Charge',
            mode: 'quarantined-soft',
            reason: 'Vendor 5xx since 14:32 UTC',
            expiresAt: null,
          },
        ]}
      />
    );

    expect(screen.getByText('Stripe Charge')).toBeInTheDocument();
    expect(screen.getByText('(stripe_charge)')).toBeInTheDocument();
    expect(screen.getByText('Soft')).toBeInTheDocument();
    expect(screen.getByText('Vendor 5xx since 14:32 UTC')).toBeInTheDocument();
    // Headline pluralises correctly for a single item.
    expect(screen.getByRole('alert')).toHaveTextContent('1 tool unavailable');
  });

  it('renders multiple items with mixed modes and pluralised headline', () => {
    render(
      <QuarantinedCapabilitiesBanner
        items={[
          {
            capabilityId: 'cap-1',
            capabilitySlug: 'stripe_charge',
            capabilityName: 'Stripe Charge',
            mode: 'quarantined-soft',
            reason: null,
            expiresAt: null,
          },
          {
            capabilityId: 'cap-2',
            capabilitySlug: 'send_sms',
            capabilityName: 'Send SMS',
            mode: 'quarantined-hard',
            reason: 'Twilio account suspended',
            expiresAt: null,
          },
        ]}
      />
    );

    expect(screen.getByText('Stripe Charge')).toBeInTheDocument();
    expect(screen.getByText('Send SMS')).toBeInTheDocument();
    expect(screen.getByText('Soft')).toBeInTheDocument();
    expect(screen.getByText('Hard')).toBeInTheDocument();
    expect(screen.getByText('Twilio account suspended')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('2 tools unavailable');
  });

  it('links each item to the capability detail page', () => {
    render(
      <QuarantinedCapabilitiesBanner
        items={[
          {
            capabilityId: 'cap-1',
            capabilitySlug: 'stripe_charge',
            capabilityName: 'Stripe Charge',
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
