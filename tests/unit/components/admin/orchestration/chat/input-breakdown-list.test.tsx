import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { InputBreakdownList } from '@/components/admin/orchestration/chat/input-breakdown-list';
import type { InputBreakdown } from '@/types/orchestration';

function makeBreakdown(overrides: Partial<InputBreakdown> = {}): InputBreakdown {
  return {
    systemPrompt: { tokens: 120, chars: 480, content: 'You are a helpful assistant.' },
    userMessage: { tokens: 8, chars: 32, content: 'Hi there' },
    totalEstimated: 128,
    ...overrides,
  };
}

describe('InputBreakdownList', () => {
  it('renders the required system-prompt and user-message rows even on a minimal breakdown', () => {
    render(<InputBreakdownList breakdown={makeBreakdown()} />);
    expect(screen.getByText('System prompt')).toBeInTheDocument();
    expect(screen.getByText('Your message')).toBeInTheDocument();
  });

  it('omits the header reconciliation line when no reported count is supplied', () => {
    render(<InputBreakdownList breakdown={makeBreakdown()} />);
    expect(screen.queryByText(/model reported/i)).not.toBeInTheDocument();
  });

  it('shows the reconciliation header when reportedInputTokens is set', () => {
    render(<InputBreakdownList breakdown={makeBreakdown()} reportedInputTokens={4991} />);
    expect(screen.getByText(/model reported 4,991/i)).toBeInTheDocument();
    expect(screen.getByText(/est\. 128/i)).toBeInTheDocument();
  });

  it('renders every optional section when supplied', () => {
    const breakdown = makeBreakdown({
      contextBlock: { tokens: 50, chars: 200, content: '[Entity: project_42]' },
      userMemories: { tokens: 30, chars: 90, count: 2, content: '- name: Sam\n- timezone: PT' },
      conversationSummary: { tokens: 80, chars: 320, content: 'Previously: …' },
      conversationHistory: {
        tokens: 200,
        chars: 800,
        messageCount: 12,
        droppedCount: 3,
      },
      toolDefinitions: {
        tokens: 600,
        chars: 1800,
        count: 3,
        names: ['search_kb', 'send_email', 'lookup_order'],
        content: 'namespace functions { … }',
      },
      attachments: { tokens: 765, count: 1 },
      framingOverhead: { tokens: 222, chars: 0 },
      totalEstimated: 2075,
    });
    render(<InputBreakdownList breakdown={breakdown} reportedInputTokens={2075} />);

    expect(screen.getByText('Entity context')).toBeInTheDocument();
    expect(screen.getByText('User memories (2)')).toBeInTheDocument();
    expect(screen.getByText('Conversation summary')).toBeInTheDocument();
    expect(screen.getByText('Conversation history')).toBeInTheDocument();
    expect(screen.getByText('12 messages · 3 dropped')).toBeInTheDocument();
    expect(screen.getByText('Tool schemas (3)')).toBeInTheDocument();
    expect(screen.getByText('search_kb, send_email, lookup_order')).toBeInTheDocument();
    expect(screen.getByText('Attachments (1)')).toBeInTheDocument();
    expect(screen.getByText('Provider framing')).toBeInTheDocument();
  });

  it('handles single-message history without pluralisation or dropped suffix', () => {
    const breakdown = makeBreakdown({
      conversationHistory: { tokens: 10, chars: 40, messageCount: 1, droppedCount: 0 },
    });
    render(<InputBreakdownList breakdown={breakdown} />);
    expect(screen.getByText('1 message')).toBeInTheDocument();
  });

  it('expands a content section to show the raw text when its chevron is clicked', async () => {
    const user = userEvent.setup();
    render(<InputBreakdownList breakdown={makeBreakdown()} />);

    const systemBtn = screen.getByRole('button', { name: /system prompt/i });
    expect(systemBtn).toHaveAttribute('aria-expanded', 'false');
    await user.click(systemBtn);
    expect(systemBtn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('You are a helpful assistant.')).toBeInTheDocument();
  });

  it('expands the Provider framing row to show the explainer copy', async () => {
    const user = userEvent.setup();
    const breakdown = makeBreakdown({
      framingOverhead: { tokens: 200, chars: 0 },
      totalEstimated: 328,
    });
    render(<InputBreakdownList breakdown={breakdown} model="gpt-4o" />);

    const framingBtn = screen.getByRole('button', { name: /provider framing/i });
    await user.click(framingBtn);
    expect(screen.getByText(/reconciliation line/i)).toBeInTheDocument();
    // OpenAI-specific bullet point shows for gpt-4o. The `<strong>` tag
    // splits this text into siblings, so use a node-aware matcher.
    expect(
      screen.getAllByText(
        (_content, node) => !!node && /per-message scaffolding/i.test(node.textContent ?? '')
      ).length
    ).toBeGreaterThan(0);
  });

  it.each([
    ['gpt-4o', /o200k_base/],
    ['claude-sonnet-4-5', /count_tokens endpoint is network-only/],
    ['gemini-2.0-pro', /countTokens is SDK-only/],
    ['llama-3.1-70b', /Llama-family BPE/],
    [undefined, /defensive default/],
  ])('renders provider-specific tokeniser copy for model=%p', async (model, expectedCopy) => {
    const user = userEvent.setup();
    const breakdown = makeBreakdown({
      framingOverhead: { tokens: 200, chars: 0 },
      totalEstimated: 328,
    });
    render(<InputBreakdownList breakdown={breakdown} model={model} />);
    await user.click(screen.getByRole('button', { name: /provider framing/i }));
    expect(screen.getByText(expectedCopy)).toBeInTheDocument();
  });

  it('marks non-expandable rows (no content / no explanation) as not interactive', () => {
    const breakdown = makeBreakdown({
      attachments: { tokens: 765, count: 2 },
    });
    render(<InputBreakdownList breakdown={breakdown} />);
    const attachmentsBtn = screen.getByRole('button', { name: /attachments \(2\)/i });
    // `aria-expanded` is omitted entirely for non-expandable rows.
    expect(attachmentsBtn).not.toHaveAttribute('aria-expanded');
  });

  it('computes a percentage share per row against totalEstimated', () => {
    const breakdown = makeBreakdown({
      systemPrompt: { tokens: 50, chars: 200, content: 'sys' },
      userMessage: { tokens: 50, chars: 200, content: 'msg' },
      totalEstimated: 100,
    });
    render(<InputBreakdownList breakdown={breakdown} />);
    const sysRow = screen.getByRole('button', { name: /system prompt/i }).closest('li');
    expect(sysRow).not.toBeNull();
    if (sysRow) expect(within(sysRow).getByText(/50%/)).toBeInTheDocument();
  });

  it('falls back to 0% when totalEstimated would be zero', () => {
    const breakdown = makeBreakdown({
      systemPrompt: { tokens: 0, chars: 0, content: '' },
      userMessage: { tokens: 0, chars: 0, content: '' },
      totalEstimated: 0,
    });
    render(<InputBreakdownList breakdown={breakdown} />);
    // Two rows, both at 0%; just check at least one renders.
    const userRow = screen.getByRole('button', { name: /your message/i }).closest('li');
    expect(userRow).not.toBeNull();
    if (userRow) expect(within(userRow).getByText(/0%/)).toBeInTheDocument();
  });
});
