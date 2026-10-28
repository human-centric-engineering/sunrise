// @vitest-environment happy-dom

/**
 * McpSettingsForm — failed save (§124)
 *
 * A refused save shows directly above Save Settings, and a field the server
 * named gets its message and the focus.
 *
 * @see components/admin/orchestration/mcp/mcp-settings-form.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { McpSettingsForm } from '@/components/admin/orchestration/mcp/mcp-settings-form';

// The real APIClientError, so the form reads `details` as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const SETTINGS = {
  isEnabled: true,
  serverName: 'Sunrise MCP Server',
  serverVersion: '1.0.0',
  globalRateLimit: 60,
  auditRetentionDays: 90,
};

/** Renders the form, edits a field so Save is enabled, and returns Save. */
async function renderDirty(user: ReturnType<typeof userEvent.setup>) {
  render(<McpSettingsForm initialSettings={SETTINGS} />);
  const name = document.querySelector<HTMLInputElement>('[name="serverName"]')!;
  await user.clear(name);
  await user.type(name, 'Renamed');
  return screen.getByRole('button', { name: /save settings/i });
}

describe('McpSettingsForm — failed save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows the failure beside Save Settings, and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('MCP settings are locked', 'FORBIDDEN', 403)
    );
    const user = userEvent.setup();
    const save = await renderDirty(user);

    await user.click(save);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('MCP settings are locked');
    expect(alert.parentElement).toContainElement(save);
    // Its container is Save's own, not the whole card.
    expect(alert.nextElementSibling).toContainElement(save);
    expect(alert).toHaveFocus();
  });

  it('puts a field the server rejected under that field and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('Invalid request body', 'VALIDATION_ERROR', 400, {
        errors: [{ path: 'globalRateLimit', message: 'Too big for this deployment' }],
      })
    );
    const user = userEvent.setup();
    const save = await renderDirty(user);

    await user.click(save);

    expect(await screen.findByText('Too big for this deployment')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('1 field needs fixing.');
    await waitFor(() => expect(document.querySelector('[name="globalRateLimit"]')).toHaveFocus());
  });

  it('clears the failure on the next press, even one client validation blocks', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('MCP settings are locked', 'FORBIDDEN', 403)
    );
    const user = userEvent.setup();
    const save = await renderDirty(user);
    await user.click(save);
    await screen.findByRole('alert');

    await user.clear(document.querySelector<HTMLInputElement>('[name="serverName"]')!);
    await user.click(save);

    expect(await screen.findByText('Required')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
