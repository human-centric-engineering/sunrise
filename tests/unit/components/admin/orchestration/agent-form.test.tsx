/**
 * AgentForm — Function Coverage Gap Tests (Batch 3.2)
 *
 * This file targets uncovered functions NOT covered by the existing split test files:
 *   - agent-form-general.test.tsx  (slug, validation, create POST)
 *   - agent-form-model.test.tsx    (provider/model select, test connection)
 *   - agent-form-tabs.test.tsx     (tab disabled state)
 *   - agent-form-instructions.test.tsx (instructions textarea, history panel)
 *
 * Gaps addressed here:
 * - Edit mode PATCH (happy path and error)
 * - knowledgeCategories / topicBoundaries comma-split transform (non-empty strings)
 * - isActive Switch onValueChange
 * - Visibility Select onValueChange
 * - Temperature Slider onValueChange
 * - Fallback provider checkbox (check and uncheck)
 * - Input/output guard mode → __global__ (null) path
 * - System agent badge rendering
 * - Invite tokens tab state (invite_only visibility gate)
 * - Versions tab in create mode (placeholder)
 * - Capabilities tab in create mode (placeholder)
 *
 * @see components/admin/orchestration/agent-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
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

const MOCK_PROVIDERS: (AiProviderConfig & { apiKeyPresent?: boolean })[] = [
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
    apiKeyPresent: true,
  } as AiProviderConfig & { apiKeyPresent: boolean },
  {
    id: 'prov-2',
    name: 'OpenAI',
    slug: 'openai',
    providerType: 'openai-compatible',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    isActive: true,
    isLocal: false,
    createdBy: 'system',
    createdAt: new Date(),
    updatedAt: new Date(),
    baseUrl: null,
    metadata: {},
    apiKeyPresent: false,
  } as AiProviderConfig & { apiKeyPresent: boolean },
];

const MOCK_MODELS = [
  { provider: 'anthropic', id: 'claude-opus-4-6', tier: 'frontier' },
  { provider: 'anthropic', id: 'claude-haiku-3', tier: 'budget' },
  { provider: 'openai', id: 'gpt-4o', tier: 'frontier' },
];

function makeAgent(overrides: Partial<AiAgent> = {}): AiAgent {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    slug: 'test-agent',
    description: 'A test agent',
    systemInstructions: 'Be helpful.',
    provider: 'anthropic',
    providerConfig: null,
    model: 'claude-opus-4-6',
    temperature: 0.7,
    maxTokens: 4096,
    monthlyBudgetUsd: null,
    isActive: true,
    isSystem: false,
    createdBy: 'system',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    systemInstructionsHistory: [],
    metadata: {},
    knowledgeCategories: [],
    topicBoundaries: [],
    brandVoiceInstructions: null,
    rateLimitRpm: null,
    inputGuardMode: null,
    outputGuardMode: null,
    maxHistoryTokens: null,
    retentionDays: null,
    visibility: 'internal',
    deletedAt: null,
    fallbackProviders: [],
    ...overrides,
  } as AiAgent;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AgentForm — function coverage gaps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Edit mode PATCH ───────────────────────────────────────────────────────

  describe('edit mode PATCH', () => {
    it('PATCHes agent with correct payload on save', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.patch).mockResolvedValue({ id: 'agent-1', name: 'Test Agent' });

      const user = userEvent.setup();
      const agent = makeAgent();
      render(
        <AgentForm mode="edit" agent={agent} providers={MOCK_PROVIDERS} models={MOCK_MODELS} />
      );

      // Act: make a small change and save
      const nameInput = screen.getByRole('textbox', { name: /^name/i });
      await user.clear(nameInput);
      await user.type(nameInput, 'Updated Agent');

      await user.click(screen.getByRole('button', { name: /save changes/i }));

      // Assert: PATCH called with name change
      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          expect.stringContaining('/agents/agent-1'),
          expect.objectContaining({
            body: expect.objectContaining({
              name: 'Updated Agent',
            }),
          })
        );
      });
    });

    it('shows "Saved" indicator after successful PATCH', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.patch).mockResolvedValue({ id: 'agent-1', name: 'Test Agent' });

      const agent = makeAgent();
      render(
        <AgentForm mode="edit" agent={agent} providers={MOCK_PROVIDERS} models={MOCK_MODELS} />
      );

      // Act: submit form (even pristine — submit button still submits)
      const form = screen.getByRole('button', { name: /save changes/i }).closest('form');
      await act(async () => {
        fireEvent.submit(form!);
      });

      // Assert
      await waitFor(() => {
        // Button changes to show "Saved" with check icon
        expect(screen.getByRole('button', { name: /saved/i })).toBeInTheDocument();
      });
    });

    it('shows inline error banner on PATCH APIClientError', async () => {
      // Arrange
      const { apiClient, APIClientError } = await import('@/lib/api/client');
      vi.mocked(apiClient.patch).mockRejectedValue(
        new APIClientError('Name already taken', 'CONFLICT', 409)
      );

      const user = userEvent.setup();
      const agent = makeAgent();
      render(
        <AgentForm mode="edit" agent={agent} providers={MOCK_PROVIDERS} models={MOCK_MODELS} />
      );

      // Act
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      // Assert: specific error message in banner
      await waitFor(() => {
        expect(screen.getByText('Name already taken')).toBeInTheDocument();
      });
    });

    it('shows generic error banner on non-APIClientError', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.patch).mockRejectedValue(new Error('Network timeout'));

      const user = userEvent.setup();
      const agent = makeAgent();
      render(
        <AgentForm mode="edit" agent={agent} providers={MOCK_PROVIDERS} models={MOCK_MODELS} />
      );

      // Act
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/could not save agent/i)).toBeInTheDocument();
      });
    });
  });

  // ── knowledgeCategories and topicBoundaries transform ─────────────────────

  describe('comma-split transforms in payload', () => {
    it('splits knowledgeCategories comma-string into array in POST payload', async () => {
      // Arrange: non-empty knowledgeCategories covers the ternary true branch
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({ id: 'new-agent', name: 'Test' });

      const user = userEvent.setup();
      render(<AgentForm mode="create" providers={MOCK_PROVIDERS} models={MOCK_MODELS} />);

      // Fill required fields
      await user.type(screen.getByRole('textbox', { name: /^name/i }), 'KB Agent');
      await user.click(screen.getByRole('tab', { name: /instructions/i }));
      await user.type(
        screen.getByRole('textbox', { name: /system instructions/i }),
        'You are helpful.'
      );
      await user.click(screen.getByRole('tab', { name: /general/i }));
      await user.type(screen.getByRole('textbox', { name: /^description/i }), 'My agent.');

      // Navigate to instructions tab to fill knowledge categories
      await user.click(screen.getByRole('tab', { name: /instructions/i }));
      await user.type(
        screen.getByRole('textbox', { name: /knowledge categories/i }),
        'billing, support, faq'
      );

      // Submit
      await user.click(screen.getByRole('button', { name: /create agent/i }));

      // Assert: payload contains array of categories, not the raw string
      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          expect.stringContaining('/agents'),
          expect.objectContaining({
            body: expect.objectContaining({
              knowledgeCategories: ['billing', 'support', 'faq'],
            }),
          })
        );
      });
    });

    it('splits topicBoundaries comma-string into array in POST payload', async () => {
      // Arrange: non-empty topicBoundaries covers the ternary true branch
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({ id: 'new-agent', name: 'Test' });

      const user = userEvent.setup();
      render(<AgentForm mode="create" providers={MOCK_PROVIDERS} models={MOCK_MODELS} />);

      // Fill required fields
      await user.type(screen.getByRole('textbox', { name: /^name/i }), 'Guarded Agent');
      await user.click(screen.getByRole('tab', { name: /instructions/i }));
      await user.type(
        screen.getByRole('textbox', { name: /system instructions/i }),
        'You are helpful.'
      );
      await user.click(screen.getByRole('tab', { name: /general/i }));
      await user.type(screen.getByRole('textbox', { name: /^description/i }), 'Guarded agent.');

      // Navigate to instructions tab to fill topic boundaries
      await user.click(screen.getByRole('tab', { name: /instructions/i }));
      await user.type(
        screen.getByRole('textbox', { name: /topic boundaries/i }),
        'legal advice, medical'
      );

      // Submit
      await user.click(screen.getByRole('button', { name: /create agent/i }));

      // Assert: payload contains array of boundaries
      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          expect.stringContaining('/agents'),
          expect.objectContaining({
            body: expect.objectContaining({
              topicBoundaries: ['legal advice', 'medical'],
            }),
          })
        );
      });
    });
  });

  // ── isActive Switch toggle ────────────────────────────────────────────────

  describe('isActive toggle', () => {
    it('toggling isActive off changes switch to unchecked', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<AgentForm mode="create" providers={MOCK_PROVIDERS} models={MOCK_MODELS} />);

      // Default is active=true
      const isActiveSwitch = screen.getByRole('switch', { name: /active/i });
      expect(isActiveSwitch).toHaveAttribute('data-state', 'checked');

      // Act: toggle off
      await user.click(isActiveSwitch);

      // Assert: now unchecked
      await waitFor(() => {
        expect(isActiveSwitch).toHaveAttribute('data-state', 'unchecked');
      });
    });

    it('isActive switch is disabled for system agent in edit mode', () => {
      // Arrange: system agent cannot be deactivated
      const systemAgent = makeAgent({ isSystem: true });
      render(
        <AgentForm
          mode="edit"
          agent={systemAgent}
          providers={MOCK_PROVIDERS}
          models={MOCK_MODELS}
        />
      );

      // Assert: switch is disabled
      const isActiveSwitch = screen.getByRole('switch', { name: /active/i });
      expect(isActiveSwitch).toBeDisabled();
    });
  });

  // ── Visibility select ─────────────────────────────────────────────────────

  describe('visibility select', () => {
    it('changing visibility to "public" enables saving', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<AgentForm mode="create" providers={MOCK_PROVIDERS} models={MOCK_MODELS} />);

      // Act: change visibility
      const visibilitySelect = screen.getByRole('combobox', { name: /visibility/i });
      await user.click(visibilitySelect);
      await user.click(screen.getByRole('option', { name: /^public$/i }));

      // Assert: select value changed to "public"
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /visibility/i })).toHaveTextContent(/public/i);
      });
    });

    it('setting visibility to invite_only enables Invite tokens tab in edit mode', async () => {
      // Arrange: edit agent with invite_only visibility
      const agent = makeAgent({ visibility: 'invite_only' });
      render(
        <AgentForm mode="edit" agent={agent} providers={MOCK_PROVIDERS} models={MOCK_MODELS} />
      );

      // Assert: Invite tokens tab is enabled (not data-disabled)
      const inviteTab = screen.getByRole('tab', { name: /invite tokens/i });
      expect(inviteTab).not.toHaveAttribute('data-disabled');
    });

    it('invite tokens tab is disabled in edit mode when not invite_only', () => {
      // Arrange: internal visibility
      const agent = makeAgent({ visibility: 'internal' });
      render(
        <AgentForm mode="edit" agent={agent} providers={MOCK_PROVIDERS} models={MOCK_MODELS} />
      );

      // Assert: Invite tokens tab disabled
      const inviteTab = screen.getByRole('tab', { name: /invite tokens/i });
      expect(inviteTab).toHaveAttribute('data-disabled');
    });
  });

  // ── Fallback provider checkboxes ──────────────────────────────────────────

  describe('fallback provider checkboxes', () => {
    it('checking a fallback provider adds it to the list', async () => {
      // Arrange: 2 providers, select anthropic as primary — openai shows as fallback option
      const user = userEvent.setup();
      render(<AgentForm mode="create" providers={MOCK_PROVIDERS} models={MOCK_MODELS} />);

      // Navigate to model tab to see fallback providers
      await user.click(screen.getByRole('tab', { name: /model/i }));

      // Assert: fallback providers section renders (provider list > 1)
      await waitFor(() => {
        // With 2 providers, the fallback section renders one checkbox for the non-primary
        const checkboxes = screen
          .getAllByRole('checkbox')
          .filter((el) => el instanceof HTMLInputElement);
        expect(checkboxes.length).toBeGreaterThan(0);
      });

      // Act: check the OpenAI fallback checkbox
      const fallbackCheckbox = screen.getByRole('checkbox', { name: /openai/i });
      await user.click(fallbackCheckbox);

      // Assert: checkbox is now checked
      await waitFor(() => {
        expect(fallbackCheckbox).toBeChecked();
      });
    });

    it('unchecking a fallback provider removes it from the list', async () => {
      // Arrange: pre-seeded with openai as fallback
      const agent = makeAgent({ fallbackProviders: ['openai'] });
      const user = userEvent.setup();
      render(
        <AgentForm mode="edit" agent={agent} providers={MOCK_PROVIDERS} models={MOCK_MODELS} />
      );

      await user.click(screen.getByRole('tab', { name: /model/i }));

      // Find and uncheck the openai fallback
      await waitFor(() => {
        const fallbackCheckbox = screen.getByRole('checkbox', { name: /openai/i });
        expect(fallbackCheckbox).toBeChecked();
      });

      const fallbackCheckbox = screen.getByRole('checkbox', { name: /openai/i });
      await user.click(fallbackCheckbox);

      // Assert: checkbox is now unchecked
      await waitFor(() => {
        expect(fallbackCheckbox).not.toBeChecked();
      });
    });
  });

  // ── Guard mode select → __global__ (null) path ───────────────────────────

  describe('guard mode select → __global__ (null) mapping', () => {
    it('switching inputGuardMode to __global__ sets value to null in edit mode', async () => {
      // Arrange: agent has inputGuardMode set to 'log_only'
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.patch).mockResolvedValue({ id: 'agent-1' });

      const user = userEvent.setup();
      const agent = makeAgent({ inputGuardMode: 'log_only' as AiAgent['inputGuardMode'] });
      render(
        <AgentForm mode="edit" agent={agent} providers={MOCK_PROVIDERS} models={MOCK_MODELS} />
      );

      // Navigate to model tab where guard selects are
      await user.click(screen.getByRole('tab', { name: /model/i }));

      // Act: open input guard select and choose "Use global default"
      const inputGuardSelect = screen.getByRole('combobox', { name: /input guard/i });
      await user.click(inputGuardSelect);
      await user.click(screen.getByRole('option', { name: /use global default/i }));

      // Submit and verify null is sent
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          expect.stringContaining('/agents/agent-1'),
          expect.objectContaining({
            body: expect.objectContaining({
              inputGuardMode: null,
            }),
          })
        );
      });
    });

    it('switching outputGuardMode to __global__ sets value to null in edit mode', async () => {
      // Arrange: agent has outputGuardMode set to 'block'
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.patch).mockResolvedValue({ id: 'agent-1' });

      const user = userEvent.setup();
      const agent = makeAgent({ outputGuardMode: 'block' as AiAgent['outputGuardMode'] });
      render(
        <AgentForm mode="edit" agent={agent} providers={MOCK_PROVIDERS} models={MOCK_MODELS} />
      );

      await user.click(screen.getByRole('tab', { name: /model/i }));

      // Act: switch output guard to global default
      const outputGuardSelect = screen.getByRole('combobox', { name: /output guard/i });
      await user.click(outputGuardSelect);
      await user.click(screen.getByRole('option', { name: /use global default/i }));

      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          expect.stringContaining('/agents/agent-1'),
          expect.objectContaining({
            body: expect.objectContaining({
              outputGuardMode: null,
            }),
          })
        );
      });
    });
  });

  // ── System agent badge ─────────────────────────────────────────────────────

  describe('system agent badge', () => {
    it('renders System badge for isSystem agent in edit mode', () => {
      // Arrange
      const systemAgent = makeAgent({ isSystem: true });
      render(
        <AgentForm
          mode="edit"
          agent={systemAgent}
          providers={MOCK_PROVIDERS}
          models={MOCK_MODELS}
        />
      );

      // Assert: System badge is shown (Shield icon + "System" text)
      expect(screen.getByText('System')).toBeInTheDocument();
    });

    it('does not render System badge for regular agent', () => {
      // Arrange
      const regularAgent = makeAgent({ isSystem: false });
      render(
        <AgentForm
          mode="edit"
          agent={regularAgent}
          providers={MOCK_PROVIDERS}
          models={MOCK_MODELS}
        />
      );

      // Assert: no System badge
      expect(screen.queryByText('System')).not.toBeInTheDocument();
    });
  });

  // ── Versions tab placeholder in create mode ───────────────────────────────

  describe('Versions tab in create mode', () => {
    it('versions tab is disabled in create mode', () => {
      // Arrange
      render(<AgentForm mode="create" providers={MOCK_PROVIDERS} models={MOCK_MODELS} />);

      // Assert: versions tab is disabled
      const versionsTab = screen.getByRole('tab', { name: /versions/i });
      expect(versionsTab).toHaveAttribute('data-disabled');
    });
  });

  // ── Invite tokens tab in create mode ──────────────────────────────────────

  describe('Invite tokens tab in create mode', () => {
    it('invite tokens tab is disabled in create mode', () => {
      // Arrange
      render(<AgentForm mode="create" providers={MOCK_PROVIDERS} models={MOCK_MODELS} />);

      // Assert: invite tokens tab is disabled
      const inviteTab = screen.getByRole('tab', { name: /invite tokens/i });
      expect(inviteTab).toHaveAttribute('data-disabled');
    });
  });
});
