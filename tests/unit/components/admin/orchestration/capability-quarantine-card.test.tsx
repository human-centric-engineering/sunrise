/**
 * CapabilityQuarantineCard component tests (item #42)
 *
 * Covers both views:
 * - ActiveView: renders the form, blocks Quarantine until a reason is
 *   typed, opens the confirmation dialog naming affected agents, and
 *   POSTs to the quarantine endpoint with the expected body shape.
 * - QuarantinedView: renders the current mode, reason, lift button;
 *   POSTs unquarantine on click.
 *
 * @see components/admin/orchestration/capability-quarantine-card.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CapabilityQuarantineCard } from '@/components/admin/orchestration/capability-quarantine-card';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

const apiPost = vi.fn();
vi.mock('@/lib/api/client', () => ({
  apiClient: { post: (...args: unknown[]) => apiPost(...args) },
  APIClientError: class APIClientError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

// Spy on window.location.reload — the card calls it after a successful
// POST so the parent server component re-fetches the row. Stub the
// whole location object so the spy can be installed cleanly under JSDOM.
const reload = vi.fn();
Object.defineProperty(window, 'location', {
  configurable: true,
  value: { ...window.location, reload },
});

const AFFECTED = [
  { id: 'agent-1', name: 'Support Bot', slug: 'support-bot' },
  { id: 'agent-2', name: 'Sales Bot', slug: 'sales-bot' },
];

describe('CapabilityQuarantineCard — ActiveView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiPost.mockResolvedValue({});
  });

  it('renders the quarantine form with mode + reason + auto-lift', () => {
    render(
      <CapabilityQuarantineCard
        capabilityId="cap-1"
        capabilityName="Stripe Charge"
        state={{ quarantineState: 'active', quarantineReason: null, quarantineUntil: null }}
        affectedAgents={AFFECTED}
      />
    );

    expect(screen.getByText(/Emergency disable/i)).toBeInTheDocument();
    // The "2 agents" count is in a <strong> so the surrounding text is
    // split — match the unique suffix instead.
    expect(screen.getByText(/currently using this capability/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Quarantine/i })).toBeDisabled();
  });

  it('blocks Quarantine until a reason is typed, then opens confirmation + POSTs', async () => {
    const user = userEvent.setup();

    render(
      <CapabilityQuarantineCard
        capabilityId="cap-1"
        capabilityName="Stripe Charge"
        state={{ quarantineState: 'active', quarantineReason: null, quarantineUntil: null }}
        affectedAgents={AFFECTED}
      />
    );

    const reasonInput = screen.getByPlaceholderText(/Stripe charges returning 500s/i);
    await user.type(reasonInput, 'Vendor 5xx since 14:32 UTC');

    const quarantineButton = screen.getByRole('button', { name: /^Quarantine$/i });
    expect(quarantineButton).toBeEnabled();

    await user.click(quarantineButton);

    // Confirmation dialog opens and names the affected agents.
    // Title uses curly quotes (&ldquo;/&rdquo;); match the chunk that doesn't include them.
    expect(await screen.findByText(/Quarantine.*Stripe Charge/i)).toBeInTheDocument();
    expect(screen.getByText(/2 agents affected:/i)).toBeInTheDocument();
    expect(screen.getByText('Support Bot')).toBeInTheDocument();
    expect(screen.getByText('Sales Bot')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Confirm quarantine/i }));

    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiPost).toHaveBeenCalledWith(
      '/api/v1/admin/orchestration/capabilities/cap-1/quarantine',
      {
        body: {
          mode: 'quarantined-soft',
          reason: 'Vendor 5xx since 14:32 UTC',
          expiresAt: null,
        },
      }
    );
  });
});

describe('CapabilityQuarantineCard — QuarantinedView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiPost.mockResolvedValue({});
  });

  it('renders the current mode badge + reason + Lift button', () => {
    render(
      <CapabilityQuarantineCard
        capabilityId="cap-1"
        capabilityName="Stripe Charge"
        state={{
          quarantineState: 'quarantined-soft',
          quarantineReason: 'Vendor 5xx',
          quarantineUntil: null,
        }}
        affectedAgents={AFFECTED}
      />
    );

    expect(screen.getByText('Quarantined')).toBeInTheDocument();
    expect(screen.getByText('Soft')).toBeInTheDocument();
    expect(screen.getByText('Vendor 5xx')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Lift quarantine/i })).toBeEnabled();
  });

  it('opens a popover listing the affected agents when the count is clicked', async () => {
    const user = userEvent.setup();

    render(
      <CapabilityQuarantineCard
        capabilityId="cap-1"
        capabilityName="Stripe Charge"
        state={{
          quarantineState: 'quarantined-soft',
          quarantineReason: 'vendor outage',
          quarantineUntil: null,
        }}
        affectedAgents={AFFECTED}
      />
    );

    // Count is rendered as a clickable button, not a flat text line.
    const trigger = screen.getByRole('button', { name: /2 agents affected/i });
    await user.click(trigger);

    // Popover lists each affected agent linked to its detail page.
    const supportLink = await screen.findByRole('link', { name: /Support Bot/i });
    expect(supportLink).toHaveAttribute('href', '/admin/orchestration/agents/agent-1');
    const salesLink = screen.getByRole('link', { name: /Sales Bot/i });
    expect(salesLink).toHaveAttribute('href', '/admin/orchestration/agents/agent-2');
  });

  it('POSTs to /unquarantine when Lift is clicked', async () => {
    const user = userEvent.setup();

    render(
      <CapabilityQuarantineCard
        capabilityId="cap-1"
        capabilityName="Stripe Charge"
        state={{
          quarantineState: 'quarantined-hard',
          quarantineReason: 'wrong data',
          quarantineUntil: null,
        }}
        affectedAgents={AFFECTED}
      />
    );

    await user.click(screen.getByRole('button', { name: /Lift quarantine/i }));

    expect(apiPost).toHaveBeenCalledWith(
      '/api/v1/admin/orchestration/capabilities/cap-1/unquarantine',
      {}
    );
  });
});
