// @vitest-environment happy-dom

/**
 * WidgetAppearanceSection — failed save (§124)
 *
 * Save sits in the preview column, away from the top of the card, so a
 * refused save (or a check that blocks it) shows in that Save box. A load
 * failure is not a save failure and keeps its place at the top.
 *
 * @see components/admin/orchestration/agents/widget-appearance-section.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { WidgetAppearanceSection } from '@/components/admin/orchestration/agents/widget-appearance-section';
import { DEFAULT_WIDGET_CONFIG } from '@/lib/validations/orchestration';

// The real APIClientError, so the section reads `details` as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

async function renderLoaded() {
  const { apiClient } = await import('@/lib/api/client');
  vi.mocked(apiClient.get).mockResolvedValue({ config: DEFAULT_WIDGET_CONFIG });
  render(<WidgetAppearanceSection agentId="agent-1" />);
  return screen.findByRole('button', { name: /save appearance/i });
}

describe('WidgetAppearanceSection — failed save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows a refused save in the Save box beside the button, and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('Agent is archived', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    const save = await renderLoaded();

    await user.click(save);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Agent is archived');
    expect(alert.parentElement).toContainElement(save);
    // The Save box, not the whole card.
    expect(alert.parentElement).not.toContainElement(
      screen.getByRole('textbox', { name: /^Primary/ })
    );
    expect(alert).toHaveFocus();
  });

  it('shows a check that blocks the save beside Save too', async () => {
    const { apiClient } = await import('@/lib/api/client');
    const user = userEvent.setup();
    const save = await renderLoaded();
    await user.clear(screen.getByRole('textbox', { name: /^Primary/ }));

    await user.click(save);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Primary colour must be a 6-digit hex like #2563eb.');
    expect(alert.parentElement).toContainElement(save);
    expect(alert.parentElement).not.toContainElement(
      screen.getByRole('textbox', { name: /^Primary/ })
    );
    expect(alert).toHaveFocus();
    expect(apiClient.patch).not.toHaveBeenCalled();
  });

  it('puts a server field message in the summary, since no field shows one', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('Invalid request body', 'VALIDATION_ERROR', 400, {
        errors: [{ path: 'footerText', message: 'Footer text is too long' }],
      })
    );
    const user = userEvent.setup();
    const save = await renderLoaded();

    await user.click(save);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Footer text is too long');
    expect(alert).not.toHaveTextContent('field needs fixing');
  });

  it('keeps a load failure at the top of the card, away from Save', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockRejectedValue(
      new APIClientError('Boom from server', 'INTERNAL_ERROR', 500)
    );
    render(<WidgetAppearanceSection agentId="agent-1" />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Boom from server');
    const saveBox = screen.getByRole('button', { name: /save appearance/i }).parentElement;
    expect(saveBox).not.toContainElement(alert);
  });

  it('clears the last failure on the next press of Save', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch)
      .mockRejectedValueOnce(new APIClientError('Agent is archived', 'CONFLICT', 409))
      .mockImplementationOnce(() => new Promise(() => {}));
    const user = userEvent.setup();
    const save = await renderLoaded();
    await user.click(save);
    await screen.findByRole('alert');

    await user.click(save);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
