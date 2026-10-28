// @vitest-environment happy-dom

/**
 * PlatformBindingOwner — failed hand-back (§124)
 *
 * A refused hand-back shows directly above "Let the platform choose" and takes
 * focus; it used to sit below the button, unfocused.
 *
 * @see components/admin/orchestration/platform-binding-owner.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { PlatformBindingOwner } from '@/components/admin/orchestration/platform-binding-owner';

// The real APIClientError, so the failure is read as it would be in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

describe('PlatformBindingOwner — failed hand-back', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows the refusal directly above the button and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('Cannot hand back while provider changes', 'VALIDATION_ERROR', 400)
    );
    const user = userEvent.setup();
    render(
      <PlatformBindingOwner
        agentId="agent-1"
        bindingOwner="org"
        hasUnsavedChanges={false}
        onHandedBack={vi.fn()}
      />
    );

    const button = screen.getByRole('button', { name: /let the platform choose/i });
    await user.click(button);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Cannot hand back while provider changes');
    expect(alert.nextElementSibling).toContainElement(button);
    expect(alert).toHaveFocus();
  });
});
