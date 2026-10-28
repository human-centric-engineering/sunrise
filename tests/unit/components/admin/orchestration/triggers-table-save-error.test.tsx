// @vitest-environment happy-dom

/**
 * TriggersTable — failed delete (§124)
 *
 * A refused delete used to go to `alert()`; it now shows in the one box above
 * the table, which takes focus.
 *
 * @see components/admin/orchestration/triggers-table.tsx
 * @see .context/ui/form-errors.md
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  TriggersTable,
  type TriggerListItem,
} from '@/components/admin/orchestration/triggers-table';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

// The real APIClientError, so the table reads the error as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const TRIGGER: TriggerListItem = {
  id: 'trig_1',
  channel: 'twilio',
  name: 'SMS intake',
  workflowId: 'wf_1',
  metadata: null,
  isEnabled: true,
  hasSigningSecret: false,
  lastFiredAt: null,
  createdAt: '2026-05-24T10:00:00Z',
  workflow: { id: 'wf_1', name: 'Inbound conversation', slug: 'inbound-conv', isActive: true },
};

describe('TriggersTable — failed delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true)
    );
    vi.stubGlobal('alert', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the refusal in the box above the table, and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.delete).mockRejectedValue(
      new APIClientError('Trigger is in use', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    render(<TriggersTable triggers={[TRIGGER]} enabledChannels={['twilio']} />);

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Trigger is in use');
    expect(alert.compareDocumentPosition(screen.getByRole('table'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    await waitFor(() => expect(alert).toHaveFocus());
    expect(window.alert).not.toHaveBeenCalled();
  });
});
