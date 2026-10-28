// @vitest-environment happy-dom

/**
 * AgentCapabilitiesTab — failed saves (§124)
 *
 * A refused attach / detach / switch shows in one box above the lists and
 * takes focus; the configure dialog shows a refused save above its buttons.
 *
 * @see components/admin/orchestration/agent-capabilities-tab.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AgentCapabilitiesTab } from '@/components/admin/orchestration/agent-capabilities-tab';

// The real APIClientError and apiErrorFromResponse, so failures are read as in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const AGENT_ID = 'agent-1';

function capability(id: string, name: string) {
  return {
    id,
    name,
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    description: null,
    category: 'general',
    isActive: true,
    rateLimit: null,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
  };
}
const SEARCH = capability('cap-search', 'Web Search');
const CALC = capability('cap-calc', 'Calculator');
const LINK = {
  id: 'link-1',
  agentId: AGENT_ID,
  capabilityId: SEARCH.id,
  isEnabled: true,
  customConfig: null,
  customRateLimit: null,
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
  capability: SEARCH,
};

async function renderTab() {
  const { apiClient } = await import('@/lib/api/client');
  vi.mocked(apiClient.get).mockImplementation((url: string) => {
    if (url.includes('/usage')) return Promise.resolve({ usage: {} });
    if (url.includes('/agents/')) return Promise.resolve([LINK]);
    return Promise.resolve([SEARCH, CALC]);
  });
  render(<AgentCapabilitiesTab agentId={AGENT_ID} />);
  await screen.findByText('Web Search');
}

describe('AgentCapabilitiesTab — failed saves', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a refused switch above the lists and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('This binding belongs to the platform', 'FORBIDDEN', 403)
    );
    const user = userEvent.setup();
    await renderTab();

    await user.click(screen.getByRole('switch', { name: 'Toggle Web Search' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This binding belongs to the platform');
    // Directly above the two lists.
    expect(alert.nextElementSibling).toContainElement(screen.getByText('Attached'));
    expect(alert).toHaveFocus();
  });

  it('shows a refused attach in the same box', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Capability already attached', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    await renderTab();

    await user.click(screen.getByRole('button', { name: 'Attach' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Capability already attached');
  });

  it('shows a refused configure save above the dialog buttons, read from the raw response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'customRateLimit is too high' },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const user = userEvent.setup();
    await renderTab();

    await user.click(screen.getByRole('button', { name: 'Configure Web Search' }));
    const dialog = await screen.findByRole('dialog');
    const save = within(dialog).getByRole('button', { name: 'Save' });
    await user.click(save);

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('customRateLimit is too high');
    expect(alert.nextElementSibling).toContainElement(save);
    expect(alert).toHaveFocus();
  });
});
