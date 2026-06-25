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
  useSearchParams: () => ({ get: () => null }),
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

  // ── Profile inheritance UI ────────────────────────────────────────────────
  // Covers the Persona / Guardrails fields, the "Append to profile"
  // checkbox per inheritable field, and the EffectivePromptPreview
  // subcomponent — all added with the agent-profile feature.

  const MOCK_PROFILE = {
    id: 'prof-support',
    name: 'Support Family',
    slug: 'support-family',
    persona: 'You are a calm senior support specialist.',
    brandVoiceInstructions: 'Friendly and concise.',
    guardrails: 'Never give medical advice.',
  };

  describe('profile inheritance', () => {
    it('renders Persona and Guardrails textareas on the Instructions tab', async () => {
      const user = userEvent.setup();
      render(
        <AgentForm
          mode="edit"
          agent={makeAgent()}
          providers={MOCK_PROVIDERS}
          models={MOCK_MODELS}
          profiles={[MOCK_PROFILE]}
        />
      );
      await user.click(screen.getByRole('tab', { name: /instructions/i }));

      expect(screen.getByRole('textbox', { name: /^persona/i })).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: /^guardrails/i })).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: /^brand voice/i })).toBeInTheDocument();
    });

    it('shows an "Inheriting from profile X" hint when a profile is attached and the agent field is blank', async () => {
      const user = userEvent.setup();
      render(
        <AgentForm
          mode="edit"
          agent={makeAgent({ profileId: 'prof-support' })}
          providers={MOCK_PROVIDERS}
          models={MOCK_MODELS}
          profiles={[MOCK_PROFILE]}
        />
      );
      await user.click(screen.getByRole('tab', { name: /instructions/i }));

      // The hint uses smart quotes (&ldquo;…&rdquo;), so match by substring
      // around the profile name instead.
      const hints = screen.getAllByText((_, el) =>
        Boolean(
          el?.textContent?.includes('Inheriting from profile') &&
          el.textContent.includes('Support Family')
        )
      );
      // Three inheritable fields → three hints when all are blank.
      expect(hints.length).toBeGreaterThanOrEqual(3);
    });

    it('omits the "Append to profile" checkbox when no profile is attached', async () => {
      const user = userEvent.setup();
      render(
        <AgentForm
          mode="edit"
          agent={makeAgent({ persona: 'Agent persona.' })}
          providers={MOCK_PROVIDERS}
          models={MOCK_MODELS}
        />
      );
      await user.click(screen.getByRole('tab', { name: /instructions/i }));

      expect(
        screen.queryByRole('checkbox', { name: /append persona to profile/i })
      ).not.toBeInTheDocument();
    });

    it('shows the Append checkbox when both a profile and agent text are present', async () => {
      const user = userEvent.setup();
      render(
        <AgentForm
          mode="edit"
          agent={makeAgent({
            profileId: 'prof-support',
            persona: 'Also: based in London.',
            guardrails: 'Also: never quote internal pricing.',
            brandVoiceInstructions: 'Greet returning users by name.',
          })}
          providers={MOCK_PROVIDERS}
          models={MOCK_MODELS}
          profiles={[MOCK_PROFILE]}
        />
      );
      await user.click(screen.getByRole('tab', { name: /instructions/i }));

      // All three append toggles render — one per inheritable field.
      expect(document.getElementById('personaAppend')).toBeInTheDocument();
      expect(document.getElementById('guardrailsAppend')).toBeInTheDocument();
      expect(document.getElementById('voiceAppend')).toBeInTheDocument();
    });

    it('toggling the persona Append checkbox flips personaMode to "append" and submits it', async () => {
      const { apiClient } = await import('@/lib/api/client');
      const user = userEvent.setup();
      const agent = makeAgent({
        profileId: 'prof-support',
        persona: 'Also based in London.',
        personaMode: 'override',
      });
      vi.mocked(apiClient.patch).mockResolvedValue({ ...agent });

      render(
        <AgentForm
          mode="edit"
          agent={agent}
          providers={MOCK_PROVIDERS}
          models={MOCK_MODELS}
          profiles={[MOCK_PROFILE]}
        />
      );
      await user.click(screen.getByRole('tab', { name: /instructions/i }));

      const checkbox = document.getElementById('personaAppend') as HTMLInputElement;
      expect(checkbox).toBeInTheDocument();
      await user.click(checkbox);

      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          expect.stringContaining('/agents/agent-edit-id'),
          expect.objectContaining({
            body: expect.objectContaining({ personaMode: 'append' }),
          })
        );
      });
    });

    it('Effective prompt preview renders the merged system message with per-section source badges', async () => {
      const user = userEvent.setup();
      render(
        <AgentForm
          mode="edit"
          agent={makeAgent({
            profileId: 'prof-support',
            systemInstructions: 'Help with billing.',
            persona: null,
            guardrails: 'Also never quote internal pricing.',
            guardrailsMode: 'append',
            brandVoiceInstructions: null,
          })}
          providers={MOCK_PROVIDERS}
          models={MOCK_MODELS}
          profiles={[MOCK_PROFILE]}
        />
      );
      await user.click(screen.getByRole('tab', { name: /instructions/i }));

      // Expand the <details> preview.
      const summary = screen.getByText(/effective prompt preview/i);
      await user.click(summary);

      // Persona inherited → "from profile" badge for that section
      // (smart-quote-safe substring match).
      expect(
        screen.getAllByText((_, el) =>
          Boolean(
            el?.textContent?.includes('from profile') && el.textContent.includes('Support Family')
          )
        ).length
      ).toBeGreaterThan(0);
      // Guardrails appended → "profile + agent additions" badge.
      expect(screen.getByText(/profile \+ agent additions/i)).toBeInTheDocument();
      // Composed output contains both the profile persona and the appended
      // guardrails. The persona substring also appears in the textarea
      // placeholder ("Profile says: …"), so accept any number of matches.
      expect(
        screen.getAllByText((_, el) =>
          (el?.textContent ?? '').includes('You are a calm senior support specialist.')
        ).length
      ).toBeGreaterThan(0);
      expect(
        screen.getAllByText((_, el) =>
          (el?.textContent ?? '').includes('Also never quote internal pricing.')
        ).length
      ).toBeGreaterThan(0);
    });
  });

  // ── Profile selector (General tab) ────────────────────────────────────────

  describe('profile selector on General tab', () => {
    it('renders the profile dropdown trigger when profiles are provided', () => {
      render(
        <AgentForm
          mode="edit"
          agent={makeAgent()}
          providers={MOCK_PROVIDERS}
          models={MOCK_MODELS}
          profiles={[MOCK_PROFILE]}
        />
      );

      // Radix Select renders a <button id="profileId"> trigger — the label
      // is associated via htmlFor. Query by the trigger id directly.
      expect(document.getElementById('profileId')).toBeInTheDocument();
      // The label text is rendered above the trigger.
      expect(screen.getByText(/inherit from profile/i)).toBeInTheDocument();
    });

    it('omits the profile dropdown when no profiles are provided', () => {
      render(
        <AgentForm
          mode="edit"
          agent={makeAgent()}
          providers={MOCK_PROVIDERS}
          models={MOCK_MODELS}
        />
      );
      expect(document.getElementById('profileId')).not.toBeInTheDocument();
    });

    it('omits the profile dropdown when an empty profile list is provided', () => {
      render(
        <AgentForm
          mode="edit"
          agent={makeAgent()}
          providers={MOCK_PROVIDERS}
          models={MOCK_MODELS}
          profiles={[]}
        />
      );
      expect(document.getElementById('profileId')).not.toBeInTheDocument();
    });
  });

  // ── Runtime-built prompt honesty flag (issue #304) ───────────────────────────

  describe('runtime-built prompt flag', () => {
    async function gotoInstructions() {
      const user = userEvent.setup();
      await user.click(screen.getByRole('tab', { name: /instructions/i }));
      return user;
    }

    it('defaults off: no callout, and the preview reads "what the LLM actually sees"', async () => {
      render(
        <AgentForm
          mode="edit"
          agent={makeAgent({ runtimePromptManaged: false })}
          providers={MOCK_PROVIDERS}
          models={MOCK_MODELS}
        />
      );
      await gotoInstructions();

      expect(screen.getByText(/what the LLM actually sees/i)).toBeInTheDocument();
      expect(screen.queryByText(/NOT what the LLM sees/i)).not.toBeInTheDocument();
      // The warning callout copy is absent when the flag is off.
      expect(screen.queryByText(/prompt is built in application code/i)).not.toBeInTheDocument();
    });

    it('checking the box reveals the callout and re-labels the preview', async () => {
      render(
        <AgentForm
          mode="edit"
          agent={makeAgent({ runtimePromptManaged: false })}
          providers={MOCK_PROVIDERS}
          models={MOCK_MODELS}
        />
      );
      const user = await gotoInstructions();

      await user.click(screen.getByRole('checkbox', { name: /prompt is built at runtime/i }));

      expect(screen.getByText(/prompt is built in application code/i)).toBeInTheDocument();
      expect(screen.getByText(/NOT what the LLM sees/i)).toBeInTheDocument();
      // The plain "what the LLM actually sees" label is gone once re-labelled.
      expect(screen.queryByText(/^— what the LLM actually sees$/i)).not.toBeInTheDocument();
    });

    it('pre-fills the checkbox and note from the agent in edit mode', async () => {
      render(
        <AgentForm
          mode="edit"
          agent={makeAgent({
            runtimePromptManaged: true,
            runtimePromptNote: 'Built in extractor-capability.ts',
          })}
          providers={MOCK_PROVIDERS}
          models={MOCK_MODELS}
        />
      );
      await gotoInstructions();

      expect(screen.getByRole('checkbox', { name: /prompt is built at runtime/i })).toBeChecked();
      expect(screen.getByPlaceholderText(/where is the real prompt built/i)).toHaveValue(
        'Built in extractor-capability.ts'
      );
      // The callout shows immediately since the agent arrives with the flag set.
      expect(screen.getByText(/prompt is built in application code/i)).toBeInTheDocument();
    });

    it('PATCH payload carries runtimePromptManaged + runtimePromptNote after toggling', async () => {
      const { apiClient } = await import('@/lib/api/client');
      const agent = makeAgent({ runtimePromptManaged: false, runtimePromptNote: null });
      vi.mocked(apiClient.patch).mockResolvedValue(agent);

      render(
        <AgentForm mode="edit" agent={agent} providers={MOCK_PROVIDERS} models={MOCK_MODELS} />
      );
      const user = await gotoInstructions();

      await user.click(screen.getByRole('checkbox', { name: /prompt is built at runtime/i }));
      await user.type(
        screen.getByPlaceholderText(/where is the real prompt built/i),
        'see refiner.ts'
      );
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          expect.stringContaining('/agents/agent-edit-id'),
          expect.objectContaining({
            body: expect.objectContaining({
              runtimePromptManaged: true,
              runtimePromptNote: 'see refiner.ts',
            }),
          })
        );
      });
    });

    it('clears a populated note (and hides the callout) when the flag is unticked', async () => {
      const { apiClient } = await import('@/lib/api/client');
      const agent = makeAgent({
        runtimePromptManaged: true,
        runtimePromptNote: 'Built in extractor-capability.ts',
      });
      vi.mocked(apiClient.patch).mockResolvedValue(agent);

      render(
        <AgentForm mode="edit" agent={agent} providers={MOCK_PROVIDERS} models={MOCK_MODELS} />
      );
      const user = await gotoInstructions();

      // Untick while the note still has content. The checkbox handler must null
      // the note so a stale value isn't persisted against an agent that no
      // longer claims a runtime-built prompt — and the callout / note field
      // disappear and the preview label reverts.
      await user.click(screen.getByRole('checkbox', { name: /prompt is built at runtime/i }));

      expect(screen.queryByText(/prompt is built in application code/i)).not.toBeInTheDocument();
      expect(
        screen.queryByPlaceholderText(/where is the real prompt built/i)
      ).not.toBeInTheDocument();
      expect(screen.getByText(/what the LLM actually sees/i)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          expect.stringContaining('/agents/agent-edit-id'),
          expect.objectContaining({
            body: expect.objectContaining({
              runtimePromptManaged: false,
              runtimePromptNote: null,
            }),
          })
        );
      });
    });

    it('normalises an emptied note to null on save (setValueAs)', async () => {
      const { apiClient } = await import('@/lib/api/client');
      const agent = makeAgent({
        runtimePromptManaged: true,
        runtimePromptNote: 'Built in extractor-capability.ts',
      });
      vi.mocked(apiClient.patch).mockResolvedValue(agent);

      render(
        <AgentForm mode="edit" agent={agent} providers={MOCK_PROVIDERS} models={MOCK_MODELS} />
      );
      const user = await gotoInstructions();

      // Emptying the textarea must persist as null, not "" (the register
      // setValueAs `v === '' ? null : v` branch), matching sibling fields.
      await user.clear(screen.getByPlaceholderText(/where is the real prompt built/i));
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          expect.stringContaining('/agents/agent-edit-id'),
          expect.objectContaining({
            body: expect.objectContaining({ runtimePromptNote: null }),
          })
        );
      });
    });

    it('shows a validation error and blocks submit when the note exceeds 2,000 chars', async () => {
      const { apiClient } = await import('@/lib/api/client');
      const agent = makeAgent({ runtimePromptManaged: true, runtimePromptNote: null });
      vi.mocked(apiClient.patch).mockResolvedValue(agent);

      render(
        <AgentForm mode="edit" agent={agent} providers={MOCK_PROVIDERS} models={MOCK_MODELS} />
      );
      const user = await gotoInstructions();

      // paste (not type) the over-long value so the test stays fast.
      const note = screen.getByPlaceholderText(/where is the real prompt built/i);
      await user.click(note);
      await user.paste('x'.repeat(2001));
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      // The note's error paragraph renders (the errors.runtimePromptNote branch)
      // and the invalid submit never reaches the API.
      await waitFor(() => {
        expect(screen.getByText(/2000/)).toBeInTheDocument();
      });
      expect(apiClient.patch).not.toHaveBeenCalled();
    });
  });
});
