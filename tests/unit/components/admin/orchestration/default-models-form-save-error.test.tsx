// @vitest-environment happy-dom

/**
 * DefaultModelsForm — failed save (§124)
 *
 * The form has a different Save per mode: the header's "Save changes" on the
 * settings page, the footer's "Save & continue" in the setup wizard. The
 * error sits beside whichever one was pressed.
 *
 * @see components/admin/orchestration/default-models-form.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DefaultModelsForm } from '@/components/admin/orchestration/default-models-form';
import type { OrchestrationSettings } from '@/types/orchestration';
import type { ModelInfo } from '@/lib/orchestration/llm/types';

// The real APIClientError, so the form reads `details` as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

/** Only chat is stored, so "Use suggestion" on another slot makes the form dirty. */
const SETTINGS = {
  id: 'settings-1',
  slug: 'global',
  defaultModels: {
    routing: 'claude-haiku-4-5',
    chat: 'claude-sonnet-4-6',
    reasoning: 'claude-opus-4-6',
    embeddings: '',
    audio: '',
  },
  defaultModelsStored: { chat: 'claude-sonnet-4-6' },
} as unknown as OrchestrationSettings;

const MODELS: ModelInfo[] = [
  {
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic',
    tier: 'budget',
    inputCostPerMillion: 1,
    outputCostPerMillion: 5,
    maxContext: 200_000,
    supportsTools: true,
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    tier: 'mid',
    inputCostPerMillion: 3,
    outputCostPerMillion: 15,
    maxContext: 200_000,
    supportsTools: true,
  },
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    provider: 'anthropic',
    tier: 'frontier',
    inputCostPerMillion: 15,
    outputCostPerMillion: 75,
    maxContext: 200_000,
    supportsTools: true,
  },
];

const PROVIDERS = [{ slug: 'anthropic', name: 'Anthropic', isActive: true }];

async function rejectWith(errors: Array<{ path: string; message: string }>) {
  const { apiClient, APIClientError } = await import('@/lib/api/client');
  vi.mocked(apiClient.patch).mockRejectedValue(
    new APIClientError('Invalid request body', 'VALIDATION_ERROR', 400, { errors })
  );
}

async function rejectAsConflict() {
  const { apiClient, APIClientError } = await import('@/lib/api/client');
  vi.mocked(apiClient.patch).mockRejectedValue(
    new APIClientError('Settings are locked', 'CONFLICT', 409)
  );
}

describe('DefaultModelsForm — failed save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows the failure beside the header Save on the settings page, and focuses it', async () => {
    await rejectAsConflict();
    const user = userEvent.setup();
    render(<DefaultModelsForm settings={SETTINGS} models={MODELS} providers={PROVIDERS} />);

    await user.click(screen.getAllByRole('button', { name: /use suggestion/i })[0]);
    const save = screen.getByRole('button', { name: /save changes/i });
    await user.click(save);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Settings are locked');
    // Directly under the row holding Save.
    expect(alert.previousElementSibling).toBe(save.parentElement);
    expect(alert).toHaveFocus();
  });

  it('shows the failure beside "Save & continue" in the wizard, and focuses it', async () => {
    await rejectAsConflict();
    const onComplete = vi.fn();
    const user = userEvent.setup();
    render(
      <DefaultModelsForm
        settings={SETTINGS}
        models={MODELS}
        providers={PROVIDERS}
        wizardMode={{ onComplete }}
      />
    );

    await user.click(screen.getAllByRole('button', { name: /use suggestion/i })[0]);
    const save = screen.getByRole('button', { name: /save & continue/i });
    await user.click(save);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Settings are locked');
    // Directly above the row holding Save, under the footer's own hint.
    expect(alert.nextElementSibling).toBe(save.parentElement);
    expect(alert).toHaveFocus();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('puts a slot the server rejected under that slot', async () => {
    await rejectWith([{ path: 'defaultModels.chat', message: 'Unknown model for chat' }]);
    const user = userEvent.setup();
    render(<DefaultModelsForm settings={SETTINGS} models={MODELS} providers={PROVIDERS} />);

    await user.click(screen.getAllByRole('button', { name: /use suggestion/i })[0]);
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    const message = await screen.findByText('Unknown model for chat');
    // Under the chat slot, not in the summary.
    expect(message.parentElement).toContainElement(document.getElementById('model-chat'));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('1 field needs fixing.');
    expect(alert).not.toHaveTextContent('Unknown model for chat');
    // The slot's Select carries id `model-chat`, not the field name, so the
    // summary takes focus (.context/ui/form-errors.md, "Finding the field").
    expect(alert).toHaveFocus();
  });
});
