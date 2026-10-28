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
import { act, render, screen, within } from '@testing-library/react';
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

const otherFlag: FeatureFlag = { ...flag, id: 'flag_456', name: 'OTHER_FLAG' };

function renderList(flags: FeatureFlag[] = [flag]) {
  render(<FeatureFlagList initialFlags={flags} onCreateClick={vi.fn()} onEditClick={vi.fn()} />);
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
    // The box sits away from the row, so it names the row.
    expect(alert).toHaveTextContent('Couldn\'t update "TEST_FLAG": Flag is locked');
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

  it('is committed to a delete in flight: no second request, no Cancel, no Escape', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.delete).mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByRole('button', { name: 'Delete TEST_FLAG' }));
    const dialog = await screen.findByRole('alertdialog');
    const action = within(dialog).getByRole('button', { name: 'Delete' });
    await user.click(action);

    const pending = within(dialog).getByRole('button', { name: 'Deleting...' });
    expect(pending).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await user.click(pending);
    await user.keyboard('{Escape}');

    expect(apiClient.delete).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it("never shows one row's failed delete in the next row's dialog", async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    let reject: (err: unknown) => void = () => {};
    vi.mocked(apiClient.delete).mockReturnValue(
      new Promise((_, rej) => {
        reject = rej;
      })
    );
    const user = userEvent.setup();
    renderList([flag, otherFlag]);

    await user.click(screen.getByRole('button', { name: 'Delete TEST_FLAG' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' })
    );
    // An attempt to leave while the request is in flight, then it fails.
    await user.keyboard('{Escape}');
    await act(async () => reject(new APIClientError('Flag is still referenced', 'CONFLICT', 409)));
    // Leave the dialog if it is still open (it should be: it ignored the Escape).
    const open = screen.queryByRole('alertdialog');
    if (open) await user.click(within(open).getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: 'Delete OTHER_FLAG' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    expect(dialog).not.toHaveTextContent('Flag is still referenced');
  });
});
