/**
 * EvaluationForm Component Tests
 *
 * Test Coverage:
 * - Renders agent dropdown with provided agents
 * - Renders title and description fields
 * - Title validation: submit with empty title shows error
 * - Agent validation: submit without selecting agent shows error
 * - Successful submit calls apiClient.post with correct payload
 * - Successful submit redirects to /admin/orchestration/evaluations/{id}
 * - Failed submit shows error message
 * - Create Evaluation button is present
 *
 * @see components/admin/orchestration/evaluation-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
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

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { EvaluationForm } from '@/components/admin/orchestration/evaluation-form';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_AGENTS = [
  { id: 'agent-1', name: 'Bot Alpha' },
  { id: 'agent-2', name: 'Bot Beta' },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EvaluationForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Rendering ──────────────────────────────────────────────────────────────

  describe('rendering', () => {
    it('renders the agent dropdown', () => {
      // Arrange & Act
      render(<EvaluationForm agents={MOCK_AGENTS} />);

      // Assert: agent select trigger is present
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    it('renders the title input field', () => {
      // Arrange & Act
      render(<EvaluationForm agents={MOCK_AGENTS} />);

      // Assert
      expect(screen.getByRole('textbox', { name: /title/i })).toBeInTheDocument();
    });

    it('renders the description textarea field', () => {
      // Arrange & Act
      render(<EvaluationForm agents={MOCK_AGENTS} />);

      // Assert
      expect(screen.getByRole('textbox', { name: /description/i })).toBeInTheDocument();
    });

    it('renders the Create Evaluation button', () => {
      // Arrange & Act
      render(<EvaluationForm agents={MOCK_AGENTS} />);

      // Assert
      expect(screen.getByRole('button', { name: /create evaluation/i })).toBeInTheDocument();
    });

    it('renders agent options in the dropdown', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<EvaluationForm agents={MOCK_AGENTS} />);

      // Act: open the select dropdown
      await user.click(screen.getByRole('combobox'));

      // Assert: agent names appear as options
      await waitFor(() => {
        expect(screen.getByRole('option', { name: /bot alpha/i })).toBeInTheDocument();
        expect(screen.getByRole('option', { name: /bot beta/i })).toBeInTheDocument();
      });
    });
  });

  // ── Validation ─────────────────────────────────────────────────────────────

  describe('validation', () => {
    it('shows error when submitting without a title', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      const user = userEvent.setup();
      render(<EvaluationForm agents={MOCK_AGENTS} />);

      // Act: submit without filling title
      await user.click(screen.getByRole('button', { name: /create evaluation/i }));

      // Assert: validation error shown, no POST
      await waitFor(() => {
        expect(screen.getByText(/title is required/i)).toBeInTheDocument();
      });
      expect(apiClient.post).not.toHaveBeenCalled();
    });

    it('shows error when submitting without selecting an agent', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      const user = userEvent.setup();
      render(<EvaluationForm agents={MOCK_AGENTS} />);

      // Act: fill title but not agent, then submit
      await user.type(screen.getByRole('textbox', { name: /title/i }), 'My Eval');
      await user.click(screen.getByRole('button', { name: /create evaluation/i }));

      // Assert: agent validation error shown
      await waitFor(() => {
        expect(screen.getByText(/agent is required/i)).toBeInTheDocument();
      });
      expect(apiClient.post).not.toHaveBeenCalled();
    });
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  describe('happy path create', () => {
    it('calls apiClient.post with correct payload on valid submit', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({ id: 'new-eval-id' });

      const user = userEvent.setup();
      render(<EvaluationForm agents={MOCK_AGENTS} />);

      // Act: select agent
      await user.click(screen.getByRole('combobox'));
      await user.click(await screen.findByRole('option', { name: /bot alpha/i }));

      // Fill title
      await user.type(screen.getByRole('textbox', { name: /title/i }), 'Tone Check');

      // Submit
      await user.click(screen.getByRole('button', { name: /create evaluation/i }));

      // Assert: POST called with correct body
      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          expect.stringContaining('/evaluations'),
          expect.objectContaining({
            body: expect.objectContaining({
              agentId: 'agent-1',
              title: 'Tone Check',
            }),
          })
        );
      });
    });

    it('redirects to /admin/orchestration/evaluations/{id} after successful create', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({ id: 'new-eval-id' });

      const user = userEvent.setup();
      render(<EvaluationForm agents={MOCK_AGENTS} />);

      // Act: fill form and submit
      await user.click(screen.getByRole('combobox'));
      await user.click(await screen.findByRole('option', { name: /bot alpha/i }));
      await user.type(screen.getByRole('textbox', { name: /title/i }), 'Tone Check');
      await user.click(screen.getByRole('button', { name: /create evaluation/i }));

      // Assert: redirect to eval detail page
      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith(expect.stringContaining('/evaluations/new-eval-id'));
      });
    });
  });

  // ── Error handling ─────────────────────────────────────────────────────────

  describe('error handling', () => {
    it('shows error message when apiClient.post fails with APIClientError', async () => {
      // Arrange
      const { apiClient, APIClientError } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockRejectedValue(
        new APIClientError('Evaluation creation failed', 'INTERNAL_ERROR', 500)
      );

      const user = userEvent.setup();
      render(<EvaluationForm agents={MOCK_AGENTS} />);

      // Act: fill form and submit
      await user.click(screen.getByRole('combobox'));
      await user.click(await screen.findByRole('option', { name: /bot alpha/i }));
      await user.type(screen.getByRole('textbox', { name: /title/i }), 'Tone Check');
      await user.click(screen.getByRole('button', { name: /create evaluation/i }));

      // Assert: error message visible
      await waitFor(() => {
        expect(screen.getByText(/evaluation creation failed/i)).toBeInTheDocument();
      });
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('shows generic error message when an unexpected error occurs', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockRejectedValue(new Error('Unexpected network failure'));

      const user = userEvent.setup();
      render(<EvaluationForm agents={MOCK_AGENTS} />);

      // Act
      await user.click(screen.getByRole('combobox'));
      await user.click(await screen.findByRole('option', { name: /bot alpha/i }));
      await user.type(screen.getByRole('textbox', { name: /title/i }), 'Tone Check');
      await user.click(screen.getByRole('button', { name: /create evaluation/i }));

      // Assert: fallback error message visible
      await waitFor(() => {
        expect(screen.getByText(/failed to create evaluation/i)).toBeInTheDocument();
      });
    });
  });
});
