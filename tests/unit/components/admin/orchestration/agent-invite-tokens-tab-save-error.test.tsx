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
import { render, screen, within } from '@testing-library/react';
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
    expect(alert).toHaveTextContent('Token already revoked');
    expect(alert.nextElementSibling).toContainElement(screen.getByRole('table'));
    expect(alert).toHaveFocus();
  });
});
