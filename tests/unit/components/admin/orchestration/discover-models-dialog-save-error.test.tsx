// @vitest-environment happy-dom

/**
 * DiscoverModelsDialog — failed add (§124)
 *
 * A refused bulk add shows directly above the pinned footer holding the Add
 * button, not at the top of the scrolling review list.
 *
 * @see components/admin/orchestration/discover-models-dialog.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DiscoverModelsDialog } from '@/components/admin/orchestration/discover-models-dialog';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));

// The real APIClientError, so the dialog reads the failure as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const CANDIDATE = {
  modelId: 'gpt-4o-mini',
  name: 'gpt-4o-mini',
  sources: { vendor: true, openrouter: true },
  inMatrix: false,
  matrixId: null,
  inferredCapability: 'chat',
  suggested: {
    capabilities: ['chat'],
    tierRole: 'worker',
    reasoningDepth: 'medium',
    latency: 'fast',
    costEfficiency: 'very_high',
    contextLength: 'high',
    toolUse: 'strong',
    bestRole: 'Quick worker for tool calls',
    inputCostPerMillion: 0.15,
    outputCostPerMillion: 0.6,
    maxContext: 128000,
    slug: 'openai-gpt-4o-mini',
  },
};

describe('DiscoverModelsDialog — failed add', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows the refusal directly above the footer holding Add, and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue({ providerSlug: 'openai', candidates: [CANDIDATE] });
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Model gpt-4o-mini already exists', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    render(<DiscoverModelsDialog open onOpenChange={() => {}} providerSlug="openai" />);

    await user.click(await screen.findByRole('checkbox', { name: /select gpt-4o-mini/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    const add = await screen.findByRole('button', { name: /add 1 model/i });
    await user.click(add);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Model gpt-4o-mini already exists');
    expect(alert.nextElementSibling).toContainElement(add);
    expect(alert).toHaveFocus();
  });

  it('is committed to an add in flight: no second request, no Cancel or Back, no Escape', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue({ providerSlug: 'openai', candidates: [CANDIDATE] });
    vi.mocked(apiClient.post).mockReturnValue(new Promise(() => {}));
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<DiscoverModelsDialog open onOpenChange={onOpenChange} providerSlug="openai" />);

    await user.click(await screen.findByRole('checkbox', { name: /select gpt-4o-mini/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(await screen.findByRole('button', { name: /add 1 model/i }));

    const pending = screen.getByRole('button', { name: /adding/i });
    expect(pending).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /back/i })).toBeDisabled();
    await user.click(pending);
    await user.keyboard('{Escape}');

    expect(apiClient.post).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled(); // test-review:accept no_arg_called — the in-flight dialog must not ask to close;
  });
});
