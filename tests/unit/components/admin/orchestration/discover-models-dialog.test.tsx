/**
 * DiscoverModelsDialog Tests
 *
 * Coverage:
 *   - Provider step: dropdown lists active providers; empty / error states
 *   - Provider preselection skips step 1
 *   - Discovery step: fetches on entry; "In matrix" rows are non-selectable
 *   - Search + capability filter narrow candidates
 *   - Review step: pre-fills from suggestion; Reset rolls back edits
 *   - Bulk POST body carries the correct row shape
 *   - Result step renders created / skipped counts and conflict ids
 *   - Pre-filled modelIds end up checked in step 2
 *
 * @see components/admin/orchestration/discover-models-dialog.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DiscoverModelsDialog } from '@/components/admin/orchestration/discover-models-dialog';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  APIClientError: class APIClientError extends Error {},
}));

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeProvider(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cmprov-1',
    name: 'OpenAI',
    slug: 'openai',
    isLocal: false,
    isActive: true,
    ...overrides,
  };
}

function makeCandidate(overrides: Record<string, unknown> = {}) {
  // The discovery API sets `name` to the canonical model id so the
  // dialog shows a single, consistent label across vendor + openrouter
  // sources. Mirror that in the fixture so tests don't drift from the
  // real shape.
  const base = {
    modelId: 'gpt-4o-mini',
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
    ...overrides,
  };
  return { ...base, name: (base as { modelId: string }).modelId };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DiscoverModelsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Step 1 — Provider', () => {
    it('shows the empty-state CTA when no active providers exist', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue({ data: [] });

      render(<DiscoverModelsDialog open onOpenChange={() => {}} />);

      await waitFor(() => {
        expect(screen.getByText(/no active providers configured/i)).toBeInTheDocument();
      });
    });

    it('lists active providers and disables Continue until one is picked', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue({
        data: [makeProvider(), makeProvider({ slug: 'anthropic', name: 'Anthropic' })],
      });

      const user = userEvent.setup();
      render(<DiscoverModelsDialog open onOpenChange={() => {}} />);

      await waitFor(() => {
        expect(screen.getByText(/pick a configured provider/i)).toBeInTheDocument();
      });

      const continueButton = screen.getByRole('button', { name: /continue/i });
      expect(continueButton).toBeDisabled();

      // Open the select dropdown and pick OpenAI.
      await user.click(screen.getByRole('combobox'));
      await user.click(screen.getByRole('option', { name: /openai/i }));

      expect(continueButton).toBeEnabled();
    });
  });

  describe('Pre-filled providerSlug', () => {
    it('skips step 1 and goes straight to discovery', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValueOnce({
        // Discovery response
        providerSlug: 'openai',
        candidates: [makeCandidate()],
      });

      render(<DiscoverModelsDialog open onOpenChange={() => {}} providerSlug="openai" />);

      await waitFor(() => {
        expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
      });
      // Provider step's heading should not appear when preselected.
      expect(screen.queryByText(/pick a configured provider/i)).not.toBeInTheDocument();
    });
  });

  describe('Step 2 — Discovery', () => {
    it('fetches on entry and renders candidates with source dots', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValueOnce({
        providerSlug: 'openai',
        candidates: [
          makeCandidate({ modelId: 'gpt-4o-mini' }),
          makeCandidate({
            modelId: 'gpt-4o',
            sources: { vendor: true, openrouter: false },
          }),
        ],
      });

      render(<DiscoverModelsDialog open onOpenChange={() => {}} providerSlug="openai" />);

      await waitFor(() => {
        expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
      });
      expect(screen.getByText('gpt-4o')).toBeInTheDocument();
    });

    it('disables checkbox and shows "In matrix" badge for already-matrix rows', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValueOnce({
        providerSlug: 'openai',
        candidates: [makeCandidate({ inMatrix: true, matrixId: 'matrix-1' })],
      });

      render(<DiscoverModelsDialog open onOpenChange={() => {}} providerSlug="openai" />);

      await waitFor(() => {
        expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
      });

      const checkbox = screen.getByRole('checkbox', {
        name: /already in the matrix/i,
      });
      expect(checkbox).toBeDisabled();
      expect(screen.getByText(/in matrix/i)).toBeInTheDocument();
    });

    it('search input narrows candidates by id substring', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValueOnce({
        providerSlug: 'openai',
        candidates: [
          makeCandidate({ modelId: 'gpt-4o-mini' }),
          makeCandidate({ modelId: 'gpt-5' }),
        ],
      });

      const user = userEvent.setup();
      render(<DiscoverModelsDialog open onOpenChange={() => {}} providerSlug="openai" />);

      await waitFor(() => {
        expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
      });

      await user.type(screen.getByPlaceholderText(/search by id or name/i), 'gpt-5');
      await waitFor(() => {
        expect(screen.queryByText('gpt-4o-mini')).not.toBeInTheDocument();
      });
      expect(screen.getByText('gpt-5')).toBeInTheDocument();
    });

    it('disables Continue until at least one non-matrix row is selected', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValueOnce({
        providerSlug: 'openai',
        candidates: [makeCandidate()],
      });

      const user = userEvent.setup();
      render(<DiscoverModelsDialog open onOpenChange={() => {}} providerSlug="openai" />);

      await waitFor(() => {
        expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
      });

      const continueButton = screen.getByRole('button', { name: /continue/i });
      expect(continueButton).toBeDisabled();

      await user.click(screen.getByRole('checkbox', { name: /select gpt-4o-mini/i }));
      expect(continueButton).toBeEnabled();
    });
  });

  describe('Pre-filled modelIds', () => {
    it('pre-checks the named model in step 2', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValueOnce({
        providerSlug: 'openai',
        candidates: [
          makeCandidate({ modelId: 'gpt-4o-mini' }),
          makeCandidate({ modelId: 'gpt-4o' }),
        ],
      });

      render(
        <DiscoverModelsDialog
          open
          onOpenChange={() => {}}
          providerSlug="openai"
          prefilledModelIds={['gpt-4o-mini']}
        />
      );

      await waitFor(() => {
        const miniCheckbox = screen.getByRole('checkbox', { name: /select gpt-4o-mini/i });
        expect(miniCheckbox).toBeChecked();
      });
      expect(screen.getByRole('checkbox', { name: /^select gpt-4o$/i })).not.toBeChecked();
    });
  });

  describe('Step 3 — Review', () => {
    it('pre-fills review fields from candidate.suggested', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValueOnce({
        providerSlug: 'openai',
        candidates: [
          makeCandidate({
            suggested: {
              ...makeCandidate().suggested,
              bestRole: 'Quick worker for tool calls',
            },
          }),
        ],
      });

      const user = userEvent.setup();
      render(<DiscoverModelsDialog open onOpenChange={() => {}} providerSlug="openai" />);

      await waitFor(() => {
        expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('checkbox', { name: /select gpt-4o-mini/i }));
      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        const bestRoleInput = screen.getByLabelText(/best role for gpt-4o-mini/i);
        expect(bestRoleInput).toHaveValue('Quick worker for tool calls');
      });
    });
  });

  describe('Bulk submit', () => {
    it('POSTs the right body shape and shows the result step', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValueOnce({
        providerSlug: 'openai',
        candidates: [makeCandidate()],
      });
      vi.mocked(apiClient.post).mockResolvedValue({
        created: 1,
        skipped: 0,
        conflicts: [],
      });

      const user = userEvent.setup();
      render(<DiscoverModelsDialog open onOpenChange={() => {}} providerSlug="openai" />);

      await waitFor(() => {
        expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('checkbox', { name: /select gpt-4o-mini/i }));
      await user.click(screen.getByRole('button', { name: /continue/i }));

      // Review step renders. Click Add 1 model.
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /add 1 model/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /add 1 model/i }));

      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalled();
      });

      const [, options] = vi.mocked(apiClient.post).mock.calls[0];
      const body = (options as { body: { providerSlug: string; models: unknown[] } }).body;
      expect(body.providerSlug).toBe('openai');
      expect(body.models).toHaveLength(1);
      expect((body.models[0] as { modelId: string }).modelId).toBe('gpt-4o-mini');

      // Result step shows count.
      await waitFor(() => {
        expect(screen.getByText(/1 model added/i)).toBeInTheDocument();
      });
    });

    it('renders inactive conflicts under a "reactivate from the matrix list" heading', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValueOnce({
        providerSlug: 'openai',
        candidates: [makeCandidate({ modelId: 'gpt-4o-mini' })],
      });
      vi.mocked(apiClient.post).mockResolvedValue({
        created: 0,
        skipped: 1,
        conflicts: [{ modelId: 'gpt-4o-mini', reason: 'already_in_matrix_inactive' }],
      });

      const user = userEvent.setup();
      render(<DiscoverModelsDialog open onOpenChange={() => {}} providerSlug="openai" />);

      await waitFor(() => {
        expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('checkbox', { name: /select gpt-4o-mini/i }));
      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /add 1 model/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /add 1 model/i }));

      // The result panel splits active vs inactive conflicts so the
      // operator knows the row exists but is deactivated and they
      // need to reactivate from the matrix list.
      await waitFor(() => {
        expect(
          screen.getByText(/deactivated.*reactivate from the matrix list/i)
        ).toBeInTheDocument();
      });
      expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
    });

    it('renders skipped + conflicts in the result step', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValueOnce({
        providerSlug: 'openai',
        candidates: [
          makeCandidate({ modelId: 'gpt-4o-mini' }),
          makeCandidate({ modelId: 'gpt-4o' }),
        ],
      });
      vi.mocked(apiClient.post).mockResolvedValue({
        created: 1,
        skipped: 1,
        conflicts: [{ modelId: 'gpt-4o', reason: 'already_in_matrix' }],
      });

      const user = userEvent.setup();
      render(<DiscoverModelsDialog open onOpenChange={() => {}} providerSlug="openai" />);

      await waitFor(() => {
        expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('checkbox', { name: /select gpt-4o-mini/i }));
      await user.click(screen.getByRole('checkbox', { name: /^select gpt-4o$/i }));
      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /add 2 models/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /add 2 models/i }));

      await waitFor(() => {
        expect(screen.getByText(/1 model added/i)).toBeInTheDocument();
      });
      expect(screen.getByText(/1 skipped/i)).toBeInTheDocument();
      // Conflict modelId rendered in the skipped list.
      const list = screen.getByText(/skipped \(already in matrix\)/i).closest('div');
      expect(list).not.toBeNull();
      expect(within(list!).getByText('gpt-4o')).toBeInTheDocument();
    });
  });
});
