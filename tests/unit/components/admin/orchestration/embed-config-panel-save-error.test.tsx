// @vitest-environment happy-dom

/**
 * EmbedConfigPanel tokens — failed saves (§124)
 *
 * A refused create shows directly above Create Token; a refused toggle or
 * delete shows above the token list. Both used to show at the top of the card.
 *
 * @see components/admin/orchestration/agents/embed-config-panel.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { EmbedConfigPanel } from '@/components/admin/orchestration/agents/embed-config-panel';

// The real APIClientError, so the panel reads the failure as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const TOKEN = {
  id: 'tok-1',
  token: 'secret-abc123',
  label: 'Marketing site',
  allowedOrigins: ['https://example.com'],
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  creator: { id: 'user-1', name: 'Admin' },
};

async function renderPanel(tokens: unknown[]) {
  const { apiClient } = await import('@/lib/api/client');
  vi.mocked(apiClient.get).mockImplementation((url: string) =>
    // The appearance section's load never settles: this suite is about tokens.
    url.includes('/widget-config') ? new Promise(() => {}) : Promise.resolve(tokens)
  );
  render(<EmbedConfigPanel agentId="agent-1" appUrl="https://app.example.com" />);
  await screen.findByText('Created tokens');
}

describe('EmbedConfigPanel tokens — failed saves', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows a refused create directly above Create Token and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Too many embed tokens for this agent', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    await renderPanel([]);

    const create = screen.getByRole('button', { name: /create token/i });
    await user.click(create);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Too many embed tokens for this agent');
    expect(alert.nextElementSibling).toBe(create);
    expect(alert).toHaveFocus();
  });

  it('shows a bad origin by Create Token too', async () => {
    const user = userEvent.setup();
    await renderPanel([]);

    await user.type(screen.getByPlaceholderText(/https:\/\/example.com, /), 'not a url');
    await user.click(screen.getByRole('button', { name: /create token/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid origin URL: "not a url"');
  });

  it('shows a refused toggle above the token list and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('Token is locked', 'FORBIDDEN', 403)
    );
    const user = userEvent.setup();
    await renderPanel([TOKEN]);

    await user.click(screen.getByRole('button', { name: 'Deactivate Marketing site' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Couldn\'t deactivate "Marketing site": Token is locked');
    expect(alert.nextElementSibling).toHaveTextContent('Marketing site');
    expect(alert).toHaveFocus();
  });

  it('names the token whose delete was refused, by its opening characters when unlabelled', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.delete).mockRejectedValue(
      new APIClientError('Token is in use', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    await renderPanel([{ ...TOKEN, label: null }]);

    await user.click(screen.getByRole('button', { name: 'Delete token' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn\'t delete "secret-a": Token is in use'
    );
  });
});
