/**
 * SetupWizard — StepIntro (Step 1) Tests
 *
 * StepIntro is an internal component inside setup-wizard.tsx. Tests access
 * it through the parent SetupWizard rendered at step 0 (the default).
 *
 * Test Coverage:
 * - Step 1 renders ChatInterface with agentSlug="pattern-advisor" and embedded prop
 * - Step 1 renders starter prompts passed to ChatInterface
 * - Step 1 renders a "Skip" button
 * - Clicking "Skip" advances the wizard to step 2
 * - "Create this workflow" CTA is hidden initially
 * - CTA appears when onStreamComplete fires with a valid workflow-definition block
 * - CTA does not appear when onStreamComplete fires with text that has no valid block
 * - Clicking "Create this workflow" navigates to /admin/orchestration/workflows/new?definition=...
 *
 * @see components/admin/orchestration/setup-wizard.tsx (StepIntro function)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SetupWizard } from '@/components/admin/orchestration/setup-wizard';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Mock ChatInterface so tests can inspect its props and trigger callbacks
// without needing a real SSE connection.
let capturedOnStreamComplete: ((fullText: string) => void) | undefined;
let capturedAgentSlug: string | undefined;
let capturedEmbedded: boolean | undefined;
let capturedStarterPrompts: string[] | undefined;

vi.mock('@/components/admin/orchestration/chat/chat-interface', () => ({
  ChatInterface: (props: {
    agentSlug: string;
    embedded?: boolean;
    starterPrompts?: string[];
    onStreamComplete?: (fullText: string) => void;
    className?: string;
  }) => {
    // Capture props so tests can inspect them and trigger callbacks
    capturedOnStreamComplete = props.onStreamComplete;
    capturedAgentSlug = props.agentSlug;
    capturedEmbedded = props.embedded;
    capturedStarterPrompts = props.starterPrompts;
    return <div data-testid="chat-interface" data-agent-slug={props.agentSlug} />;
  },
}));

// Mock next/navigation to capture push() calls
const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Fetch mock that always returns empty providers and agents. */
function makeFetchMock() {
  return vi.fn().mockImplementation((url: string) => {
    const u = typeof url === 'string' ? url : '';
    if (u.includes('/providers') || u.includes('/agents')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: [], meta: { total: 0 } }),
      });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

/** A valid workflow-definition fenced code block. */
function makeValidWorkflowText(steps = [{ id: 'step-1', type: 'llm_call' }]) {
  const definition = JSON.stringify({ steps });
  return `Here is a workflow suggestion:\n\n\`\`\`workflow-definition\n${definition}\n\`\`\`\n\nThis should work well.`;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SetupWizard — StepIntro (step 1)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    capturedOnStreamComplete = undefined;
    capturedAgentSlug = undefined;
    capturedEmbedded = undefined;
    capturedStarterPrompts = undefined;
    vi.clearAllMocks();
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  // ── ChatInterface wiring ───────────────────────────────────────────────────

  describe('ChatInterface wiring', () => {
    it('renders the ChatInterface with agentSlug="pattern-advisor"', async () => {
      // Arrange
      vi.stubGlobal('fetch', makeFetchMock());

      // Act
      render(<SetupWizard open={true} onOpenChange={() => {}} />);

      // Assert
      await waitFor(() => {
        expect(screen.getByTestId('chat-interface')).toBeInTheDocument();
      });
      expect(capturedAgentSlug).toBe('pattern-advisor');
    });

    it('renders the ChatInterface with embedded=true', async () => {
      // Arrange
      vi.stubGlobal('fetch', makeFetchMock());

      // Act
      render(<SetupWizard open={true} onOpenChange={() => {}} />);

      // Assert
      await waitFor(() => {
        expect(screen.getByTestId('chat-interface')).toBeInTheDocument();
      });
      // test-review:accept tobe_true — structural prop-wiring assertion: verifies the embedded prop is correctly forwarded as true to ChatInterface
      expect(capturedEmbedded).toBe(true);
    });

    it('passes starter prompts to ChatInterface', async () => {
      // Arrange
      vi.stubGlobal('fetch', makeFetchMock());

      // Act
      render(<SetupWizard open={true} onOpenChange={() => {}} />);

      // Assert: starter prompts are passed (non-empty array)
      await waitFor(() => {
        expect(screen.getByTestId('chat-interface')).toBeInTheDocument();
      });
      // test-review:accept tobe_true — structural array-type guard paired with .length check on next line; not a degenerate "operation succeeded" check
      expect(Array.isArray(capturedStarterPrompts)).toBe(true);
      expect((capturedStarterPrompts ?? []).length).toBeGreaterThan(0);
    });
  });

  // ── Skip button ────────────────────────────────────────────────────────────

  describe('Skip button', () => {
    it('renders a skip button on step 1', async () => {
      // Arrange
      vi.stubGlobal('fetch', makeFetchMock());

      // Act
      render(<SetupWizard open={true} onOpenChange={() => {}} />);

      // Assert
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /skip/i })).toBeInTheDocument();
      });
    });

    it('clicking Skip advances the wizard to step 2', async () => {
      // Arrange
      vi.stubGlobal('fetch', makeFetchMock());
      const user = userEvent.setup();

      render(<SetupWizard open={true} onOpenChange={() => {}} />);

      // Wait for step 1 to be rendered
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /skip/i })).toBeInTheDocument();
      });

      // Act
      await user.click(screen.getByRole('button', { name: /skip/i }));

      // Assert: wizard advances to step 2
      await waitFor(() => {
        expect(screen.getByText(/Step 2 of 5/i)).toBeInTheDocument();
      });
    });
  });

  // ── Workflow CTA ───────────────────────────────────────────────────────────

  describe('"Create this workflow" CTA', () => {
    it('is not visible initially before any stream completes', async () => {
      // Arrange
      vi.stubGlobal('fetch', makeFetchMock());

      // Act
      render(<SetupWizard open={true} onOpenChange={() => {}} />);

      await waitFor(() => {
        expect(screen.getByTestId('chat-interface')).toBeInTheDocument();
      });

      // Assert: CTA is absent
      expect(screen.queryByRole('button', { name: /create this workflow/i })).toBeNull();
    });

    it('appears when onStreamComplete fires with a valid workflow-definition block', async () => {
      // Arrange
      vi.stubGlobal('fetch', makeFetchMock());

      render(<SetupWizard open={true} onOpenChange={() => {}} />);

      await waitFor(() => {
        expect(screen.getByTestId('chat-interface')).toBeInTheDocument();
      });

      // Act: simulate ChatInterface calling onStreamComplete with valid workflow text
      act(() => {
        capturedOnStreamComplete?.(makeValidWorkflowText());
      });

      // Assert: CTA button appears
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /create this workflow/i })).toBeInTheDocument();
      });
    });

    it('does not appear when onStreamComplete fires with text that has no workflow-definition block', async () => {
      // Arrange
      vi.stubGlobal('fetch', makeFetchMock());

      render(<SetupWizard open={true} onOpenChange={() => {}} />);

      await waitFor(() => {
        expect(screen.getByTestId('chat-interface')).toBeInTheDocument();
      });

      // Act: stream completes but with plain text — no workflow block
      act(() => {
        capturedOnStreamComplete?.(
          'You could use a reflection agent pattern for this. Here are some thoughts...'
        );
      });

      // Assert: CTA remains absent
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /create this workflow/i })).toBeNull();
      });
    });

    it('does not appear when onStreamComplete fires with an invalid JSON workflow block', async () => {
      // Arrange
      vi.stubGlobal('fetch', makeFetchMock());

      render(<SetupWizard open={true} onOpenChange={() => {}} />);

      await waitFor(() => {
        expect(screen.getByTestId('chat-interface')).toBeInTheDocument();
      });

      // Act: block present but JSON is malformed
      act(() => {
        capturedOnStreamComplete?.('```workflow-definition\n{broken json here\n```');
      });

      // Assert
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /create this workflow/i })).toBeNull();
      });
    });

    it('does not appear when the workflow block is missing the steps array', async () => {
      // Arrange
      vi.stubGlobal('fetch', makeFetchMock());

      render(<SetupWizard open={true} onOpenChange={() => {}} />);

      await waitFor(() => {
        expect(screen.getByTestId('chat-interface')).toBeInTheDocument();
      });

      // Act: block has valid JSON but no `steps` array
      const noStepsJson = JSON.stringify({ entryStepId: 'step-1', errorStrategy: 'fail' });
      act(() => {
        capturedOnStreamComplete?.(`\`\`\`workflow-definition\n${noStepsJson}\n\`\`\``);
      });

      // Assert
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /create this workflow/i })).toBeNull();
      });
    });

    it('clicking "Create this workflow" pushes to /admin/orchestration/workflows/new with definition param', async () => {
      // Arrange
      vi.stubGlobal('fetch', makeFetchMock());
      const user = userEvent.setup();

      render(<SetupWizard open={true} onOpenChange={() => {}} />);

      await waitFor(() => {
        expect(screen.getByTestId('chat-interface')).toBeInTheDocument();
      });

      // Trigger stream completion with a known definition
      const steps = [{ id: 'step-1', type: 'llm_call' }];
      const definitionJson = JSON.stringify({ steps });
      act(() => {
        capturedOnStreamComplete?.(makeValidWorkflowText(steps));
      });

      // Wait for CTA to appear
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /create this workflow/i })).toBeInTheDocument();
      });

      // Act: click the CTA
      await user.click(screen.getByRole('button', { name: /create this workflow/i }));

      // Assert: router.push called with the expected URL
      expect(mockPush).toHaveBeenCalledOnce();
      const pushedUrl = mockPush.mock.calls[0][0] as string;
      expect(pushedUrl).toContain('/admin/orchestration/workflows/new');
      expect(pushedUrl).toContain('definition=');
      // The definition param is URL-encoded — decode and verify it contains the JSON
      const url = new URL(pushedUrl, 'http://localhost');
      const decodedDefinition = decodeURIComponent(url.searchParams.get('definition') ?? '');
      expect(decodedDefinition).toBe(definitionJson);
    });
  });
});
