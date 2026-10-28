// @vitest-environment happy-dom

/**
 * BudgetAlertsList — failed pause (§124)
 *
 * A refused pause reverts the row and shows the reason in the one box above
 * the list, taking focus; it used to draw its own box inside the row.
 *
 * @see components/admin/orchestration/costs/budget-alerts-list.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { BudgetAlertsList } from '@/components/admin/orchestration/costs/budget-alerts-list';

// The real APIClientError, so the failure is read as it would be in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const ALERT = {
  agentId: 'agent-1',
  name: 'Support Bot',
  slug: 'support-bot',
  monthlyBudgetUsd: 100,
  spent: 95,
  utilisation: 0.95,
  severity: 'critical' as const,
};

describe('BudgetAlertsList — failed pause', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows the refusal above the list, focuses it, and reverts the row', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('System agents cannot be paused', 'FORBIDDEN', 403)
    );
    const user = userEvent.setup();
    render(<BudgetAlertsList alerts={[ALERT]} />);

    await user.click(screen.getByRole('button', { name: /pause agent/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('System agents cannot be paused');
    expect(alert.nextElementSibling?.tagName).toBe('UL');
    expect(alert).toHaveFocus();
    expect(screen.getByRole('button', { name: /pause agent/i })).toBeEnabled();
  });
});
