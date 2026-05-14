/**
 * LearningTabs — Advisor Tab Integration Tests
 *
 * Tests the workflow recommendation detection and "Create this workflow"
 * button navigation flow.
 *
 * @see components/admin/orchestration/learn/learning-tabs.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { LearningTabs } from '@/components/admin/orchestration/learn/learning-tabs';
import type { PatternSummary } from '@/types/orchestration';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const pushMock = vi.fn();

// `useSearchParams` returns `?tab=advisor` so the Advisor tab renders
// on initial mount — these tests target the advisor content's
// behaviour (workflow recommendation, navigation) rather than
// tab-switching itself.
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: pushMock,
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
  useSearchParams: vi.fn(() => new URLSearchParams('tab=advisor')),
  usePathname: vi.fn(() => '/admin/orchestration/learn'),
}));

// Capture the onStreamComplete and onConversationCleared props so we
// can invoke them manually from the test body.
let capturedOnStreamComplete: ((text: string) => void) | undefined;
let capturedOnConversationCleared: (() => void) | undefined;
let capturedOnResampleStarters: (() => void) | undefined;
let capturedSuggestionPool: readonly string[] | undefined;

vi.mock('@/components/admin/orchestration/chat/chat-interface', () => ({
  ChatInterface: (props: {
    agentSlug: string;
    starterPrompts?: string[];
    suggestionPool?: readonly string[];
    onStreamComplete?: (text: string) => void;
    onConversationCleared?: () => void;
    onResampleStarters?: () => void;
  }) => {
    capturedOnStreamComplete = props.onStreamComplete;
    capturedOnConversationCleared = props.onConversationCleared;
    capturedOnResampleStarters = props.onResampleStarters;
    capturedSuggestionPool = props.suggestionPool;
    return (
      <div data-testid="chat-interface" data-agent={props.agentSlug}>
        {props.starterPrompts?.map((p) => (
          <span key={p} data-testid="advisor-starter">
            {p}
          </span>
        ))}
      </div>
    );
  },
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_PATTERNS: PatternSummary[] = [
  {
    patternNumber: 1,
    patternName: 'Chain of Thought',
    description: 'Step-by-step reasoning.',
    chunkCount: 5,
  },
];

const WORKFLOW_TEXT = `Here's a workflow for you:

\`\`\`workflow-definition
{"steps":[{"id":"s1","type":"llm_call","label":"Analyze","config":{},"nextSteps":[]}],"entryStepId":"s1","errorStrategy":"fail"}
\`\`\`

Let me know if you'd like to adjust it.`;

const INVALID_WORKFLOW_TEXT = `Here's something:

\`\`\`workflow-definition
not valid json
\`\`\`
`;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('LearningTabs — Advisor workflow integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnStreamComplete = undefined;
  });

  it('passes pattern-advisor slug to ChatInterface', async () => {
    const user = userEvent.setup();
    render(<LearningTabs patterns={MOCK_PATTERNS} />);

    await user.click(screen.getByRole('tab', { name: /advisor/i }));

    expect(screen.getByTestId('chat-interface')).toHaveAttribute('data-agent', 'pattern-advisor');
  });

  it('shows "Create this workflow" button when advisor recommends a workflow', async () => {
    const user = userEvent.setup();
    render(<LearningTabs patterns={MOCK_PATTERNS} />);

    await user.click(screen.getByRole('tab', { name: /advisor/i }));

    expect(screen.queryByText(/create this workflow/i)).not.toBeInTheDocument();

    // Simulate advisor completing a stream with a workflow-definition block
    act(() => {
      capturedOnStreamComplete?.(WORKFLOW_TEXT);
    });

    expect(screen.getByRole('button', { name: /create this workflow/i })).toBeInTheDocument();
  });

  it('navigates to workflow builder with definition when button is clicked', async () => {
    const user = userEvent.setup();
    render(<LearningTabs patterns={MOCK_PATTERNS} />);

    await user.click(screen.getByRole('tab', { name: /advisor/i }));

    act(() => {
      capturedOnStreamComplete?.(WORKFLOW_TEXT);
    });

    await user.click(screen.getByRole('button', { name: /create this workflow/i }));

    expect(pushMock).toHaveBeenCalledOnce();
    const url = pushMock.mock.calls[0][0] as string;
    expect(url).toContain('/admin/orchestration/workflows/new?definition=');

    // Verify the encoded definition decodes to valid JSON
    const encoded = url.split('?definition=')[1];
    const decoded = JSON.parse(decodeURIComponent(encoded)) as Record<string, unknown>;
    expect(decoded.entryStepId).toBe('s1');
    expect(decoded.steps).toHaveLength(1);
  });

  it('does not show button when workflow-definition block is invalid JSON', async () => {
    const user = userEvent.setup();
    render(<LearningTabs patterns={MOCK_PATTERNS} />);

    await user.click(screen.getByRole('tab', { name: /advisor/i }));

    act(() => {
      capturedOnStreamComplete?.(INVALID_WORKFLOW_TEXT);
    });

    expect(screen.queryByText(/create this workflow/i)).not.toBeInTheDocument();
  });

  it('does not show button when text has no workflow-definition block', async () => {
    const user = userEvent.setup();
    render(<LearningTabs patterns={MOCK_PATTERNS} />);

    await user.click(screen.getByRole('tab', { name: /advisor/i }));

    act(() => {
      capturedOnStreamComplete?.('Just a regular response with no workflow.');
    });

    expect(screen.queryByText(/create this workflow/i)).not.toBeInTheDocument();
  });

  describe('advisor starter prompts and suggestion pool', () => {
    it('renders exactly 5 starter prompts on the advisor tab', async () => {
      const user = userEvent.setup();
      render(<LearningTabs patterns={MOCK_PATTERNS} />);
      await user.click(screen.getByRole('tab', { name: /advisor/i }));
      expect(screen.getAllByTestId('advisor-starter')).toHaveLength(5);
    });

    it('passes the full pattern-tagged pool through as suggestionPool', async () => {
      const user = userEvent.setup();
      render(<LearningTabs patterns={MOCK_PATTERNS} />);
      await user.click(screen.getByRole('tab', { name: /advisor/i }));
      // ≥64 prompts is the contract — the pool tests pin the exact
      // floor; here we just confirm the wiring delivers the array.
      expect(capturedSuggestionPool).toBeDefined();
      expect((capturedSuggestionPool ?? []).length).toBeGreaterThanOrEqual(64);
    });

    it('re-rolls the starters when the advisor shuffle handler fires', async () => {
      const user = userEvent.setup();
      render(<LearningTabs patterns={MOCK_PATTERNS} />);
      await user.click(screen.getByRole('tab', { name: /advisor/i }));

      const before = screen.getAllByTestId('advisor-starter').map((el) => el.textContent ?? '');
      const rng = vi.spyOn(Math, 'random').mockReturnValue(0.05);
      try {
        act(() => {
          capturedOnResampleStarters?.();
        });
      } finally {
        rng.mockRestore();
      }
      const after = screen.getAllByTestId('advisor-starter').map((el) => el.textContent ?? '');
      expect(after).toHaveLength(5);
      const same =
        new Set(before).size === new Set(after).size &&
        [...new Set(before)].every((p) => new Set(after).has(p));
      expect(same).toBe(false);
    });

    it('re-rolls the starters when the operator clears the conversation', async () => {
      const user = userEvent.setup();
      render(<LearningTabs patterns={MOCK_PATTERNS} />);
      await user.click(screen.getByRole('tab', { name: /advisor/i }));

      const before = screen.getAllByTestId('advisor-starter').map((el) => el.textContent ?? '');
      // Pin Math.random so the re-roll lands on a deterministic
      // (and crucially, different) set of prompts.
      const rng = vi.spyOn(Math, 'random').mockReturnValue(0.9);
      try {
        act(() => {
          capturedOnConversationCleared?.();
        });
      } finally {
        rng.mockRestore();
      }
      const after = screen.getAllByTestId('advisor-starter').map((el) => el.textContent ?? '');
      expect(after).toHaveLength(5);
      // The two arrays must differ — same length, different members.
      // We compare as sets so the test isn't sensitive to ordering.
      const beforeSet = new Set(before);
      const afterSet = new Set(after);
      const same = beforeSet.size === afterSet.size && [...beforeSet].every((p) => afterSet.has(p));
      expect(same).toBe(false);
    });
  });
});
