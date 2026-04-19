/**
 * AgentForm — General Tab Tests
 *
 * Test Coverage:
 * - Slug auto-populates from name in create mode until user edits slug
 * - Slug becomes user-editable after user types in it directly
 * - Required-field validation blocks submit
 * - Happy path POSTs to /agents with correct { body: { ... } } shape
 *
 * @see components/admin/orchestration/agent-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AgentForm } from '@/components/admin/orchestration/agent-form';

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

const MOCK_PROVIDERS = [
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
    timeoutMs: null,
    maxRetries: null,
  },
];

const MOCK_MODELS = [
  { provider: 'anthropic', id: 'claude-opus-4-6', tier: 'frontier' },
  { provider: 'anthropic', id: 'claude-haiku-3', tier: 'budget' },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AgentForm — General tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Slug auto-generation ───────────────────────────────────────────────────

  describe('slug auto-generation (create mode)', () => {
    it('slug auto-populates from name on first type', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<AgentForm mode="create" providers={MOCK_PROVIDERS} models={MOCK_MODELS} />);

      // Act: type a name
      await user.type(screen.getByRole('textbox', { name: /^name/i }), 'My Research Bot');

      // Assert: slug is auto-generated
      const slugInput = screen.getByRole('textbox', { name: /^slug/i });
      await waitFor(() => {
        expect((slugInput as HTMLInputElement).value).toBe('my-research-bot');
      });
    });

    it('slug uses lowercase, replaces spaces with hyphens', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<AgentForm mode="create" providers={MOCK_PROVIDERS} models={MOCK_MODELS} />);

      // Act
      await user.type(screen.getByRole('textbox', { name: /^name/i }), 'Hello World Agent!');

      // Assert
      const slugInput = screen.getByRole('textbox', { name: /^slug/i });
      await waitFor(() => {
        const val = (slugInput as HTMLInputElement).value;
        expect(val).toMatch(/^[a-z0-9-]+$/);
        expect(val).toContain('hello');
        expect(val).toContain('world');
      });
    });

    it('slug becomes user-editable after typing in slug field directly', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<AgentForm mode="create" providers={MOCK_PROVIDERS} models={MOCK_MODELS} />);

      // First type a name so slug auto-generates
      await user.type(screen.getByRole('textbox', { name: /^name/i }), 'Some Name');

      // Act: user manually edits slug
      const slugInput = screen.getByRole('textbox', { name: /^slug/i });
      await user.clear(slugInput);
      await user.type(slugInput, 'my-custom-slug');

      // Assert: further name changes do NOT override the user's slug
      await user.type(screen.getByRole('textbox', { name: /^name/i }), ' Extra');

      await waitFor(() => {
        expect((slugInput as HTMLInputElement).value).toBe('my-custom-slug');
      });
    });

    it('slug is disabled in edit mode (cannot be changed after creation)', () => {
      // Arrange
      const mockAgent = {
        id: 'agent-1',
        name: 'Existing Agent',
        slug: 'existing-agent',
        description: 'A test agent',
        systemInstructions: 'Be helpful',
        provider: 'anthropic',
        providerConfig: null,
        model: 'claude-opus-4-6',
        temperature: 0.7,
        maxTokens: 4096,
        monthlyBudgetUsd: null,
        isActive: true,
        isSystem: false,
        createdBy: 'system',
        createdAt: new Date(),
        updatedAt: new Date(),
        systemInstructionsHistory: [],
        metadata: {},
        knowledgeCategories: [],
        topicBoundaries: [],
        brandVoiceInstructions: null,
        visibility: 'internal',
        deletedAt: null,
        fallbackProviders: [],
      };

      // Act
      render(
        <AgentForm mode="edit" agent={mockAgent} providers={MOCK_PROVIDERS} models={MOCK_MODELS} />
      );

      // Assert
      const slugInput = screen.getByRole('textbox', { name: /^slug/i });
      expect(slugInput).toBeDisabled();
    });
  });

  // ── Validation ─────────────────────────────────────────────────────────────

  describe('required field validation', () => {
    it('blocks submit with empty name, shows error', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      const user = userEvent.setup();
      render(<AgentForm mode="create" providers={MOCK_PROVIDERS} models={MOCK_MODELS} />);

      // Act: submit without filling in name/description/instructions
      await user.click(screen.getByRole('button', { name: /create agent/i }));

      // Assert: validation errors shown, no POST
      await waitFor(() => {
        expect(screen.getByText(/name is required/i)).toBeInTheDocument();
      });
      expect(apiClient.post).not.toHaveBeenCalled();
    });

    it('blocks submit with empty description', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      const user = userEvent.setup();
      render(<AgentForm mode="create" providers={MOCK_PROVIDERS} models={MOCK_MODELS} />);

      // Fill name but not description
      await user.type(screen.getByRole('textbox', { name: /^name/i }), 'Test Agent');

      // Act
      await user.click(screen.getByRole('button', { name: /create agent/i }));

      // Assert: description error, no POST
      await waitFor(() => {
        expect(screen.getByText(/description is required/i)).toBeInTheDocument();
      });
      expect(apiClient.post).not.toHaveBeenCalled();
    });
  });

  // ── Happy path POST ────────────────────────────────────────────────────────

  describe('happy path create', () => {
    it('POSTs to /agents with correct body shape on valid submit', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({
        id: 'new-agent-id',
        name: 'Research Bot',
        slug: 'research-bot',
      });

      const user = userEvent.setup();
      render(<AgentForm mode="create" providers={MOCK_PROVIDERS} models={MOCK_MODELS} />);

      // Act: fill all required fields and submit
      await user.type(screen.getByRole('textbox', { name: /^name/i }), 'Research Bot');

      // Navigate to Instructions tab to fill systemInstructions
      await user.click(screen.getByRole('tab', { name: /instructions/i }));
      await user.type(
        screen.getByRole('textbox', { name: /system instructions/i }),
        'You are a helpful research assistant.'
      );

      // Navigate back to General to fill description
      await user.click(screen.getByRole('tab', { name: /general/i }));
      await user.type(
        screen.getByRole('textbox', { name: /^description/i }),
        'Summarizes research papers.'
      );

      await user.click(screen.getByRole('button', { name: /create agent/i }));

      // Assert: POST called with body wrapper
      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          expect.stringContaining('/agents'),
          expect.objectContaining({
            body: expect.objectContaining({
              name: 'Research Bot',
              description: 'Summarizes research papers.',
              systemInstructions: 'You are a helpful research assistant.',
            }),
          })
        );
      });
    });

    it('navigates to new agent edit page after successful create', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({
        id: 'new-agent-id',
        name: 'Research Bot',
        slug: 'research-bot',
      });

      const user = userEvent.setup();
      render(<AgentForm mode="create" providers={MOCK_PROVIDERS} models={MOCK_MODELS} />);

      // Fill all required fields
      await user.type(screen.getByRole('textbox', { name: /^name/i }), 'Research Bot');
      await user.click(screen.getByRole('tab', { name: /instructions/i }));
      await user.type(screen.getByRole('textbox', { name: /system instructions/i }), 'Be helpful.');
      await user.click(screen.getByRole('tab', { name: /general/i }));
      await user.type(screen.getByRole('textbox', { name: /^description/i }), 'My agent.');

      await user.click(screen.getByRole('button', { name: /create agent/i }));

      // Assert
      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith(expect.stringContaining('/agents/new-agent-id'));
      });
    });
  });
});
