// @vitest-environment happy-dom

/**
 * McpToolsList — failed saves (§124)
 *
 * - Edit: the failure shows inside the edit dialog, above its footer. It used
 *   to be drawn at the top of the page, behind the dialog's overlay.
 * - Remove: the confirm dialog stays open with the failure inside it. It used
 *   to close and draw the error at the top of the page.
 * - Toggle: a row action; its failure shows above the table and takes focus.
 *
 * @see components/admin/orchestration/mcp/mcp-tools-list.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { McpToolsList } from '@/components/admin/orchestration/mcp/mcp-tools-list';

vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const CAPABILITY = {
  id: 'cap-1',
  name: 'Send Email',
  slug: 'send_email',
  description: 'Sends an email',
  category: 'communication',
};

const TOOL = {
  id: 'tool-1',
  capabilityId: 'cap-1',
  isEnabled: true,
  customName: null,
  customDescription: null,
  rateLimitPerKey: null,
  requiresScope: null,
  customTitle: null,
  readOnlyHint: null,
  destructiveHint: null,
  idempotentHint: null,
  openWorldHint: null,
  capability: CAPABILITY,
};

describe('McpToolsList — failed saves', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows a failed edit inside the dialog, above its footer', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('That custom name is taken', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    render(<McpToolsList initialTools={[TOOL]} capabilities={[CAPABILITY]} />);

    await user.click(screen.getByRole('button', { name: /edit send email/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /save changes/i }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('That custom name is taken');
    expect(alert.nextElementSibling).toContainElement(
      within(dialog).getByRole('button', { name: /save changes/i })
    );
    expect(alert).toHaveFocus();
  });

  it('keeps the remove dialog open with the failure inside it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.delete).mockRejectedValue(
      new APIClientError('Tool is in use', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    render(<McpToolsList initialTools={[TOOL]} capabilities={[CAPABILITY]} />);

    await user.click(screen.getByRole('button', { name: /^Remove$/i }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /^Remove$/i }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Tool is in use');
    expect(alert.nextElementSibling).toContainElement(
      within(dialog).getByRole('button', { name: /^Remove$/i })
    );
    expect(alert).toHaveFocus();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('shows a failed toggle directly above the table and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('Toggle refused', 'INTERNAL_ERROR', 500)
    );
    const user = userEvent.setup();
    render(<McpToolsList initialTools={[TOOL]} capabilities={[CAPABILITY]} />);

    await user.click(screen.getByRole('switch', { name: /enable send email/i }));

    const alert = await screen.findByRole('alert');
    // The box sits away from the row, so it names the row.
    expect(alert).toHaveTextContent('Couldn\'t disable "Send Email": Toggle refused');
    expect(alert.nextElementSibling).toContainElement(screen.getByRole('table'));
    expect(alert).toHaveFocus();
  });

  it('commits the remove dialog while it runs: both buttons disabled, a second click sends nothing', async () => {
    const { apiClient } = await import('@/lib/api/client');
    let answer: () => void = () => {};
    vi.mocked(apiClient.delete).mockImplementation(
      () => new Promise((resolve) => (answer = () => resolve(undefined)))
    );
    const user = userEvent.setup();
    render(<McpToolsList initialTools={[TOOL]} capabilities={[CAPABILITY]} />);

    await user.click(screen.getByRole('button', { name: /^Remove$/i }));
    const dialog = await screen.findByRole('alertdialog');
    const remove = within(dialog).getByRole('button', { name: /^Remove$/i });
    await user.click(remove);

    expect(remove).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: /^Cancel$/i })).toBeDisabled();
    await user.click(remove);
    expect(apiClient.delete).toHaveBeenCalledTimes(1);

    answer();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(apiClient.delete).toHaveBeenCalledTimes(1);
  });

  it("keeps row A's late remove failure in row A's dialog, never in row B's", async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    let fail: () => void = () => {};
    vi.mocked(apiClient.delete).mockImplementation(
      () =>
        new Promise((_, reject) => (fail = () => reject(new APIClientError('Boom A', 'X', 500))))
    );
    const other = {
      ...TOOL,
      id: 'tool-2',
      capabilityId: 'cap-2',
      capability: { ...CAPABILITY, id: 'cap-2', name: 'Look Up Order', slug: 'look_up' },
    };
    const user = userEvent.setup();
    render(<McpToolsList initialTools={[TOOL, other]} capabilities={[CAPABILITY]} />);

    await user.click(screen.getAllByRole('button', { name: /^Remove$/i })[0]);
    let dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /^Remove$/i }));
    // Escape while the remove runs is ignored: the dialog waits for the answer.
    await user.keyboard('{Escape}');
    fail();

    dialog = screen.getByRole('alertdialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Boom A');

    await user.click(within(dialog).getByRole('button', { name: /^Cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await user.click(screen.getAllByRole('button', { name: /^Remove$/i })[1]);
    dialog = await screen.findByRole('alertdialog');
    expect(screen.queryByText(/Boom A/)).not.toBeInTheDocument();
  });
});
