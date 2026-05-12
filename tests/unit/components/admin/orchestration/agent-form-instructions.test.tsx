/**
 * AgentForm — Instructions Tab Tests
 *
 * Test Coverage:
 * - Textarea binding: typing updates form state, PATCH payload includes systemInstructions
 * - Character counter renders and updates live
 * - InstructionsHistoryPanel visible in edit mode, hidden in create mode
 * - Revert-to-version button dispatches POST with versionIndex (mocked via history fetch)
 *
 * @see components/admin/orchestration/agent-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AgentForm } from '@/components/admin/orchestration/agent-form';
import type { AiAgent, AiProviderConfig } from '@/types/prisma';

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

const MOCK_PROVIDERS: AiProviderConfig[] = [
  {
    id: 'prov-1',
    name: 'Anthropic',
    slug: 'anthropic',
    providerType: 'anthropic',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    isActive: true,
    isLocal: false,
    createdBy: 'system',
    createdAt: new Date(),
    updatedAt: new Date(),
    baseUrl: null,
    metadata: {},
  } as AiProviderConfig,
];

const MOCK_MODELS = [{ provider: 'anthropic', id: 'claude-opus-4-6', tier: 'frontier' }];

function makeAgent(overrides: Partial<AiAgent> = {}): AiAgent {
  return {
    id: 'agent-edit-id',
    name: 'Test Agent',
    slug: 'test-agent',
    description: 'A test agent',
    systemInstructions: 'You are a test assistant.',
    provider: 'anthropic',
    providerConfig: null,
    model: 'claude-opus-4-6',
    temperature: 0.7,
    maxTokens: 4096,
    monthlyBudgetUsd: null,
    isActive: true,
    createdBy: 'system',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    systemInstructionsHistory: [],
    metadata: {},
    ...overrides,
  } as AiAgent;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AgentForm — Instructions tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Textarea binding ───────────────────────────────────────────────────────

  describe('textarea binding', () => {
    it('textarea is pre-filled with existing systemInstructions in edit mode', async () => {
      // Arrange
      const agent = makeAgent({ systemInstructions: 'You are a helpful assistant.' });
      render(
        <AgentForm mode="edit" agent={agent} providers={MOCK_PROVIDERS} models={MOCK_MODELS} />
      );

      // Navigate to instructions tab
      const user = userEvent.setup();
      await user.click(screen.getByRole('tab', { name: /instructions/i }));

      // Assert
      const textarea = screen.getByRole('textbox', { name: /system instructions/i });
      expect((textarea as HTMLTextAreaElement).value).toBe('You are a helpful assistant.');
    });

    it('PATCH payload includes updated systemInstructions after typing', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      const agent = makeAgent({ systemInstructions: 'Original instructions.' });
      vi.mocked(apiClient.patch).mockResolvedValue({ ...agent, systemInstructions: 'Updated.' });
      vi.mocked(apiClient.get).mockResolvedValue({
        agentId: 'agent-edit-id',
        slug: 'test-agent',
        current: 'Updated.',
        history: [],
      });

      const user = userEvent.setup();
      render(
        <AgentForm mode="edit" agent={agent} providers={MOCK_PROVIDERS} models={MOCK_MODELS} />
      );

      // Navigate to instructions tab
      await user.click(screen.getByRole('tab', { name: /instructions/i }));

      // Clear and type new instructions
      const textarea = screen.getByRole('textbox', { name: /system instructions/i });
      await user.clear(textarea);
      await user.type(textarea, 'New instructions here.');

      // Submit the form
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      // Assert: PATCH called with systemInstructions
      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          expect.stringContaining('/agents/agent-edit-id'),
          expect.objectContaining({
            body: expect.objectContaining({
              systemInstructions: 'New instructions here.',
            }),
          })
        );
      });
    });
  });

  // ── Character counter ──────────────────────────────────────────────────────

  describe('character counter', () => {
    it('renders a character count next to the textarea', async () => {
      // Arrange
      const agent = makeAgent({ systemInstructions: 'Hello world.' });
      render(
        <AgentForm mode="edit" agent={agent} providers={MOCK_PROVIDERS} models={MOCK_MODELS} />
      );

      const user = userEvent.setup();
      await user.click(screen.getByRole('tab', { name: /instructions/i }));

      // Assert: character count shows initial length
      await waitFor(() => {
        // "Hello world." is 12 chars
        expect(screen.getByText(/12.*characters/i)).toBeInTheDocument();
      });
    });

    it('character counter updates live as user types', async () => {
      // Arrange
      const agent = makeAgent({ systemInstructions: '' });
      const user = userEvent.setup();
      render(
        <AgentForm mode="edit" agent={agent} providers={MOCK_PROVIDERS} models={MOCK_MODELS} />
      );

      await user.click(screen.getByRole('tab', { name: /instructions/i }));

      // Act: type 5 characters
      const textarea = screen.getByRole('textbox', { name: /system instructions/i });
      await user.type(textarea, 'Hello');

      // Assert: counter updated to 5
      await waitFor(() => {
        expect(screen.getByText(/5.*characters/i)).toBeInTheDocument();
      });
    });
  });

  // ── History panel visibility ───────────────────────────────────────────────

  describe('InstructionsHistoryPanel visibility', () => {
    it('renders "Version history" toggle in edit mode', async () => {
      // Arrange
      const agent = makeAgent();
      const user = userEvent.setup();
      render(
        <AgentForm mode="edit" agent={agent} providers={MOCK_PROVIDERS} models={MOCK_MODELS} />
      );

      await user.click(screen.getByRole('tab', { name: /instructions/i }));

      // Assert: history panel is present in edit mode
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /version history/i })).toBeInTheDocument();
      });
    });

    it('does NOT render version history toggle in create mode', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<AgentForm mode="create" providers={MOCK_PROVIDERS} models={MOCK_MODELS} />);

      await user.click(screen.getByRole('tab', { name: /instructions/i }));

      // Assert: no history panel in create mode
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /version history/i })).not.toBeInTheDocument();
      });
    });
  });

  // ── Brand voice, knowledge categories, topic boundaries ─────────────────

  describe('new instructions fields', () => {
    it('renders brand voice instructions textarea', async () => {
      const user = userEvent.setup();
      render(<AgentForm mode="create" providers={MOCK_PROVIDERS} models={MOCK_MODELS} />);
      await user.click(screen.getByRole('tab', { name: /instructions/i }));

      const textarea = screen.getByRole('textbox', { name: /brand voice/i });
      expect(textarea).toBeInTheDocument();
    });

    it('renders the knowledge access section with a Full/Restricted radio', async () => {
      // The legacy comma-separated knowledge-categories input was replaced by the
      // KnowledgeAccessSection component (Phase 4 of knowledge-access-control).
      const user = userEvent.setup();
      render(<AgentForm mode="create" providers={MOCK_PROVIDERS} models={MOCK_MODELS} />);
      await user.click(screen.getByRole('tab', { name: /instructions/i }));

      expect(screen.getByRole('radio', { name: /full access/i })).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: /restricted/i })).toBeInTheDocument();
    });

    it('renders topic boundaries input', async () => {
      const user = userEvent.setup();
      render(<AgentForm mode="create" providers={MOCK_PROVIDERS} models={MOCK_MODELS} />);
      await user.click(screen.getByRole('tab', { name: /instructions/i }));

      const input = screen.getByRole('textbox', { name: /topic boundaries/i });
      expect(input).toBeInTheDocument();
    });
  });

  // ── Revert-to-version ─────────────────────────────────────────────────────

  describe('revert-to-version', () => {
    it('clicking Revert dispatches POST to instructions-revert with versionIndex', async () => {
      // Arrange: history fetch returns one entry
      const { apiClient } = await import('@/lib/api/client');
      const historyPayload = {
        agentId: 'agent-edit-id',
        slug: 'test-agent',
        current: 'Current instructions.',
        history: [
          {
            instructions: 'Old instructions.',
            changedAt: '2025-01-01T00:00:00Z',
            changedBy: 'admin@example.com',
          },
        ],
      };
      vi.mocked(apiClient.get).mockResolvedValue(historyPayload);
      vi.mocked(apiClient.post).mockResolvedValue({ success: true });

      const agent = makeAgent({ systemInstructions: 'Current instructions.' });
      const user = userEvent.setup();
      render(
        <AgentForm mode="edit" agent={agent} providers={MOCK_PROVIDERS} models={MOCK_MODELS} />
      );

      // Navigate to instructions tab
      await user.click(screen.getByRole('tab', { name: /instructions/i }));

      // Expand the history panel
      await user.click(screen.getByRole('button', { name: /version history/i }));

      // Wait for history to load
      await waitFor(() => {
        expect(screen.getByText(/admin@example.com/i)).toBeInTheDocument();
      });

      // Click Revert
      await user.click(screen.getByRole('button', { name: /revert/i }));

      // Confirm the revert alert dialog
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^revert$/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /^revert$/i }));

      // Assert: POST to instructions-revert with { versionIndex: 0 }
      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          expect.stringContaining('/instructions-revert'),
          expect.objectContaining({
            body: expect.objectContaining({ versionIndex: 0 }),
          })
        );
      });
    });
  });
});
