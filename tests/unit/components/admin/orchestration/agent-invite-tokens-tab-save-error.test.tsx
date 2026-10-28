// @vitest-environment happy-dom

/**
 * AgentInviteTokensTab — failed saves (§124)
 *
 * A refused create shows inside its dialog, above the buttons (it used to be
 * drawn behind the dialog's overlay); a refused revoke shows in the box above
 * the table and takes focus.
 *
 * @see components/admin/orchestration/agent-invite-tokens-tab.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AgentInviteTokensTab } from '@/components/admin/orchestration/agent-invite-tokens-tab';

// The real APIClientError, so the tab reads the failure as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const TOKEN = {
  id: 'tok-active',
  token: 'abcdefgh12345678',
  label: 'Acme Corp',
  maxUses: null,
  useCount: 0,
  expiresAt: null,
  revokedAt: null,
  createdBy: 'user-1',
  createdAt: '2026-01-01T00:00:00Z',
};

describe('AgentInviteTokensTab — failed saves', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('keeps the create dialog open with the failure above its buttons', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue({ tokens: [] });
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Agent is not invite-only', 'VALIDATION_ERROR', 400)
    );
    const user = userEvent.setup();
    render(<AgentInviteTokensTab agentId="agent-1" />);

    await user.click(await screen.findByRole('button', { name: /create token/i }));
    const dialog = await screen.findByRole('dialog');
    const create = within(dialog).getByRole('button', { name: /^create token$/i });
    await user.click(create);

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Agent is not invite-only');
    expect(alert.nextElementSibling).toContainElement(create);
    expect(alert).toHaveFocus();
  });

  it('shows a refused revoke above the table and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue({ tokens: [TOKEN] });
    vi.mocked(apiClient.delete).mockRejectedValue(
      new APIClientError('Token already revoked', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    render(<AgentInviteTokensTab agentId="agent-1" />);

    await user.click(await screen.findByRole('button', { name: 'Revoke token Acme Corp' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Couldn\'t revoke "Acme Corp": Token already revoked');
    expect(alert.nextElementSibling).toContainElement(screen.getByRole('table'));
    expect(alert).toHaveFocus();
  });

  it('is committed to a create in flight: no second request, no Cancel, no Escape', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue({ tokens: [] });
    vi.mocked(apiClient.post).mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    render(<AgentInviteTokensTab agentId="agent-1" />);

    await user.click(await screen.findByRole('button', { name: /create token/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^create token$/i }));

    const pending = within(dialog).getByRole('button', { name: /creating/i });
    expect(pending).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await user.click(pending);
    await user.keyboard('{Escape}');

    expect(apiClient.post).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('never shows an earlier failed create when the dialog opens again', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue({ tokens: [] });
    let reject: (err: unknown) => void = () => {};
    vi.mocked(apiClient.post).mockReturnValue(
      new Promise((_, rej) => {
        reject = rej;
      })
    );
    const user = userEvent.setup();
    render(<AgentInviteTokensTab agentId="agent-1" />);

    await user.click(await screen.findByRole('button', { name: /create token/i }));
    const first = await screen.findByRole('dialog');
    await user.click(within(first).getByRole('button', { name: /^create token$/i }));
    // An attempt to leave while the request is in flight, then it fails.
    await user.keyboard('{Escape}');
    await act(async () =>
      reject(new APIClientError('Agent is not invite-only', 'VALIDATION_ERROR', 400))
    );
    // Leave the dialog if it is still open (it should be: it ignored the Escape).
    const open = screen.queryByRole('dialog');
    if (open) await user.click(within(open).getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: /create token/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });
});
