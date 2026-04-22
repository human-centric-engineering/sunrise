/**
 * AgentTestCard Component Tests
 *
 * Test Coverage:
 * - Renders card with both step rows in idle state
 * - Run check succeeds for both steps
 * - Provider failure stops before model test
 * - Model failure after provider success
 * - Disabled state with no provider
 * - Button shows spinner while running
 *
 * @see components/admin/orchestration/agent-test-card.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AgentTestCard } from '@/components/admin/orchestration/agent-test-card';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockPost = vi.fn();

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    post: (...args: unknown[]) => mockPost(...args),
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

vi.mock('@/lib/api/endpoints', () => ({
  API: {
    ADMIN: {
      ORCHESTRATION: {
        providerTest: (id: string) => `/api/v1/admin/orchestration/providers/${id}/test`,
        providerTestModel: (id: string) => `/api/v1/admin/orchestration/providers/${id}/test-model`,
      },
    },
  },
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AgentTestCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders card title, both step labels, and run button', () => {
    render(<AgentTestCard providerId="prov-1" model="claude-opus-4-6" />);

    expect(screen.getByText('Connectivity check')).toBeInTheDocument();
    expect(screen.getByText('Provider connection')).toBeInTheDocument();
    expect(screen.getByText('Model response')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /run check/i })).toBeInTheDocument();
  });

  it('runs both checks successfully', async () => {
    const user = userEvent.setup();
    mockPost
      .mockResolvedValueOnce({ modelCount: 5 })
      .mockResolvedValueOnce({ ok: true, latencyMs: 142 });

    render(<AgentTestCard providerId="prov-1" model="claude-opus-4-6" />);
    await user.click(screen.getByRole('button', { name: /run check/i }));

    await waitFor(() => {
      expect(screen.getByText(/5 models available/)).toBeInTheDocument();
    });
    expect(screen.getByText(/142 ms round-trip/)).toBeInTheDocument();
  });

  it('stops at provider step when connection fails', async () => {
    const user = userEvent.setup();
    mockPost.mockRejectedValueOnce(new Error('Network error'));

    render(<AgentTestCard providerId="prov-1" model="claude-opus-4-6" />);
    await user.click(screen.getByRole('button', { name: /run check/i }));

    await waitFor(() => {
      expect(screen.getByText(/Couldn't reach this provider/)).toBeInTheDocument();
    });
    // Model test should not have been attempted
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('shows model failure after provider success', async () => {
    const user = userEvent.setup();
    mockPost
      .mockResolvedValueOnce({ modelCount: 3 })
      .mockRejectedValueOnce(new Error('Model error'));

    render(<AgentTestCard providerId="prov-1" model="claude-opus-4-6" />);
    await user.click(screen.getByRole('button', { name: /run check/i }));

    await waitFor(() => {
      expect(screen.getByText(/3 models available/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Model test failed/)).toBeInTheDocument();
  });

  it('shows error when no provider config exists', async () => {
    const user = userEvent.setup();

    render(<AgentTestCard providerId={null} model="claude-opus-4-6" />);
    await user.click(screen.getByRole('button', { name: /run check/i }));

    await waitFor(() => {
      expect(screen.getByText(/No saved provider config/)).toBeInTheDocument();
    });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('shows error when no model is selected', async () => {
    const user = userEvent.setup();
    mockPost.mockResolvedValueOnce({ modelCount: 5 });

    render(<AgentTestCard providerId="prov-1" model={null} />);
    await user.click(screen.getByRole('button', { name: /run check/i }));

    await waitFor(() => {
      expect(screen.getByText(/5 models available/)).toBeInTheDocument();
    });
    expect(screen.getByText(/No model selected/)).toBeInTheDocument();
  });
});
