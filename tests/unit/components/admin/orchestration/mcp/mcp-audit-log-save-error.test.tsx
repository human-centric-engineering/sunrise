// @vitest-environment happy-dom

/**
 * McpAuditLog — failed purge (§124)
 *
 * A failed purge keeps the confirm dialog open with the server's message
 * inside it, directly above its buttons, and focused. It used to close the
 * dialog and leave a muted "Purge failed" beside the trigger.
 *
 * @see components/admin/orchestration/mcp/mcp-audit-log.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { McpAuditLog } from '@/components/admin/orchestration/mcp/mcp-audit-log';

vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.mock('@/components/ui/date-picker', () => ({
  DatePicker: () => <input aria-label="date" />,
}));

describe('McpAuditLog — failed purge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('keeps the dialog open with the failure above its buttons', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.delete).mockRejectedValue(
      new APIClientError('Retention is not configured', 'BAD_REQUEST', 400)
    );
    const user = userEvent.setup();
    render(<McpAuditLog initialEntries={[]} initialMeta={null} />);

    await user.click(screen.getByRole('button', { name: /purge old logs/i }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /^purge$/i }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Retention is not configured');
    expect(alert.nextElementSibling).toContainElement(
      within(dialog).getByRole('button', { name: /^purge$/i })
    );
    expect(alert).toHaveFocus();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('closes the dialog on success and clears a failure on reopening', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.delete)
      .mockRejectedValueOnce(new APIClientError('Busy', 'CONFLICT', 409))
      .mockResolvedValueOnce({ deleted: 2 });
    vi.mocked(apiClient.get).mockResolvedValue([]);
    const user = userEvent.setup();
    render(<McpAuditLog initialEntries={[]} initialMeta={null} />);

    await user.click(screen.getByRole('button', { name: /purge old logs/i }));
    let dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /^purge$/i }));
    await within(dialog).findByRole('alert');
    await user.click(within(dialog).getByRole('button', { name: /^cancel$/i }));

    await user.click(screen.getByRole('button', { name: /purge old logs/i }));
    dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /^purge$/i }));

    expect(await screen.findByText('Purged 2 log entries')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('commits the dialog to a purge in flight: both buttons disabled, a second click sends nothing', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue({
      data: [],
      meta: { page: 1, limit: 50, total: 0, totalPages: 0 },
    });
    let answer: () => void = () => {};
    vi.mocked(apiClient.delete).mockImplementation(
      () => new Promise((resolve) => (answer = () => resolve({ deleted: 0 })))
    );
    const user = userEvent.setup();
    render(<McpAuditLog initialEntries={[]} initialMeta={null} />);

    await user.click(screen.getByRole('button', { name: /purge old logs/i }));
    const dialog = await screen.findByRole('alertdialog');
    const purge = within(dialog).getByRole('button', { name: /^purge$/i });
    await user.click(purge);

    expect(purge).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: /^cancel$/i })).toBeDisabled();
    await user.click(purge);
    expect(apiClient.delete).toHaveBeenCalledTimes(1);

    answer();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(apiClient.delete).toHaveBeenCalledTimes(1);
  });

  it('ignores Escape while the purge runs, so a late failure lands in the open dialog', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    let fail: () => void = () => {};
    vi.mocked(apiClient.delete).mockImplementation(
      () => new Promise((_, reject) => (fail = () => reject(new APIClientError('Boom', 'X', 500))))
    );
    const user = userEvent.setup();
    render(<McpAuditLog initialEntries={[]} initialMeta={null} />);

    await user.click(screen.getByRole('button', { name: /purge old logs/i }));
    let dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /^purge$/i }));
    await user.keyboard('{Escape}');
    fail();

    dialog = screen.getByRole('alertdialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Boom');

    await user.click(within(dialog).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /purge old logs/i }));
    await screen.findByRole('alertdialog');
    expect(screen.queryByText(/Boom/)).not.toBeInTheDocument();
  });
});
