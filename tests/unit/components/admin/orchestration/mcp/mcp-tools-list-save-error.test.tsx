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
import { render, screen, within } from '@testing-library/react';
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
    expect(alert).toHaveTextContent('Toggle refused');
    expect(alert.nextElementSibling).toContainElement(screen.getByRole('table'));
    expect(alert).toHaveFocus();
  });
});
