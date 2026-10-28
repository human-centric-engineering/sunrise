// @vitest-environment happy-dom

/**
 * FeatureFlagList — failed saves (§124)
 *
 * A refused toggle shows in the one box above the table and takes focus; a
 * refused delete keeps its dialog open with the failure inside it.
 *
 * @see components/admin/feature-flag-list.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { FeatureFlagList } from '@/components/admin/feature-flag-list';
import type { FeatureFlag } from '@/types/prisma';

// The real APIClientError, so the list reads the failure as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const flag: FeatureFlag = {
  id: 'flag_123',
  name: 'TEST_FLAG',
  enabled: false,
  description: 'Test flag description',
  metadata: {},
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
  createdBy: null,
};

function renderList() {
  render(<FeatureFlagList initialFlags={[flag]} onCreateClick={vi.fn()} onEditClick={vi.fn()} />);
}

describe('FeatureFlagList — failed saves', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows a refused toggle above the table and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('Flag is locked', 'FORBIDDEN', 403)
    );
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByLabelText('Toggle TEST_FLAG'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Flag is locked');
    // Directly above the table's wrapper.
    expect(alert.nextElementSibling).toContainElement(screen.getByRole('table'));
    expect(alert).toHaveFocus();
  });

  it('keeps the delete dialog open with the failure inside it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.delete).mockRejectedValue(
      new APIClientError('Flag is still referenced', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByRole('button', { name: 'Delete TEST_FLAG' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Flag is still referenced');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(alert).toHaveFocus();
  });
});
