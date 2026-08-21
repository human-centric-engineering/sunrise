// @vitest-environment happy-dom

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

// Module-level alias for the mocked APIClientError so tests can
// construct an instance that satisfies `instanceof APIClientError`
// inside the component (which imports the same mocked module).
async function getMockedAPIClientError(): Promise<new (msg: string) => Error> {
  const mod = (await import('@/lib/api/client')) as { APIClientError: new (msg: string) => Error };
  return mod.APIClientError;
}

// The ActiveView ships collapsed by default (the "Emergency disable" card
// shouldn't dominate the page when nothing is wrong). Tests that interact
// with the form must expand it first.
async function expandActiveCard(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: /Emergency disable/i }));
}

describe('CapabilityQuarantineCard — ActiveView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiPost.mockResolvedValue({});
  });

  it('renders the quarantine form with mode + reason + auto-lift', async () => {
    const user = userEvent.setup();
    render(
      <CapabilityQuarantineCard
        capabilityId="cap-1"
        capabilityName="Stripe Charge"
        state={{ quarantineState: 'active', quarantineReason: null, quarantineUntil: null }}
        affectedAgents={AFFECTED}
      />
    );

    // Header is visible before expansion.
    expect(screen.getByText(/Emergency disable/i)).toBeInTheDocument();
    await expandActiveCard(user);

    // The "2 agents" count is in a <strong> so the surrounding text is
    // split — match the unique suffix instead.
    expect(screen.getByText(/currently using this capability/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Quarantine$/i })).toBeDisabled();
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

    await expandActiveCard(user);
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

  it('rejects a reason that exceeds the length cap', async () => {
    const user = userEvent.setup();
    render(
      <CapabilityQuarantineCard
        capabilityId="cap-1"
        capabilityName="Stripe Charge"
        state={{ quarantineState: 'active', quarantineReason: null, quarantineUntil: null }}
        affectedAgents={AFFECTED}
      />
    );

    await expandActiveCard(user);
    const reason = screen.getByPlaceholderText(/Stripe charges/i);
    // maxLength=500 on the textarea blocks user.type past 500 chars, so
    // simulate paste by setting the value via fireEvent — exercises the
    // length-cap branch in validate() directly.
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(reason, { target: { value: 'x'.repeat(501) } });
    await user.click(screen.getByRole('button', { name: /^Quarantine$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/too long/i);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('rejects a past auto-lift timestamp before opening the dialog', async () => {
    const user = userEvent.setup();
    render(
      <CapabilityQuarantineCard
        capabilityId="cap-1"
        capabilityName="Stripe Charge"
        state={{ quarantineState: 'active', quarantineReason: null, quarantineUntil: null }}
        affectedAgents={AFFECTED}
      />
    );

    await expandActiveCard(user);
    await user.type(screen.getByPlaceholderText(/Stripe charges/i), 'reason');
    // Set auto-lift to 1970 — definitely in the past. The Label wraps a
    // FieldHelp <button>, so getByLabelText would be ambiguous — query
    // the input by its id (`quarantine-expires`) via the rendered DOM.
    const expiry = document.getElementById('quarantine-expires') as HTMLInputElement;
    await user.type(expiry, '1970-01-01T00:00');
    await user.click(screen.getByRole('button', { name: /^Quarantine$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/must be in the future/i);
    // Dialog never opens, no API call.
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('surfaces the server error message when quarantine POST fails', async () => {
    const user = userEvent.setup();
    const APIClientError = await getMockedAPIClientError();
    apiPost.mockRejectedValueOnce(new APIClientError('Vendor is down'));

    render(
      <CapabilityQuarantineCard
        capabilityId="cap-1"
        capabilityName="Stripe Charge"
        state={{ quarantineState: 'active', quarantineReason: null, quarantineUntil: null }}
        affectedAgents={AFFECTED}
      />
    );

    await expandActiveCard(user);
    await user.type(screen.getByPlaceholderText(/Stripe charges/i), 'reason');
    await user.click(screen.getByRole('button', { name: /^Quarantine$/i }));
    await user.click(await screen.findByRole('button', { name: /Confirm quarantine/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Vendor is down/);
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

  it('renders audit attribution when supplied', () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    render(
      <CapabilityQuarantineCard
        capabilityId="cap-1"
        capabilityName="Stripe Charge"
        state={{
          quarantineState: 'quarantined-soft',
          quarantineReason: 'vendor outage',
          quarantineUntil: null,
        }}
        attribution={{ at: tenMinutesAgo, actorName: 'Jane Doe' }}
        affectedAgents={AFFECTED}
      />
    );

    expect(screen.getByLabelText('Audit attribution')).toHaveTextContent(
      /Quarantined 10 min ago by Jane Doe\./i
    );
  });

  it.each([
    [10 * 1000, /just now/i, '10 seconds ago'],
    [4 * 60 * 60_000, /4 hours ago/i, '4 hours ago'],
    [1 * 60 * 60_000, /1 hour ago/i, 'singular hour'],
    [3 * 24 * 60 * 60_000, /3 days ago/i, '3 days ago'],
    [1 * 24 * 60 * 60_000, /1 day ago/i, 'singular day'],
  ])('humanises attribution timestamps — %s', (deltaMs, expected, _label) => {
    render(
      <CapabilityQuarantineCard
        capabilityId="cap-1"
        capabilityName="Stripe Charge"
        state={{
          quarantineState: 'quarantined-soft',
          quarantineReason: 'r',
          quarantineUntil: null,
        }}
        attribution={{
          at: new Date(Date.now() - deltaMs).toISOString(),
          actorName: 'Jane',
        }}
        affectedAgents={AFFECTED}
      />
    );
    expect(screen.getByLabelText('Audit attribution')).toHaveTextContent(expected);
  });

  it('falls back to "recently" when attribution timestamp is unparseable', () => {
    render(
      <CapabilityQuarantineCard
        capabilityId="cap-1"
        capabilityName="Stripe Charge"
        state={{
          quarantineState: 'quarantined-soft',
          quarantineReason: 'r',
          quarantineUntil: null,
        }}
        attribution={{ at: 'not-a-date', actorName: 'Jane' }}
        affectedAgents={AFFECTED}
      />
    );
    expect(screen.getByLabelText('Audit attribution')).toHaveTextContent(/Quarantined recently/i);
  });

  it('omits the actor name when attribution actor is missing', () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    render(
      <CapabilityQuarantineCard
        capabilityId="cap-1"
        capabilityName="Stripe Charge"
        state={{
          quarantineState: 'quarantined-soft',
          quarantineReason: null,
          quarantineUntil: null,
        }}
        attribution={{ at: tenMinutesAgo, actorName: null }}
        affectedAgents={AFFECTED}
      />
    );

    const line = screen.getByLabelText('Audit attribution');
    expect(line).toHaveTextContent(/Quarantined 10 min ago\./i);
    expect(line).not.toHaveTextContent(/by/);
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

  it('surfaces the server error message when Lift fails', async () => {
    const user = userEvent.setup();
    const APIClientError = await getMockedAPIClientError();
    apiPost.mockRejectedValueOnce(new APIClientError('Insufficient permissions'));

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

    await user.click(screen.getByRole('button', { name: /Lift quarantine/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Insufficient permissions/);
  });

  it('renders the auto-lift footer when expiry is set and in the future', () => {
    const future = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    render(
      <CapabilityQuarantineCard
        capabilityId="cap-1"
        capabilityName="Stripe Charge"
        state={{
          quarantineState: 'quarantined-soft',
          quarantineReason: 'window',
          quarantineUntil: future,
        }}
        affectedAgents={AFFECTED}
      />
    );

    expect(screen.getByText(/Auto-lift/i)).toBeInTheDocument();
    // The "already in the past" note should NOT appear for a future timestamp.
    expect(screen.queryByText(/Already in the past/i)).not.toBeInTheDocument();
  });

  it('surfaces the "already in the past" footer when auto-lift has elapsed', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    render(
      <CapabilityQuarantineCard
        capabilityId="cap-1"
        capabilityName="Stripe Charge"
        state={{
          quarantineState: 'quarantined-soft',
          quarantineReason: 'window',
          quarantineUntil: past,
        }}
        affectedAgents={AFFECTED}
      />
    );

    expect(screen.getByText(/Already in the past/i)).toBeInTheDocument();
  });

  it('renders the empty-state message when no agents bind the capability', () => {
    render(
      <CapabilityQuarantineCard
        capabilityId="cap-1"
        capabilityName="Stripe Charge"
        state={{
          quarantineState: 'quarantined-soft',
          quarantineReason: 'vendor outage',
          quarantineUntil: null,
        }}
        affectedAgents={[]}
      />
    );

    expect(screen.getByText(/No agents currently use this capability/i)).toBeInTheDocument();
    // No popover trigger when there are no agents to list.
    expect(screen.queryByRole('button', { name: /agents affected/i })).not.toBeInTheDocument();
  });
});
