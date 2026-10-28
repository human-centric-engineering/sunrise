// @vitest-environment happy-dom

/**
 * CapabilitiesTable — failed saves (§124)
 *
 * A refused status toggle shows in the box above the table and takes focus.
 * A refused delete keeps the delete dialog open with the refusal inside it;
 * the table used to close the dialog first and pass it `error={null}`.
 *
 * @see components/admin/orchestration/capabilities-table.tsx
 * @see components/admin/orchestration/delete-capability-dialog.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CapabilitiesTable } from '@/components/admin/orchestration/capabilities-table';
import type { PaginationMeta } from '@/types/api';
import type { AiCapabilityListItem } from '@/types/orchestration';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));

// The real APIClientError, so the table reads the failure as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const capability = {
  id: 'cap-1',
  name: 'Alpha Search',
  slug: 'alpha-search',
  description: 'A test capability',
  category: 'knowledge',
  executionType: 'internal',
  executionHandler: 'search',
  executionConfig: null,
  functionDefinition: {},
  requiresApproval: false,
  rateLimit: null,
  isActive: true,
  createdBy: 'system',
  createdAt: new Date('2025-01-01T00:00:00Z'),
  updatedAt: new Date('2025-01-01T00:00:00Z'),
  deletedAt: null,
  metadata: {},
  _agents: [],
  _otherOrgAgentCount: 0,
} as unknown as AiCapabilityListItem;
const meta: PaginationMeta = { page: 1, limit: 25, total: 1, totalPages: 1 };

function renderTable() {
  render(
    <CapabilitiesTable
      initialCapabilities={[capability]}
      initialMeta={meta}
      availableCategories={['knowledge']}
    />
  );
}

describe('CapabilitiesTable — failed saves', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    global.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ success: true, data: [capability], meta }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
  });

  it('shows a refused status toggle above the table and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('System capabilities cannot be disabled', 'FORBIDDEN', 403)
    );
    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getAllByRole('switch')[0]);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Couldn\'t update "Alpha Search": System capabilities cannot be disabled'
    );
    expect(alert.nextElementSibling).toContainElement(screen.getByRole('table'));
    expect(alert).toHaveFocus();
  });

  it('keeps the delete dialog open with the refusal above its buttons', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.delete).mockRejectedValue(
      new APIClientError('In use by 2 agents', 'CAPABILITY_IN_USE', 409)
    );
    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByRole('button', { name: /row actions/i }));
    await user.click(await screen.findByRole('menuitem', { name: /delete/i, hidden: true }));
    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: 'Delete' });
    await user.click(confirm);

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('In use by 2 agents');
    expect(alert.nextElementSibling).toContainElement(confirm);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(alert).toHaveFocus();
  });
});
