// @vitest-environment happy-dom

/**
 * InstructionsHistoryPanel — failed revert (§124)
 *
 * A refused revert keeps the confirm dialog open with the refusal above its
 * buttons. It used to close on click, so the error it set was never seen.
 *
 * @see components/admin/orchestration/instructions-history-panel.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { InstructionsHistoryPanel } from '@/components/admin/orchestration/instructions-history-panel';

// The real APIClientError, so the panel reads the failure as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const HISTORY = {
  agentId: 'agent-1',
  slug: 'test-agent',
  current: 'Current instructions text',
  history: [
    {
      instructions: 'Version 2',
      changedAt: '2025-03-01T10:00:00Z',
      changedBy: 'admin@example.com',
    },
    {
      instructions: 'Version 1',
      changedAt: '2025-01-01T10:00:00Z',
      changedBy: 'alice@example.com',
    },
  ],
};

describe('InstructionsHistoryPanel — failed revert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('keeps the revert dialog open with the refusal above its buttons', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(HISTORY);
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Version already current — no change needed', 'CONFLICT', 409)
    );
    const onReverted = vi.fn();
    const user = userEvent.setup();
    render(<InstructionsHistoryPanel agentId="agent-1" onReverted={onReverted} />);

    await user.click(screen.getByRole('button', { name: /version history/i }));
    const [revert] = await screen.findAllByRole('button', { name: /revert/i });
    await user.click(revert);
    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: /^revert$/i });
    await user.click(confirm);

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Version already current — no change needed');
    expect(alert.nextElementSibling).toContainElement(confirm);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(alert).toHaveFocus();
    expect(onReverted).not.toHaveBeenCalled();
  });
});
