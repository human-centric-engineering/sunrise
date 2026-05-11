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

      // Wait on the combobox itself (the actual control under test)
      // rather than the dialog description copy — the description is
      // not what we're verifying here.
      await waitFor(() => {
        expect(screen.getByRole('combobox')).toBeInTheDocument();
      });

      const continueButton = screen.getByRole('button', { name: /continue/i });
      expect(continueButton).toBeDisabled();

      // Open the select dropdown and verify BOTH providers populated
      // the option list (proves the loaded providers were mapped, not
      // just that the dialog frame rendered).
      await user.click(screen.getByRole('combobox'));
      expect(await screen.findByRole('option', { name: /openai/i })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: /anthropic/i })).toBeInTheDocument();

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

    it('renders an inline error and stays on the review step when bulk POST fails', async () => {
      // Submit error path — apiClient.post throws → setSubmitError is
      // called and the error message renders in the review step.
      // Without this test the catch arm of handleSubmit is dead code
      // for coverage purposes.
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValueOnce({
        providerSlug: 'openai',
        candidates: [makeCandidate()],
      });
      vi.mocked(apiClient.post).mockRejectedValue(new Error('Database transaction failed'));

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

      // Inline error message renders; result step is not reached.
      await waitFor(() => {
        expect(screen.getByText(/database transaction failed/i)).toBeInTheDocument();
      });
      expect(screen.queryByText(/model added/i)).not.toBeInTheDocument();
    });
  });

  describe('Step 2 — capability filter chips', () => {
    it('Image and Audio chips bucket models with matching inferredCapability', async () => {
      // Drives bucketFor's image/audio branches. The Embedding chip
      // test only hits one switch arm; this hits the rest at once.
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValueOnce({
        providerSlug: 'openai',
        candidates: [
          makeCandidate({ modelId: 'gpt-image-1', inferredCapability: 'image' }),
          makeCandidate({ modelId: 'whisper-1', inferredCapability: 'audio' }),
          makeCandidate({ modelId: 'omni-moderation', inferredCapability: 'moderation' }),
        ],
      });

      const user = userEvent.setup();
      render(<DiscoverModelsDialog open onOpenChange={() => {}} providerSlug="openai" />);

      await waitFor(() => {
        expect(screen.getByText('gpt-image-1')).toBeInTheDocument();
      });

      // Image chip narrows to image rows.
      await user.click(screen.getByRole('button', { name: /^image$/i }));
      await waitFor(() => {
        expect(screen.queryByText('whisper-1')).not.toBeInTheDocument();
      });
      expect(screen.getByText('gpt-image-1')).toBeInTheDocument();

      // Switch to Audio.
      await user.click(screen.getByRole('button', { name: /^image$/i }));
      await user.click(screen.getByRole('button', { name: /^audio$/i }));
      await waitFor(() => {
        expect(screen.queryByText('gpt-image-1')).not.toBeInTheDocument();
      });
      expect(screen.getByText('whisper-1')).toBeInTheDocument();

      // Moderation now has its own chip — previously these were lumped
      // into "Other" alongside reasoning + unknown, which made it hard
      // to scan OpenAI's mixed catalogue.
      await user.click(screen.getByRole('button', { name: /^audio$/i }));
      await user.click(screen.getByRole('button', { name: /^moderation$/i }));
      await waitFor(() => {
        expect(screen.queryByText('whisper-1')).not.toBeInTheDocument();
      });
      expect(screen.getByText('omni-moderation')).toBeInTheDocument();
    });

    it('Reasoning and Unknown chips filter independently (regression for the old Other lump)', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValueOnce({
        providerSlug: 'openai',
        candidates: [
          makeCandidate({ modelId: 'o3-mini', inferredCapability: 'reasoning' }),
          makeCandidate({ modelId: 'mystery-x', inferredCapability: 'unknown' }),
          makeCandidate({ modelId: 'omni-moderation', inferredCapability: 'moderation' }),
        ],
      });

      const user = userEvent.setup();
      render(<DiscoverModelsDialog open onOpenChange={() => {}} providerSlug="openai" />);

      await waitFor(() => {
        expect(screen.getByText('o3-mini')).toBeInTheDocument();
      });

      // Reasoning chip narrows to the reasoning row only.
      await user.click(screen.getByRole('button', { name: /^reasoning$/i }));
      await waitFor(() => {
        expect(screen.queryByText('mystery-x')).not.toBeInTheDocument();
      });
      expect(screen.getByText('o3-mini')).toBeInTheDocument();
      expect(screen.queryByText('omni-moderation')).not.toBeInTheDocument();

      // Switch to Unknown — only the unclassified row shows.
      await user.click(screen.getByRole('button', { name: /^reasoning$/i }));
      await user.click(screen.getByRole('button', { name: /^unknown$/i }));
      await waitFor(() => {
        expect(screen.queryByText('o3-mini')).not.toBeInTheDocument();
      });
      expect(screen.getByText('mystery-x')).toBeInTheDocument();
    });

    it('clicking a capability chip narrows candidates by inferredCapability', async () => {
      // Drives toggleBucket + bucketFor + the activeBuckets arm of
      // the filter memo. Previously uncovered because no test
      // interacted with the chips.
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValueOnce({
        providerSlug: 'openai',
        candidates: [
          makeCandidate({ modelId: 'gpt-4o-mini', inferredCapability: 'chat' }),
          makeCandidate({
            modelId: 'text-embedding-3-small',
            inferredCapability: 'embedding',
          }),
        ],
      });

      const user = userEvent.setup();
      render(<DiscoverModelsDialog open onOpenChange={() => {}} providerSlug="openai" />);

      await waitFor(() => {
        expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
      });
      expect(screen.getByText('text-embedding-3-small')).toBeInTheDocument();

      // Toggle Embedding chip — chat row hidden, embedding row remains.
      await user.click(screen.getByRole('button', { name: /^embedding$/i }));
      await waitFor(() => {
        expect(screen.queryByText('gpt-4o-mini')).not.toBeInTheDocument();
      });
      expect(screen.getByText('text-embedding-3-small')).toBeInTheDocument();

      // Click again to deactivate — chat row returns.
      await user.click(screen.getByRole('button', { name: /^embedding$/i }));
      await waitFor(() => {
        expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
      });
    });
  });

  describe('Step 3 — Review row editing', () => {
    it('editing review fields updates the body sent to bulk POST', async () => {
      // Exercises every per-field onChange handler in the review row
      // (name, bestRole, description, chat checkbox, embedding
      // checkbox, plus four select dropdowns). Each is its own
      // function in the source — covering them individually would
      // bloat the suite, so this single test drives the full grid.
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValueOnce({
        providerSlug: 'openai',
        candidates: [makeCandidate({ modelId: 'gpt-4o-mini' })],
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

      // Text inputs.
      const nameField = await screen.findByLabelText(/^name for gpt-4o-mini$/i);
      await user.clear(nameField);
      await user.type(nameField, 'Custom Name');

      const bestRoleField = await screen.findByLabelText(/^best role for gpt-4o-mini$/i);
      await user.clear(bestRoleField);
      await user.type(bestRoleField, 'Custom role');

      const descField = await screen.findByLabelText(/^description for gpt-4o-mini$/i);
      await user.clear(descField);
      await user.type(descField, 'Custom description');

      // Toggle the embedding checkbox (chat is on by default; turn
      // embedding on too so the body carries both capabilities).
      await user.click(
        screen.getByRole('checkbox', { name: /^embedding capability for gpt-4o-mini$/i })
      );

      await user.click(screen.getByRole('button', { name: /add 1 model/i }));

      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalled();
      });

      const [, options] = vi.mocked(apiClient.post).mock.calls[0];
      const body = (
        options as {
          body: {
            models: Array<{
              name: string;
              bestRole: string;
              description: string;
              capabilities: string[];
            }>;
          };
        }
      ).body;
      expect(body.models[0].name).toBe('Custom Name');
      expect(body.models[0].bestRole).toBe('Custom role');
      expect(body.models[0].description).toBe('Custom description');
      expect(body.models[0].capabilities).toEqual(expect.arrayContaining(['chat', 'embedding']));
    });

    it('renders six per-row capability checkboxes (chat/reasoning/embedding/audio/image/moderation)', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValueOnce({
        providerSlug: 'openai',
        candidates: [makeCandidate({ modelId: 'gpt-4o-mini' })],
      });

      const user = userEvent.setup();
      render(<DiscoverModelsDialog open onOpenChange={() => {}} providerSlug="openai" />);

      await waitFor(() => {
        expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
      });
      await user.click(screen.getByRole('checkbox', { name: /select gpt-4o-mini/i }));
      await user.click(screen.getByRole('button', { name: /continue/i }));

      // All six matrix-storable capabilities expose a checkbox per row.
      // 'unknown' is intentionally not toggleable here — the matrix rejects it.
      for (const cap of ['chat', 'reasoning', 'embedding', 'audio', 'image', 'moderation']) {
        const re = new RegExp(`^${cap} capability for gpt-4o-mini$`, 'i');
        expect(await screen.findByRole('checkbox', { name: re })).toBeInTheDocument();
      }
    });

    it('toggling the audio checkbox adds "audio" to the body capabilities', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValueOnce({
        providerSlug: 'openai',
        candidates: [makeCandidate({ modelId: 'gpt-4o-mini' })],
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

      await user.click(
        await screen.findByRole('checkbox', { name: /^audio capability for gpt-4o-mini$/i })
      );
      await user.click(screen.getByRole('button', { name: /add 1 model/i }));

      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalled();
      });
      const [, options] = vi.mocked(apiClient.post).mock.calls[0];
      const body = (options as { body: { models: Array<{ capabilities: string[] }> } }).body;
      expect(body.models[0].capabilities).toEqual(expect.arrayContaining(['chat', 'audio']));
    });

    it('toggling the chat checkbox off removes "chat" from the body capabilities', async () => {
      // Drives the chat-checkbox arm where `checked === false`. The
      // editing test above turned embedding ON; this test turns chat
      // OFF, covering the symmetric `next.delete('chat')` branch.
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValueOnce({
        providerSlug: 'openai',
        candidates: [makeCandidate({ modelId: 'gpt-4o-mini' })],
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

      await user.click(
        await screen.findByRole('checkbox', { name: /^chat capability for gpt-4o-mini$/i })
      );
      await user.click(screen.getByRole('button', { name: /add 1 model/i }));

      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalled();
      });
      const [, options] = vi.mocked(apiClient.post).mock.calls[0];
      const body = (options as { body: { models: Array<{ capabilities: string[] }> } }).body;
      expect(body.models[0].capabilities).not.toContain('chat');
    });

    it('navigation: Back from review returns to discovery; Cancel closes the dialog', async () => {
      // Drives the footer button click handlers across steps —
      // previously uncovered because every test only flowed forward.
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValueOnce({
        providerSlug: 'openai',
        candidates: [makeCandidate({ modelId: 'gpt-4o-mini' })],
      });

      const onOpenChange = vi.fn();
      const user = userEvent.setup();
      render(<DiscoverModelsDialog open onOpenChange={onOpenChange} providerSlug="openai" />);

      // Step 2 — pick row, advance to review.
      await waitFor(() => {
        expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
      });
      await user.click(screen.getByRole('checkbox', { name: /select gpt-4o-mini/i }));
      await user.click(screen.getByRole('button', { name: /continue/i }));

      // Step 3 (review) — Back returns to step 2.
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /add 1 model/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /^← back$/i }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^continue/i })).toBeInTheDocument();
      });

      // Cancel on step 2 closes the dialog (calls onOpenChange(false)).
      await user.click(screen.getByRole('button', { name: /^cancel$/i }));
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('"Reset to suggestion" rolls edited fields back to the candidate defaults', async () => {
      // Drives resetReviewRow — the user edits a field, then clicks
      // Reset, then submits; the body should carry the original
      // suggestion, not the discarded edit.
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValueOnce({
        providerSlug: 'openai',
        candidates: [makeCandidate({ modelId: 'gpt-4o-mini' })],
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

      const descField = await screen.findByLabelText(/^description for gpt-4o-mini$/i);
      await user.clear(descField);
      await user.type(descField, 'Edited then reset');

      await user.click(screen.getByRole('button', { name: /reset to suggestion/i }));
      await user.click(screen.getByRole('button', { name: /add 1 model/i }));

      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalled();
      });

      const [, options] = vi.mocked(apiClient.post).mock.calls[0];
      const body = (options as { body: { models: Array<{ description: string }> } }).body;
      // `reviewFromCandidate` (discover-models-dialog.tsx:173-187)
      // initializes `description: ''` — discovery doesn't surface a
      // description per candidate, so Reset returns the field to the
      // empty string regardless of what the operator typed.
      expect(body.models[0].description).toBe('');
    });
  });
});
