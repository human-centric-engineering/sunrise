// @vitest-environment happy-dom

/**
 * PlatformBindingOwner — who decides a platform agent's provider and model,
 * and the hand-back to the platform (t-818).
 *
 * @see components/admin/orchestration/platform-binding-owner.tsx
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api/client', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

import { apiClient, APIClientError } from '@/lib/api/client';
import { PlatformBindingOwner } from '@/components/admin/orchestration/platform-binding-owner';
import { API } from '@/lib/api/endpoints';

const AGENT_ID = 'cmagent0000000000000clean';

function renderOwner(props: Partial<Parameters<typeof PlatformBindingOwner>[0]> = {}) {
  const onHandedBack = vi.fn();
  render(
    <PlatformBindingOwner
      agentId={AGENT_ID}
      bindingOwner="org"
      hasUnsavedChanges={false}
      onHandedBack={onHandedBack}
      {...props}
    />
  );
  return { onHandedBack };
}

describe('PlatformBindingOwner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('says the platform picks them, and offers no hand-back, while the platform owns them', () => {
    renderOwner({ bindingOwner: 'platform' });

    expect(screen.getByTestId('binding-owner-platform')).toHaveTextContent(
      'The platform picks them: the strongest model this organisation can reach.'
    );
    expect(screen.queryByRole('button', { name: /let the platform choose/i })).toBeNull();
  });

  it('says the org set them, and offers the hand-back, once the org owns them', () => {
    renderOwner({ bindingOwner: 'org' });

    expect(screen.getByTestId('binding-owner-org')).toHaveTextContent(
      'Set by this organisation. The platform no longer moves them.'
    );
    expect(screen.getByRole('button', { name: /let the platform choose/i })).toBeEnabled();
  });

  it('says an unclassified binding is still to be settled', () => {
    renderOwner({ bindingOwner: null });

    expect(screen.getByTestId('binding-owner-org')).toHaveTextContent(/not yet decided/i);
  });

  it('hands the binding back with a PATCH, and gives the form the row it returned', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockResolvedValue({ provider: 'openai', model: 'gpt-4.1' });
    const { onHandedBack } = renderOwner();

    await user.click(screen.getByRole('button', { name: /let the platform choose/i }));

    expect(apiClient.patch).toHaveBeenCalledWith(API.ADMIN.ORCHESTRATION.agentById(AGENT_ID), {
      body: { bindingOwner: 'platform' },
    });
    await waitFor(() =>
      expect(onHandedBack).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-4.1' })
    );
  });

  it('does not offer the hand-back while the form has unsaved changes', async () => {
    const user = userEvent.setup();
    renderOwner({ hasUnsavedChanges: true });

    const button = screen.getByRole('button', { name: /let the platform choose/i });
    expect(button).toBeDisabled();
    expect(screen.getByTestId('binding-owner-unsaved')).toHaveTextContent(
      'Save your changes first.'
    );
    await user.click(button);
    expect(apiClient.patch).not.toHaveBeenCalled(); // test-review:accept no_arg_called — the disabled button must send nothing
  });

  it('shows the API’s refusal, and does not reload', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('Cannot hand the binding back in the same request that changes it')
    );
    const { onHandedBack } = renderOwner();

    await user.click(screen.getByRole('button', { name: /let the platform choose/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Cannot hand the binding back in the same request that changes it'
    );
    expect(onHandedBack).not.toHaveBeenCalled(); // test-review:accept no_arg_called — a refused hand-back must not reload
  });

  it('explains both states in a help popover', async () => {
    const user = userEvent.setup();
    renderOwner();

    await user.click(screen.getByRole('button', { name: /more information/i }));

    expect(
      await screen.findByText(
        /hands them back: the agent moves at once, or on the next maintenance pass/i
      )
    ).toBeVisible();
  });
});
