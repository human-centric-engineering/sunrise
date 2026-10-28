// @vitest-environment happy-dom

/**
 * AgentsTable — failed saves (§124)
 *
 * A refused status toggle shows in the box above the table and takes focus.
 * A refused delete or bulk delete keeps its dialog open with the failure
 * inside it (each used to close, losing the error).
 *
 * @see components/admin/orchestration/agents-table.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AgentsTable } from '@/components/admin/orchestration/agents-table';
import type { PaginationMeta } from '@/types/api';
import type { AiAgentListItem } from '@/types/orchestration';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));

// The real APIClientError, so the table reads the failure as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const agent = {
  id: 'agent-1',
  name: 'Alpha',
  slug: 'alpha',
  description: 'A test agent',
  systemInstructions: 'You are helpful',
  provider: 'anthropic',
  providerConfig: null,
  model: 'claude-opus-4-6',
  temperature: 0.7,
  maxTokens: 4096,
  monthlyBudgetUsd: null,
  isActive: true,
  createdBy: 'system',
  createdAt: new Date('2025-01-01T00:00:00Z'),
  updatedAt: new Date('2025-01-01T00:00:00Z'),
  systemInstructionsHistory: [],
  metadata: {},
  _count: { capabilities: 0, conversations: 0 },
  _budget: null,
} as unknown as AiAgentListItem;
const meta: PaginationMeta = { page: 1, limit: 25, total: 1, totalPages: 1 };

describe('AgentsTable — failed saves', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    // Background loads (profiles, the list) answer with an empty success.
    global.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ success: true, data: [], meta }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
  });

  it('shows a refused status toggle above the table and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('System agents cannot be deactivated', 'FORBIDDEN', 403)
    );
    const user = userEvent.setup();
    render(<AgentsTable initialAgents={[agent]} initialMeta={meta} />);

    await user.click(screen.getAllByRole('switch')[0]);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('System agents cannot be deactivated');
    expect(alert.nextElementSibling).toContainElement(screen.getByRole('table'));
    expect(alert).toHaveFocus();
  });

  it('keeps the delete dialog open with the failure inside it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.delete).mockRejectedValue(
      new APIClientError('Agent is referenced by a workflow', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    render(<AgentsTable initialAgents={[agent]} initialMeta={meta} />);

    await user.click(screen.getByRole('button', { name: /row actions/i }));
    await user.click(await screen.findByRole('menuitem', { name: /delete/i, hidden: true }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Agent is referenced by a workflow');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(alert).toHaveFocus();
  });

  it('keeps the bulk delete dialog open with the failure inside it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Bulk delete is not allowed', 'FORBIDDEN', 403)
    );
    const user = userEvent.setup();
    render(<AgentsTable initialAgents={[agent]} initialMeta={meta} />);

    await user.click(screen.getAllByRole('checkbox')[1]);
    await user.click(screen.getByRole('button', { name: /delete \(1\)/i }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Bulk delete is not allowed');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(alert).toHaveFocus();
  });
});
