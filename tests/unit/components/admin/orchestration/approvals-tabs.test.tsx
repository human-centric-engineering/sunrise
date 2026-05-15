/**
 * ApprovalsTabs — switches between the live pending queue and the
 * historical decision log. Verifies the default tab, the conditional
 * total badge, and that switching tabs renders the matching child.
 *
 * @see components/admin/orchestration/approvals-tabs.tsx
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Stub the heavy children: their real implementations make network calls
// and pull in many sibling components. This test only cares that the
// right child renders for the active tab.
vi.mock('@/components/admin/orchestration/approvals-table', () => ({
  ApprovalsTable: () => <div data-testid="approvals-table-stub" />,
}));
vi.mock('@/components/admin/orchestration/approvals-history-table', () => ({
  ApprovalsHistoryTable: () => <div data-testid="approvals-history-table-stub" />,
}));

import { ApprovalsTabs } from '@/components/admin/orchestration/approvals-tabs';
import type { PaginationMeta } from '@/types/api';

function makeMeta(overrides: Partial<PaginationMeta> = {}): PaginationMeta {
  return { page: 1, limit: 25, total: 0, totalPages: 1, ...overrides };
}

describe('ApprovalsTabs', () => {
  it('defaults to the Pending tab and renders ApprovalsTable', () => {
    render(<ApprovalsTabs initialApprovals={[]} initialMeta={makeMeta()} />);

    const pendingTab = screen.getByRole('tab', { name: /pending/i });
    expect(pendingTab).toHaveAttribute('data-state', 'active');
    expect(screen.getByTestId('approvals-table-stub')).toBeInTheDocument();
    // History table is mounted but not visible (or not yet mounted depending on Radix internals).
    expect(screen.queryByTestId('approvals-history-table-stub')).not.toBeInTheDocument();
  });

  it('shows the pending count badge when total > 0', () => {
    render(<ApprovalsTabs initialApprovals={[]} initialMeta={makeMeta({ total: 7 })} />);
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('hides the badge when total is 0', () => {
    render(<ApprovalsTabs initialApprovals={[]} initialMeta={makeMeta({ total: 0 })} />);
    // The Pending tab is visible, but no numeric badge accompanies it.
    expect(screen.queryByText(/^\d+$/)).not.toBeInTheDocument();
  });

  it('switches to the History tab on click', async () => {
    const user = userEvent.setup();
    render(<ApprovalsTabs initialApprovals={[]} initialMeta={makeMeta()} />);

    await user.click(screen.getByRole('tab', { name: /history/i }));

    expect(screen.getByRole('tab', { name: /history/i })).toHaveAttribute('data-state', 'active');
    expect(screen.getByTestId('approvals-history-table-stub')).toBeInTheDocument();
  });
});
