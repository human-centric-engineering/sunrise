// @vitest-environment happy-dom

/**
 * McpKeysList — failed saves (§124)
 *
 * - Create: the failure shows inside the create dialog, above its footer. It
 *   used to be drawn at the top of the page, behind the dialog's overlay.
 * - Revoke: the confirm dialog stays open with the failure inside it. It used
 *   to close and draw the error at the top of the page.
 * - Rotate: a row action; its failure shows above the table and takes focus.
 *
 * @see components/admin/orchestration/mcp/mcp-keys-list.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { McpKeysList } from '@/components/admin/orchestration/mcp/mcp-keys-list';

vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const KEY = {
  id: 'key-1',
  name: 'Claude Desktop',
  keyPrefix: 'smcp_abc',
  scopes: ['tools:list', 'tools:execute'],
  isActive: true,
  expiresAt: null,
  lastUsedAt: null,
  rateLimitOverride: null,
  createdAt: '2026-04-01T00:00:00.000Z',
  creator: { name: 'Admin', email: 'admin@test.com' },
};

describe('McpKeysList — failed saves', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows a failed create inside the dialog, above its footer', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('A key with that name exists', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    render(<McpKeysList initialKeys={[]} />);

    await user.click(screen.getByRole('button', { name: /create api key/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: /name/i }), 'Cursor');
    await user.click(within(dialog).getByRole('button', { name: /create key/i }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('A key with that name exists');
    expect(alert.nextElementSibling).toContainElement(
      within(dialog).getByRole('button', { name: /create key/i })
    );
    expect(alert).toHaveFocus();
  });

  it('does not call a create failed when only the list refresh after it failed', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockResolvedValue({ plaintext: 'smcp_secret_once' });
    vi.mocked(apiClient.get).mockRejectedValue(
      new APIClientError('Service unavailable', 'INTERNAL_ERROR', 503)
    );
    const user = userEvent.setup();
    render(<McpKeysList initialKeys={[]} />);

    await user.click(screen.getByRole('button', { name: /create api key/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: /name/i }), 'Cursor');
    await user.click(within(dialog).getByRole('button', { name: /create key/i }));

    // The key exists and its only copy is on screen: no failure over it.
    expect(await within(dialog).findByText('smcp_secret_once')).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the revoke dialog open with the failure inside it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('Key is in use by a running job', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    render(<McpKeysList initialKeys={[KEY]} />);

    await user.click(screen.getByRole('button', { name: /^revoke$/i }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /^revoke$/i }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Key is in use by a running job');
    expect(alert.nextElementSibling).toContainElement(
      within(dialog).getByRole('button', { name: /^revoke$/i })
    );
    expect(alert).toHaveFocus();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('shows a failed Rotate directly above the table and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Rotation is rate limited', 'RATE_LIMITED', 429)
    );
    const user = userEvent.setup();
    render(<McpKeysList initialKeys={[KEY]} />);

    await user.click(screen.getByRole('button', { name: /^rotate$/i }));

    const alert = await screen.findByRole('alert');
    // The box sits away from the row, so it names the row.
    expect(alert).toHaveTextContent('Couldn\'t rotate "Claude Desktop": Rotation is rate limited');
    expect(alert.nextElementSibling).toContainElement(screen.getByRole('table'));
    expect(alert).toHaveFocus();
  });

  it('commits the revoke dialog while it runs: both buttons disabled, a second click sends nothing', async () => {
    const { apiClient } = await import('@/lib/api/client');
    let answer: () => void = () => {};
    vi.mocked(apiClient.patch).mockImplementation(
      () => new Promise((resolve) => (answer = () => resolve(undefined)))
    );
    const user = userEvent.setup();
    render(<McpKeysList initialKeys={[KEY]} />);

    await user.click(screen.getByRole('button', { name: /^Revoke$/i }));
    const dialog = await screen.findByRole('alertdialog');
    const revoke = within(dialog).getByRole('button', { name: /^Revoke$/i });
    await user.click(revoke);

    expect(revoke).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: /^Cancel$/i })).toBeDisabled();
    await user.click(revoke);
    expect(apiClient.patch).toHaveBeenCalledTimes(1);

    answer();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(apiClient.patch).toHaveBeenCalledTimes(1);
  });

  it("keeps row A's late revoke failure in row A's dialog, never in row B's", async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    let fail: () => void = () => {};
    vi.mocked(apiClient.patch).mockImplementation(
      () =>
        new Promise((_, reject) => (fail = () => reject(new APIClientError('Boom A', 'X', 500))))
    );
    const user = userEvent.setup();
    render(<McpKeysList initialKeys={[KEY, { ...KEY, id: 'key-2', name: 'Cursor' }]} />);

    await user.click(screen.getAllByRole('button', { name: /^Revoke$/i })[0]);
    let dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /^Revoke$/i }));
    // Escape while the revoke runs is ignored: the dialog waits for the answer.
    await user.keyboard('{Escape}');
    fail();

    dialog = screen.getByRole('alertdialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Boom A');

    await user.click(within(dialog).getByRole('button', { name: /^Cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await user.click(screen.getAllByRole('button', { name: /^Revoke$/i })[1]);
    await screen.findByRole('alertdialog');
    expect(screen.queryByText(/Boom A/)).not.toBeInTheDocument();
  });
});
