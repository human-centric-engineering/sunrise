// @vitest-environment happy-dom

/**
 * ProviderKeyForm (§137 t-1045): puts the pasted key to the provider's key
 * route, trimmed of a paste's surrounding whitespace, refuses an empty one
 * before sending, and shows the API's refusal — a key that failed its test —
 * beside the button as worded.
 *
 * @see components/admin/provider-keys/provider-key-form.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockRefresh = vi.fn();
vi.mock('next/navigation', async () => {
  const { createMockRouter } = await import('@/tests/types/mocks');
  return { useRouter: () => createMockRouter({ refresh: mockRefresh }) };
});

vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { put: vi.fn() },
}));

import { ProviderKeyForm } from '@/components/admin/provider-keys/provider-key-form';
import { apiClient, APIClientError } from '@/lib/api/client';

const onDone = vi.fn();

function renderForm(replaces = false) {
  render(
    <ProviderKeyForm
      orgId="org-entered"
      providerConfigId="prov-1"
      providerName="Anthropic"
      replaces={replaces}
      onDone={onDone}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ProviderKeyForm', () => {
  it('puts the key, trimmed, to the provider’s route, then closes and refreshes', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.put).mockResolvedValue({});
    renderForm();

    await user.type(
      screen.getByLabelText(/Anthropic key/, { selector: 'input' }),
      '  sk-ant-pasted-key  '
    );
    await user.click(screen.getByRole('button', { name: 'Test and save' }));

    await waitFor(() =>
      expect(apiClient.put).toHaveBeenCalledWith('/api/v1/orgs/org-entered/provider-keys/prov-1', {
        body: { apiKey: 'sk-ant-pasted-key' },
      })
    );
    expect(onDone).toHaveBeenCalled();
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('asks password managers not to fill in the admin’s own login', () => {
    renderForm();

    expect(screen.getByLabelText(/Anthropic key/, { selector: 'input' })).toHaveAttribute(
      'autocomplete',
      'new-password'
    );
  });

  it('refuses an empty key before sending anything', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('button', { name: 'Test and save' }));

    expect(await screen.findByText('Paste the key')).toBeInTheDocument();
    expect(apiClient.put).not.toHaveBeenCalled();
  });

  it('shows a key that failed its test as the API words it, and stays open', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.put).mockRejectedValue(
      new APIClientError(
        'Anthropic did not accept this key, or could not be reached. It has not been saved.',
        'KEY_TEST_FAILED',
        422,
        { reason: 'test_failed' }
      )
    );
    renderForm();

    await user.type(screen.getByLabelText(/Anthropic key/, { selector: 'input' }), 'sk-ant-wrong');
    await user.click(screen.getByRole('button', { name: 'Test and save' }));

    expect(await screen.findByText(/did not accept this key/)).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('names a replacement as one, and cancels without sending', async () => {
    const user = userEvent.setup();
    renderForm(true);

    expect(screen.getByLabelText(/New Anthropic key/, { selector: 'input' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onDone).toHaveBeenCalled();
    expect(apiClient.put).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Test and replace' })).toBeInTheDocument();
  });
});
