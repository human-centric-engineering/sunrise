// @vitest-environment happy-dom

/**
 * ActiveEmbeddingModelForm — failed save (§124)
 *
 * The error sits beside Save. No field shows its own message, so whatever the
 * server says about a field joins the summary there.
 *
 * @see components/admin/orchestration/active-embedding-model-form.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ActiveEmbeddingModelForm } from '@/components/admin/orchestration/active-embedding-model-form';

// The real APIClientError, so the form reads `details` as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const OPTIONS = [
  {
    id: 'pm-te3-small',
    name: 'Text Embedding 3 Small',
    providerSlug: 'openai',
    modelId: 'text-embedding-3-small',
    dimensions: 1536,
  },
];

async function pickAndSave(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole('combobox'));
  await user.click(await screen.findByRole('option', { name: /text embedding 3 small/i }));
  const save = screen.getByRole('button', { name: /save/i });
  await user.click(save);
  return save;
}

describe('ActiveEmbeddingModelForm — failed save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows the failure beside Save, and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('Model is not embedding-capable', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    render(<ActiveEmbeddingModelForm initialActiveEmbeddingModelId={null} options={OPTIONS} />);

    const save = await pickAndSave(user);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Model is not embedding-capable');
    // Directly above the row holding Save.
    expect(alert.nextElementSibling).toBe(save.parentElement);
    expect(alert).toHaveFocus();
  });

  it("puts a field's message in the summary, since no field shows one", async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('Invalid request body', 'VALIDATION_ERROR', 400, {
        errors: [{ path: 'activeEmbeddingModelId', message: 'No such embedding model' }],
      })
    );
    const user = userEvent.setup();
    render(<ActiveEmbeddingModelForm initialActiveEmbeddingModelId={null} options={OPTIONS} />);

    await pickAndSave(user);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('No such embedding model');
    expect(alert).not.toHaveTextContent('field needs fixing');
    expect(alert).toHaveFocus();
  });
});
