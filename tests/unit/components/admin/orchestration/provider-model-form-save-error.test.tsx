// @vitest-environment happy-dom

/**
 * ProviderModelForm — failed save (§124)
 *
 * The error sits in the sticky bar beside Save, so it stays in view; a field
 * the server named gets its message under it and takes focus.
 *
 * @see components/admin/orchestration/provider-model-form.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  ProviderModelForm,
  type ProviderModelData,
} from '@/components/admin/orchestration/provider-model-form';

vi.mock('next/navigation', async () => {
  const { createMockRouter } = await import('@/tests/types/mocks');
  return {
    useRouter: () => createMockRouter(),
    useSearchParams: () => ({ get: () => null }),
  };
});

// The real APIClientError, so the form reads `details` as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

/** A chat model: the price fields show, the embedding fields don't. */
const MODEL: ProviderModelData = {
  id: 'model-1',
  slug: 'anthropic-claude',
  providerSlug: 'anthropic',
  modelId: 'claude-opus-4',
  name: 'Claude Opus 4',
  description: 'Flagship model',
  capabilities: ['chat'],
  tierRole: 'thinking',
  reasoningDepth: 'very_high',
  latency: 'medium',
  costEfficiency: 'none',
  contextLength: 'very_high',
  toolUse: 'strong',
  bestRole: 'Planner / orchestrator',
  isDefault: false,
  isActive: true,
};

async function rejectWith(errors: Array<{ path: string; message: string }>) {
  const { apiClient, APIClientError } = await import('@/lib/api/client');
  vi.mocked(apiClient.patch).mockRejectedValue(
    new APIClientError('Invalid request body', 'VALIDATION_ERROR', 400, { errors })
  );
}

describe('ProviderModelForm — failed save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows the failure in the sticky bar beside Save, and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('Slug already taken', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    render(<ProviderModelForm model={MODEL} />);

    const save = screen.getByRole('button', { name: /save changes/i });
    await user.click(save);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Slug already taken');
    const bar = alert.parentElement;
    expect(bar).toHaveClass('sticky');
    expect(bar).toContainElement(save);
    expect(alert).toHaveFocus();
  });

  it('puts a field the server rejected under that field and focuses it', async () => {
    await rejectWith([{ path: 'inputCostPerMillionTokens', message: 'Price is too high' }]);
    const user = userEvent.setup();
    render(<ProviderModelForm model={MODEL} />);

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText('Price is too high')).toBeInTheDocument();
    await waitFor(() =>
      expect(document.querySelector('[name="inputCostPerMillionTokens"]')).toHaveFocus()
    );
    expect(screen.getByRole('alert')).toHaveTextContent('1 field needs fixing.');
  });

  it('keeps a message for a field in a hidden section in the summary', async () => {
    // A chat model shows no embedding fields: placed there, the message would be lost.
    await rejectWith([{ path: 'dimensions', message: 'Dimensions must be positive' }]);
    const user = userEvent.setup();
    render(<ProviderModelForm model={MODEL} />);

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Dimensions must be positive');
    expect(alert).toHaveFocus();
  });
});
