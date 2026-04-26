/**
 * Unit Test: ExperimentsList
 *
 * Key behaviours:
 * - Shows loading state on initial mount
 * - Fetch error → displays error message
 * - Empty experiment list → shows "No experiments found."
 * - Renders experiment rows (name, status badge, variant count)
 * - Draft experiment → "Run" button visible
 * - Running/completed experiment → "Run" button not visible
 * - "Run" button click → calls apiClient.post for run, refetches list
 * - "Delete" button click → calls apiClient.delete, removes from local state
 * - "New Experiment" button shows create form
 * - Create form: submit button disabled until name filled
 * - Create form: "Add variant" button increments variant count
 * - Create form: remove button not shown at 2 variants (min)
 * - Create form: "Add variant" hidden at 5 variants (max)
 *
 * @see components/admin/orchestration/experiments/experiments-list.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExperimentsList } from '@/components/admin/orchestration/experiments/experiments-list';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPatch = vi.fn();
const mockDelete = vi.fn();

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
    patch: (...args: unknown[]) => mockPatch(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
  APIClientError: class APIClientError extends Error {
    constructor(
      message: string,
      public code = 'INTERNAL_ERROR',
      public status = 500
    ) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

// ─── Fixtures ────────────────────────────────────────────────────────────────

const AGENT = { id: 'agent-1', name: 'Support Bot', slug: 'support-bot' };

function makeExperiment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'exp-1',
    name: 'Formal vs Casual',
    description: null,
    status: 'draft',
    agentId: AGENT.id,
    agent: AGENT,
    variants: [
      { id: 'v1', label: 'Variant A', score: null },
      { id: 'v2', label: 'Variant B', score: null },
    ],
    creator: { id: 'user-1', name: 'Admin' },
    createdAt: '2025-01-15T00:00:00.000Z',
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ExperimentsList', () => {
  beforeEach(() => {
    vi.resetAllMocks(); // resetAllMocks clears once queues too, preventing bleed between tests
    // Default: experiments list returns empty, agents list returns empty
    mockGet.mockResolvedValue([]);
  });

  describe('Loading state', () => {
    it('shows "Loading experiments..." on initial mount', () => {
      // Never resolves — keeps loading state visible
      mockGet.mockReturnValue(new Promise(() => {}));

      render(<ExperimentsList />);

      expect(screen.getByText('Loading experiments...')).toBeInTheDocument();
    });
  });

  describe('Error state', () => {
    it('displays an error message when fetch fails with generic error', async () => {
      mockGet.mockRejectedValue(new Error('Network error'));

      render(<ExperimentsList />);

      await waitFor(() => {
        expect(screen.getByText('Failed to load experiments')).toBeInTheDocument();
      });
    });

    it('displays APIClientError message when fetch fails with APIClientError', async () => {
      const { APIClientError } = await import('@/lib/api/client');
      mockGet.mockRejectedValue(new APIClientError('Unauthorized'));

      render(<ExperimentsList />);

      await waitFor(() => {
        expect(screen.getByText('Unauthorized')).toBeInTheDocument();
      });
    });
  });

  describe('Empty state', () => {
    it('shows "No experiments found." when list is empty', async () => {
      mockGet.mockResolvedValue([]);

      render(<ExperimentsList />);

      await waitFor(() => {
        expect(screen.getByText('No experiments found.')).toBeInTheDocument();
      });
    });
  });

  describe('Experiment table rows', () => {
    it('renders experiment name and agent', async () => {
      mockGet.mockResolvedValue([makeExperiment()]);

      render(<ExperimentsList />);

      await waitFor(() => {
        expect(screen.getByText('Formal vs Casual')).toBeInTheDocument();
        expect(screen.getByText('Support Bot')).toBeInTheDocument();
      });
    });

    it('renders status badge', async () => {
      mockGet.mockResolvedValue([makeExperiment({ status: 'draft' })]);

      render(<ExperimentsList />);

      await waitFor(() => {
        expect(screen.getByText('draft')).toBeInTheDocument();
      });
    });

    it('renders variant count', async () => {
      mockGet.mockResolvedValue([makeExperiment()]);

      render(<ExperimentsList />);

      // Variant count cell: 2 variants
      await waitFor(() => {
        expect(screen.getByText('2')).toBeInTheDocument();
      });
    });

    it('renders description when present', async () => {
      mockGet.mockResolvedValue([makeExperiment({ description: 'Testing tone' })]);

      render(<ExperimentsList />);

      await waitFor(() => {
        expect(screen.getByText('Testing tone')).toBeInTheDocument();
      });
    });

    it('shows variant scores for completed experiments', async () => {
      mockGet.mockResolvedValue([
        makeExperiment({
          status: 'completed',
          variants: [
            { id: 'v1', label: 'Variant A', score: 0.85 },
            { id: 'v2', label: 'Variant B', score: 0.72 },
          ],
        }),
      ]);

      render(<ExperimentsList />);

      await waitFor(() => {
        expect(screen.getByText(/0\.85/)).toBeInTheDocument();
        expect(screen.getByText(/0\.72/)).toBeInTheDocument();
      });
    });

    it('shows "N/A" for null variant scores in completed experiments', async () => {
      mockGet.mockResolvedValue([
        makeExperiment({
          status: 'completed',
          variants: [
            { id: 'v1', label: 'Variant A', score: null },
            { id: 'v2', label: 'Variant B', score: null },
          ],
        }),
      ]);

      render(<ExperimentsList />);

      await waitFor(() => {
        const naLabels = screen.getAllByText('N/A');
        expect(naLabels.length).toBeGreaterThanOrEqual(2);
      });
    });

    it('uses secondary badge variant for unknown experiment status', async () => {
      mockGet.mockResolvedValue([makeExperiment({ status: 'archived' })]);

      render(<ExperimentsList />);

      await waitFor(() => {
        expect(screen.getByText('archived')).toBeInTheDocument();
      });
    });
  });

  describe('Run button visibility', () => {
    it('shows "Run" button for draft experiment', async () => {
      mockGet.mockResolvedValue([makeExperiment({ status: 'draft' })]);

      render(<ExperimentsList />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /run/i })).toBeInTheDocument();
      });
    });

    it('does not show "Run" button for running experiment', async () => {
      mockGet.mockResolvedValue([makeExperiment({ status: 'running' })]);

      render(<ExperimentsList />);

      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /run/i })).not.toBeInTheDocument();
      });
    });

    it('does not show "Run" button for completed experiment', async () => {
      mockGet.mockResolvedValue([makeExperiment({ status: 'completed' })]);

      render(<ExperimentsList />);

      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /run/i })).not.toBeInTheDocument();
      });
    });
  });

  describe('Run action', () => {
    it('calls apiClient.post with run endpoint and refetches experiments', async () => {
      const user = userEvent.setup();
      const exp = makeExperiment({ status: 'draft' });
      mockGet.mockResolvedValue([exp]);
      mockPost.mockResolvedValue(undefined);

      render(<ExperimentsList />);

      await waitFor(() => screen.getByRole('button', { name: /run/i }));
      await user.click(screen.getByRole('button', { name: /run/i }));

      await waitFor(() => {
        expect(mockPost).toHaveBeenCalledWith('/api/v1/admin/orchestration/experiments/exp-1/run');
      });
      // fetchExperiments called twice: initial mount + after run
      expect(mockGet).toHaveBeenCalledTimes(2);
    });

    it('shows error message when run fails with generic error', async () => {
      const user = userEvent.setup();
      mockGet.mockResolvedValue([makeExperiment({ status: 'draft' })]);
      mockPost.mockRejectedValue(new Error('Run failed'));

      render(<ExperimentsList />);

      await waitFor(() => screen.getByRole('button', { name: /run/i }));
      await user.click(screen.getByRole('button', { name: /run/i }));

      await waitFor(() => {
        expect(screen.getByText('Failed to start experiment')).toBeInTheDocument();
      });
    });

    it('shows APIClientError message when run fails with APIClientError', async () => {
      const { APIClientError } = await import('@/lib/api/client');
      const user = userEvent.setup();
      mockGet.mockResolvedValue([makeExperiment({ status: 'draft' })]);
      mockPost.mockRejectedValue(new APIClientError('Experiment already running'));

      render(<ExperimentsList />);

      await waitFor(() => screen.getByRole('button', { name: /run/i }));
      await user.click(screen.getByRole('button', { name: /run/i }));

      await waitFor(() => {
        expect(screen.getByText('Experiment already running')).toBeInTheDocument();
      });
    });
  });

  describe('Complete action', () => {
    it('shows "Complete" button for running experiment', async () => {
      mockGet.mockResolvedValue([makeExperiment({ status: 'running' })]);

      render(<ExperimentsList />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /complete/i })).toBeInTheDocument();
      });
    });

    it('does not show "Complete" button for draft experiment', async () => {
      mockGet.mockResolvedValue([makeExperiment({ status: 'draft' })]);

      render(<ExperimentsList />);

      await waitFor(() => screen.getByText('Formal vs Casual'));
      expect(screen.queryByRole('button', { name: /complete/i })).not.toBeInTheDocument();
    });

    it('calls apiClient.patch with status completed and refetches', async () => {
      const user = userEvent.setup();
      mockGet.mockResolvedValue([makeExperiment({ status: 'running' })]);
      mockPatch.mockResolvedValue(undefined);

      render(<ExperimentsList />);

      await waitFor(() => screen.getByRole('button', { name: /complete/i }));
      await user.click(screen.getByRole('button', { name: /complete/i }));

      await waitFor(() => {
        expect(mockPatch).toHaveBeenCalledWith(
          '/api/v1/admin/orchestration/experiments/exp-1',
          expect.objectContaining({ body: { status: 'completed' } })
        );
      });
      // fetchExperiments called twice: initial mount + after complete
      expect(mockGet).toHaveBeenCalledTimes(2);
    });

    it('shows error message when complete fails', async () => {
      const user = userEvent.setup();
      mockGet.mockResolvedValue([makeExperiment({ status: 'running' })]);
      mockPatch.mockRejectedValue(new Error('Complete failed'));

      render(<ExperimentsList />);

      await waitFor(() => screen.getByRole('button', { name: /complete/i }));
      await user.click(screen.getByRole('button', { name: /complete/i }));

      await waitFor(() => {
        expect(screen.getByText('Failed to complete experiment')).toBeInTheDocument();
      });
    });
  });

  describe('Delete action', () => {
    it('opens confirmation dialog, then calls apiClient.delete on confirm', async () => {
      const user = userEvent.setup();
      mockGet.mockResolvedValue([makeExperiment()]);
      mockDelete.mockResolvedValue(undefined);

      render(<ExperimentsList />);

      await waitFor(() => screen.getByText('Formal vs Casual'));

      // Click the delete button (now has aria-label)
      await user.click(screen.getByRole('button', { name: /delete experiment/i }));

      // Confirmation dialog should appear
      await waitFor(() => {
        expect(screen.getByText(/are you sure you want to delete/i)).toBeInTheDocument();
      });

      // Confirm the delete
      await user.click(screen.getByRole('button', { name: /^delete$/i }));

      await waitFor(() => {
        expect(mockDelete).toHaveBeenCalledWith('/api/v1/admin/orchestration/experiments/exp-1');
      });
      // Row removed from local state
      await waitFor(() => {
        expect(screen.getByText('No experiments found.')).toBeInTheDocument();
      });
    });

    it('does not delete when confirmation is cancelled', async () => {
      const user = userEvent.setup();
      mockGet.mockResolvedValue([makeExperiment()]);

      render(<ExperimentsList />);

      await waitFor(() => screen.getByText('Formal vs Casual'));
      await user.click(screen.getByRole('button', { name: /delete experiment/i }));

      await waitFor(() => {
        expect(screen.getByText(/are you sure you want to delete/i)).toBeInTheDocument();
      });

      // Cancel the delete
      await user.click(screen.getByRole('button', { name: /cancel/i }));

      expect(mockDelete).not.toHaveBeenCalled();
      expect(screen.getByText('Formal vs Casual')).toBeInTheDocument();
    });

    it('shows error message when delete fails with generic error', async () => {
      const user = userEvent.setup();
      mockGet.mockResolvedValue([makeExperiment()]);
      mockDelete.mockRejectedValue(new Error('Delete failed'));

      render(<ExperimentsList />);

      await waitFor(() => screen.getByText('Formal vs Casual'));
      await user.click(screen.getByRole('button', { name: /delete experiment/i }));
      await waitFor(() => screen.getByText(/are you sure/i));
      await user.click(screen.getByRole('button', { name: /^delete$/i }));

      await waitFor(() => {
        expect(screen.getByText('Failed to delete experiment')).toBeInTheDocument();
      });
    });

    it('shows APIClientError message when delete fails with APIClientError', async () => {
      const { APIClientError } = await import('@/lib/api/client');
      const user = userEvent.setup();
      mockGet.mockResolvedValue([makeExperiment()]);
      mockDelete.mockRejectedValue(new APIClientError('Forbidden'));

      render(<ExperimentsList />);

      await waitFor(() => screen.getByText('Formal vs Casual'));
      await user.click(screen.getByRole('button', { name: /delete experiment/i }));
      await waitFor(() => screen.getByText(/are you sure/i));
      await user.click(screen.getByRole('button', { name: /^delete$/i }));

      await waitFor(() => {
        expect(screen.getByText('Forbidden')).toBeInTheDocument();
      });
    });
  });

  describe('Agents loading in create form', () => {
    it('shows "Loading agents..." while agents are being fetched', async () => {
      const user = userEvent.setup();
      // First call: experiments (resolve immediately), second call: agents (never resolves)
      mockGet
        .mockResolvedValueOnce([]) // experiments
        .mockReturnValueOnce(new Promise(() => {})); // agents — never resolves

      render(<ExperimentsList />);

      await waitFor(() => screen.getByRole('button', { name: /new experiment/i }));
      await user.click(screen.getByRole('button', { name: /new experiment/i }));

      await waitFor(() => {
        expect(screen.getByText('Loading agents...')).toBeInTheDocument();
      });
    });

    it('shows "No agents found" message when agent list is empty', async () => {
      const user = userEvent.setup();
      mockGet
        .mockResolvedValueOnce([]) // experiments
        .mockResolvedValueOnce([]); // agents

      render(<ExperimentsList />);

      await waitFor(() => screen.getByRole('button', { name: /new experiment/i }));
      await user.click(screen.getByRole('button', { name: /new experiment/i }));

      await waitFor(() => {
        expect(screen.getByText(/no agents found/i)).toBeInTheDocument();
      });
    });

    it('shows "Failed to load agents" when agents fetch throws (catch path)', async () => {
      const user = userEvent.setup();
      mockGet
        .mockResolvedValueOnce([]) // experiments
        .mockRejectedValueOnce(new Error('Agents unavailable')); // agents fetch throws

      render(<ExperimentsList />);

      await waitFor(() => screen.getByRole('button', { name: /new experiment/i }));
      await user.click(screen.getByRole('button', { name: /new experiment/i }));

      await waitFor(() => {
        expect(screen.getByText(/failed to load agents/i)).toBeInTheDocument();
      });
    });

    it('populates agent select when agents are available', async () => {
      const user = userEvent.setup();
      mockGet
        .mockResolvedValueOnce([]) // experiments
        .mockResolvedValueOnce([{ id: 'agent-1', name: 'Support Bot', slug: 'support-bot' }]); // agents

      render(<ExperimentsList />);

      await waitFor(() => screen.getByRole('button', { name: /new experiment/i }));
      await user.click(screen.getByRole('button', { name: /new experiment/i }));

      await waitFor(() => {
        expect(screen.getByText('Support Bot')).toBeInTheDocument();
      });
    });
  });

  describe('Create form submit', () => {
    it('submit button is disabled when name is filled but no agent selected', async () => {
      const user = userEvent.setup();
      mockGet
        .mockResolvedValueOnce([]) // experiments initial
        .mockResolvedValueOnce([{ id: 'agent-1', name: 'Support Bot', slug: 'support-bot' }]); // agents in form
      mockPost.mockResolvedValue(undefined);

      render(<ExperimentsList />);

      await waitFor(() => screen.getByRole('button', { name: /new experiment/i }));
      await user.click(screen.getByRole('button', { name: /new experiment/i }));

      // Wait for agents to load and fill the name
      await waitFor(() => screen.getByPlaceholderText(/e\.g\. Formal vs casual tone/i));
      await user.type(
        screen.getByPlaceholderText(/e\.g\. Formal vs casual tone/i),
        'Test Experiment'
      );

      // Submit button still disabled until agentId is selected
      const submitButton = screen.getByRole('button', { name: /create experiment/i });
      expect(submitButton).toBeDisabled();
    });

    it('calls apiClient.post and hides form on successful create', async () => {
      const user = userEvent.setup();
      mockGet
        .mockResolvedValueOnce([]) // experiments initial
        .mockResolvedValueOnce([{ id: 'agent-1', name: 'Support Bot', slug: 'support-bot' }]) // agents in form
        .mockResolvedValueOnce([]); // experiments refetch after create
      mockPost.mockResolvedValue(undefined);

      render(<ExperimentsList />);

      await waitFor(() => screen.getByRole('button', { name: /new experiment/i }));
      await user.click(screen.getByRole('button', { name: /new experiment/i }));

      // Wait for agents to load
      await waitFor(() => screen.getByText('Support Bot'));

      // Fill the experiment name
      await user.type(
        screen.getByPlaceholderText(/e\.g\. Formal vs casual tone/i),
        'Test Experiment'
      );

      // Select the agent via Radix Select (click trigger → click item in portal)
      const selectTrigger = screen.getByRole('combobox');
      await user.click(selectTrigger);

      // After clicking trigger, SelectContent renders in the portal
      const agentOption = await screen.findByRole('option', { name: 'Support Bot' });
      await user.click(agentOption);

      // Now submit button is enabled — click it
      const submitButton = screen.getByRole('button', { name: /create experiment/i });
      await waitFor(() => expect(submitButton).not.toBeDisabled());
      await user.click(submitButton);

      await waitFor(() => {
        expect(mockPost).toHaveBeenCalledWith(
          '/api/v1/admin/orchestration/experiments',
          expect.objectContaining({ body: expect.objectContaining({ name: 'Test Experiment' }) })
        );
      });

      // Form hides after successful create (onCreated callback fires)
      await waitFor(() => {
        expect(
          screen.queryByRole('button', { name: /create experiment/i })
        ).not.toBeInTheDocument();
      });
    });

    it('shows error message when create fails with generic error', async () => {
      const user = userEvent.setup();
      mockGet
        .mockResolvedValueOnce([]) // experiments
        .mockResolvedValueOnce([{ id: 'agent-1', name: 'Support Bot', slug: 'support-bot' }]); // agents
      mockPost.mockRejectedValue(new Error('Create failed'));

      render(<ExperimentsList />);

      await waitFor(() => screen.getByRole('button', { name: /new experiment/i }));
      await user.click(screen.getByRole('button', { name: /new experiment/i }));

      // Wait for agent to appear, fill name, select agent
      await waitFor(() => screen.getByText('Support Bot'));
      await user.type(screen.getByPlaceholderText(/e\.g\. Formal vs casual tone/i), 'My Exp');

      const selectTrigger = screen.getByRole('combobox');
      await user.click(selectTrigger);
      const agentOption = await screen.findByRole('option', { name: 'Support Bot' });
      await user.click(agentOption);

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /create experiment/i })).not.toBeDisabled()
      );
      await user.click(screen.getByRole('button', { name: /create experiment/i }));

      await waitFor(() => {
        expect(screen.getByText('Failed to create experiment')).toBeInTheDocument();
      });
    });

    it('shows APIClientError message when create fails with APIClientError', async () => {
      const { APIClientError } = await import('@/lib/api/client');
      const user = userEvent.setup();
      mockGet
        .mockResolvedValueOnce([]) // experiments
        .mockResolvedValueOnce([{ id: 'agent-1', name: 'Support Bot', slug: 'support-bot' }]); // agents
      mockPost.mockRejectedValue(new APIClientError('Variant count too low'));

      render(<ExperimentsList />);

      await waitFor(() => screen.getByRole('button', { name: /new experiment/i }));
      await user.click(screen.getByRole('button', { name: /new experiment/i }));

      await waitFor(() => screen.getByText('Support Bot'));
      await user.type(screen.getByPlaceholderText(/e\.g\. Formal vs casual tone/i), 'Test');

      const selectTrigger = screen.getByRole('combobox');
      await user.click(selectTrigger);
      const agentOption = await screen.findByRole('option', { name: 'Support Bot' });
      await user.click(agentOption);

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /create experiment/i })).not.toBeDisabled()
      );
      await user.click(screen.getByRole('button', { name: /create experiment/i }));

      await waitFor(() => {
        expect(screen.getByText('Variant count too low')).toBeInTheDocument();
      });
    });

    it('updates variant label when typed in variant input', async () => {
      const user = userEvent.setup();
      mockGet.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      render(<ExperimentsList />);

      await waitFor(() => screen.getByRole('button', { name: /new experiment/i }));
      await user.click(screen.getByRole('button', { name: /new experiment/i }));

      await waitFor(() => screen.getAllByPlaceholderText(/variant \d+ label/i));
      const variantInputs = screen.getAllByPlaceholderText(/variant \d+ label/i);

      // Clear and retype the first variant label
      await user.clear(variantInputs[0]);
      await user.type(variantInputs[0], 'Control Group');

      expect(variantInputs[0]).toHaveValue('Control Group');
    });

    it('remove variant button shown when > 2 variants exist', async () => {
      const user = userEvent.setup();
      mockGet.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      render(<ExperimentsList />);

      await waitFor(() => screen.getByRole('button', { name: /new experiment/i }));
      await user.click(screen.getByRole('button', { name: /new experiment/i }));

      await waitFor(() => screen.getByRole('button', { name: /add variant/i }));
      await user.click(screen.getByRole('button', { name: /add variant/i }));

      // Now 3 variants — X buttons should appear
      await waitFor(() => {
        const inputs = screen.getAllByPlaceholderText(/variant \d+ label/i);
        expect(inputs).toHaveLength(3);
      });

      // After adding a variant, the remove (X) buttons should be visible
      // Find buttons with X icon (variant.length > 2 condition now met)
      const allButtons = screen.getAllByRole('button');
      // There should be ghost/icon buttons for X (one per variant since length > 2)
      const formButtons = allButtons.filter((b) => b.getAttribute('type') === 'button');
      // Add Variant + Cancel + 3 X buttons (one per variant)
      expect(formButtons.length).toBeGreaterThan(2);
    });
  });

  describe('Create form', () => {
    it('shows create form when "New Experiment" button is clicked', async () => {
      const user = userEvent.setup();
      render(<ExperimentsList />);

      await waitFor(() => screen.getByRole('button', { name: /new experiment/i }));
      await user.click(screen.getByRole('button', { name: /new experiment/i }));

      expect(screen.getByText('New Experiment')).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/e\.g\. Formal vs casual tone/i)).toBeInTheDocument();
    });

    it('submit button is disabled when name is empty', async () => {
      const user = userEvent.setup();
      render(<ExperimentsList />);

      await waitFor(() => screen.getByRole('button', { name: /new experiment/i }));
      await user.click(screen.getByRole('button', { name: /new experiment/i }));

      const submitButton = screen.getByRole('button', { name: /create experiment/i });
      expect(submitButton).toBeDisabled();
    });

    it('starts with 2 variants in the create form', async () => {
      const user = userEvent.setup();
      // agents endpoint returns empty
      mockGet.mockResolvedValue([]);

      render(<ExperimentsList />);

      await waitFor(() => screen.getByRole('button', { name: /new experiment/i }));
      await user.click(screen.getByRole('button', { name: /new experiment/i }));

      // Should have 2 variant inputs by placeholder text
      const variantInputs = screen.getAllByPlaceholderText(/variant \d+ label/i);
      expect(variantInputs).toHaveLength(2);
    });

    it('"Add variant" button increments variant count', async () => {
      const user = userEvent.setup();
      mockGet.mockResolvedValue([]);

      render(<ExperimentsList />);

      await waitFor(() => screen.getByRole('button', { name: /new experiment/i }));
      await user.click(screen.getByRole('button', { name: /new experiment/i }));

      // Wait for agents to load
      await waitFor(() => screen.getByRole('button', { name: /add variant/i }));
      await user.click(screen.getByRole('button', { name: /add variant/i }));

      const variantInputs = screen.getAllByPlaceholderText(/variant \d+ label/i);
      expect(variantInputs).toHaveLength(3);
    });

    it('remove variant button not shown at minimum 2 variants', async () => {
      const user = userEvent.setup();
      mockGet.mockResolvedValue([]);

      render(<ExperimentsList />);

      await waitFor(() => screen.getByRole('button', { name: /new experiment/i }));
      await user.click(screen.getByRole('button', { name: /new experiment/i }));

      await waitFor(() => screen.getAllByPlaceholderText(/variant \d+ label/i));

      // With only 2 variants, there should be no X (remove) buttons
      // The X buttons appear only when variants.length > 2
      const variantInputs = screen.getAllByPlaceholderText(/variant \d+ label/i);
      expect(variantInputs).toHaveLength(2);
      // No X remove buttons visible when at minimum
      const xButtons = document.querySelectorAll('button[type="button"] svg.lucide-x');
      expect(xButtons).toHaveLength(0);
    });

    it('"Add variant" hidden when at maximum 5 variants', async () => {
      const user = userEvent.setup();
      mockGet.mockResolvedValue([]);

      render(<ExperimentsList />);

      await waitFor(() => screen.getByRole('button', { name: /new experiment/i }));
      await user.click(screen.getByRole('button', { name: /new experiment/i }));

      await waitFor(() => screen.getByRole('button', { name: /add variant/i }));

      // Add 3 more to reach 5
      for (let i = 0; i < 3; i++) {
        await user.click(screen.getByRole('button', { name: /add variant/i }));
      }

      expect(screen.queryByRole('button', { name: /add variant/i })).not.toBeInTheDocument();
    });

    it('hides create form when "Cancel" is clicked', async () => {
      const user = userEvent.setup();
      mockGet.mockResolvedValue([]);

      render(<ExperimentsList />);

      await waitFor(() => screen.getByRole('button', { name: /new experiment/i }));
      await user.click(screen.getByRole('button', { name: /new experiment/i }));

      expect(screen.getByRole('button', { name: /create experiment/i })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /cancel/i }));

      expect(screen.queryByRole('button', { name: /create experiment/i })).not.toBeInTheDocument();
    });
  });
});
