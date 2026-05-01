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

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: pushMock,
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
}));

// Capture the onStreamComplete prop so we can invoke it manually
let capturedOnStreamComplete: ((text: string) => void) | undefined;

vi.mock('@/components/admin/orchestration/chat/chat-interface', () => ({
  ChatInterface: (props: {
    agentSlug: string;
    starterPrompts?: string[];
    onStreamComplete?: (text: string) => void;
  }) => {
    capturedOnStreamComplete = props.onStreamComplete;
    return (
      <div data-testid="chat-interface" data-agent={props.agentSlug}>
        {props.starterPrompts?.map((p) => (
          <span key={p}>{p}</span>
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
    category: 'Reasoning',
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
});
