// @vitest-environment happy-dom

/**
 * CapabilityQuarantineCard — failed saves (§124)
 *
 * A refused quarantine keeps the confirm dialog open with the refusal inside
 * it (it used to close, leaving the error in the card behind); a refused lift
 * shows directly above Lift quarantine.
 *
 * @see components/admin/orchestration/capability-quarantine-card.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CapabilityQuarantineCard } from '@/components/admin/orchestration/capability-quarantine-card';

// The real APIClientError, so the card reads the failure as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const AFFECTED = [{ id: 'agent-1', name: 'Support Bot', slug: 'support-bot' }];

describe('CapabilityQuarantineCard — failed saves', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('keeps the confirm dialog open with the refusal above its buttons', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Capability is already quarantined', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    render(
      <CapabilityQuarantineCard
        capabilityId="cap-1"
        capabilityName="Stripe Charge"
        state={{ quarantineState: 'active', quarantineReason: null, quarantineUntil: null }}
        affectedAgents={AFFECTED}
      />
    );

    await user.click(screen.getByRole('button', { name: /Emergency disable/i }));
    await user.type(screen.getByPlaceholderText(/Stripe charges/i), 'vendor outage');
    await user.click(screen.getByRole('button', { name: /^Quarantine$/i }));
    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: /Confirm quarantine/i });
    await user.click(confirm);

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Capability is already quarantined');
    expect(alert.nextElementSibling).toContainElement(confirm);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(alert).toHaveFocus();
  });

  it('shows a refused lift directly above Lift quarantine and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Not allowed to lift', 'FORBIDDEN', 403)
    );
    const user = userEvent.setup();
    render(
      <CapabilityQuarantineCard
        capabilityId="cap-1"
        capabilityName="Stripe Charge"
        state={{
          quarantineState: 'quarantined-soft',
          quarantineReason: 'Vendor down',
          quarantineUntil: null,
        }}
        affectedAgents={AFFECTED}
      />
    );

    const lift = screen.getByRole('button', { name: /Lift quarantine/i });
    await user.click(lift);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Not allowed to lift');
    expect(alert.nextElementSibling).toBe(lift);
    expect(alert).toHaveFocus();
  });
});
