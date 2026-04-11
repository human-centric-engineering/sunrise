/**
 * DuplicateAgentDialog Component Tests
 *
 * Test Coverage:
 * - Dialog is closed when source is null
 * - Empty-name submit is blocked
 * - Happy path: GETs source agent, POSTs new agent, calls router.push with new agent id
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

  it('GETs source agent, POSTs new agent, navigates to new agent edit page', async () => {
    // Arrange
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(SOURCE_AGENT);
    vi.mocked(apiClient.post).mockResolvedValue({ id: 'new-agent-id', name: 'Copy' });

    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<DuplicateAgentDialog source={SOURCE_AGENT} onOpenChange={onOpenChange} />);

    // Act: click Duplicate (name and slug are pre-filled)
    await user.click(screen.getByRole('button', { name: /^duplicate$/i }));

    // Assert: GET called for source agent
    await waitFor(() => {
      expect(apiClient.get).toHaveBeenCalledWith(
        expect.stringContaining(`/agents/${SOURCE_AGENT.id}`)
      );
    });

    // Assert: POST called with new name/slug
    expect(apiClient.post).toHaveBeenCalledWith(
      expect.stringContaining('/agents'),
      expect.objectContaining({
        body: expect.objectContaining({
          name: 'Original Agent (copy)',
          slug: 'original-agent-copy',
          isActive: false, // copy starts inactive
        }),
      })
    );

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
    vi.mocked(apiClient.get).mockResolvedValue(SOURCE_AGENT);
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
    expect(mockPush).not.toHaveBeenCalled();
  });
});
