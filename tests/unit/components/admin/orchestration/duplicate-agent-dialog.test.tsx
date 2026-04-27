/**
 * DuplicateAgentDialog Component Tests
 *
 * Test Coverage:
 * - Dialog is closed when source is null
 * - Empty-name submit is blocked
 * - Happy path: POSTs to clone endpoint, calls router.push with new agent id
 * - Verifies clone endpoint URL includes source agent id
 *
 * @see components/admin/orchestration/duplicate-agent-dialog.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DuplicateAgentDialog } from '@/components/admin/orchestration/duplicate-agent-dialog';
import type { AiAgent } from '@prisma/client';

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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<AiAgent> = {}): AiAgent {
  return {
    id: 'source-agent-id',
    name: 'Original Agent',
    slug: 'original-agent',
    description: 'Does great things',
    systemInstructions: 'Be helpful always.',
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    temperature: 0.7,
    maxTokens: 4096,
    monthlyBudgetUsd: null,
    isActive: true,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    systemInstructionsHistory: [],
    metadata: {},
    deletedAt: null,
    ...overrides,
  } as AiAgent;
}

const SOURCE_AGENT = makeAgent();

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DuplicateAgentDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Closed state ──────────────────────────────────────────────────────────

  it('does not render dialog content when source is null', () => {
    // Arrange & Act
    render(<DuplicateAgentDialog source={null} onOpenChange={vi.fn()} />);

    // Assert: dialog body not visible
    expect(screen.queryByText(/duplicate agent/i)).not.toBeInTheDocument();
  });

  // ── Open state ────────────────────────────────────────────────────────────

  it('renders dialog with pre-populated name and slug', () => {
    // Arrange & Act
    render(<DuplicateAgentDialog source={SOURCE_AGENT} onOpenChange={vi.fn()} />);

    // Assert: name input has "Original Agent (copy)"
    const nameInput = screen.getByRole('textbox', { name: /new name/i });
    expect((nameInput as HTMLInputElement).value).toBe('Original Agent (copy)');

    const slugInput = screen.getByRole('textbox', { name: /new slug/i });
    expect((slugInput as HTMLInputElement).value).toBe('original-agent-copy');
  });

  // ── Validation ────────────────────────────────────────────────────────────

  it('Duplicate button is disabled when name is cleared', async () => {
    // Arrange
    const user = userEvent.setup();
    render(<DuplicateAgentDialog source={SOURCE_AGENT} onOpenChange={vi.fn()} />);

    // Act: clear the name input
    const nameInput = screen.getByRole('textbox', { name: /new name/i });
    await user.clear(nameInput);

    // Assert: Duplicate button disabled
    const dupBtn = screen.getByRole('button', { name: /^duplicate$/i });
    expect(dupBtn).toBeDisabled();
  });

  it('Duplicate button is disabled when slug is cleared', async () => {
    // Arrange
    const user = userEvent.setup();
    render(<DuplicateAgentDialog source={SOURCE_AGENT} onOpenChange={vi.fn()} />);

    // Act: clear the slug input
    const slugInput = screen.getByRole('textbox', { name: /new slug/i });
    await user.clear(slugInput);

    // Assert: Duplicate button disabled
    const dupBtn = screen.getByRole('button', { name: /^duplicate$/i });
    expect(dupBtn).toBeDisabled();
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it('POSTs to clone endpoint with name and slug, navigates to new agent', async () => {
    // Arrange
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockResolvedValue({ id: 'new-agent-id', name: 'Copy' });

    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<DuplicateAgentDialog source={SOURCE_AGENT} onOpenChange={onOpenChange} />);

    // Act: click Duplicate (name and slug are pre-filled)
    await user.click(screen.getByRole('button', { name: /^duplicate$/i }));

    // Assert: POST called to clone endpoint (not generic /agents)
    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith(
        expect.stringContaining(`/agents/${SOURCE_AGENT.id}/clone`),
        expect.objectContaining({
          body: { name: 'Original Agent (copy)', slug: 'original-agent-copy' },
        })
      );
    });

    // Assert: no GET call — clone endpoint handles everything server-side
    expect(apiClient.get).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;

    // Assert: router push to new agent's edit page
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith(expect.stringContaining('/agents/new-agent-id'));
    });

    // Assert: dialog closed
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows error when POST fails', async () => {
    // Arrange
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Slug already exists', 'CONFLICT', 409)
    );

    const user = userEvent.setup();
    render(<DuplicateAgentDialog source={SOURCE_AGENT} onOpenChange={vi.fn()} />);

    // Act
    await user.click(screen.getByRole('button', { name: /^duplicate$/i }));

    // Assert: error message shown
    await waitFor(() => {
      expect(screen.getByText(/slug already exists/i)).toBeInTheDocument();
    });

    // Assert: router was NOT called
    expect(mockPush).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
  });
});
