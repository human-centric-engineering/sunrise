/**
 * MessageTrace component tests
 *
 * Behavioural surface under test:
 *   - hides itself when there is nothing to show (admin chat without
 *     trace data should render nothing extra)
 *   - summary line collapses tool count + total latency
 *   - clicking the toggle opens the per-call details
 *   - failures are visually distinct and report the error code
 *   - cost is shown only when present (gracefully omitted otherwise)
 *
 * The component is purely presentational — no network, no providers
 * — so a flat happy-dom render is sufficient.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MessageTrace } from '@/components/admin/orchestration/chat/message-trace';
import type { ToolCallTrace } from '@/types/orchestration';

const successCall: ToolCallTrace = {
  slug: 'search_knowledge_base',
  arguments: { query: 'reset password' },
  latencyMs: 320,
  success: true,
  resultPreview: '{"results":[{"chunkId":"c1"}]}',
};

const failingCall: ToolCallTrace = {
  slug: 'lookup_order',
  arguments: { orderId: 'missing' },
  latencyMs: 80,
  success: false,
  errorCode: 'not_found',
};

describe('MessageTrace', () => {
  it('renders nothing when toolCalls is empty', () => {
    const { container } = render(<MessageTrace toolCalls={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when toolCalls is undefined', () => {
    const { container } = render(<MessageTrace />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows tool count and aggregated latency in the collapsed summary', () => {
    render(<MessageTrace toolCalls={[successCall, failingCall]} />);
    const summary = screen.getByRole('button', { expanded: false });
    expect(summary).toHaveTextContent('2 tools');
    expect(summary).toHaveTextContent('400ms');
  });

  it('uses the singular form when there is exactly one tool call', () => {
    render(<MessageTrace toolCalls={[successCall]} />);
    expect(screen.getByRole('button')).toHaveTextContent('1 tool ');
  });

  it('flags failures inline on the summary line', () => {
    render(<MessageTrace toolCalls={[successCall, failingCall]} />);
    expect(screen.getByRole('button')).toHaveTextContent('1 failed');
  });

  it('expands to show per-call cards when toggled', async () => {
    const user = userEvent.setup();
    render(<MessageTrace toolCalls={[successCall]} />);
    expect(screen.queryAllByTestId('message-trace-call')).toHaveLength(0);
    await user.click(screen.getByRole('button'));
    expect(screen.getAllByTestId('message-trace-call')).toHaveLength(1);
    expect(screen.getByText('search_knowledge_base')).toBeInTheDocument();
  });

  it('renders failure metadata: errorCode + amber border', async () => {
    const user = userEvent.setup();
    render(<MessageTrace toolCalls={[failingCall]} defaultOpen />);
    expect(screen.getByText('not_found')).toBeInTheDocument();
    const card = screen.getByTestId('message-trace-call');
    expect(card.className).toMatch(/amber/);
    expect(user).toBeTruthy(); // no-op assertion — keep import used
  });

  it('formats sub-second and super-second latency differently', () => {
    render(
      <MessageTrace
        toolCalls={[
          { ...successCall, latencyMs: 250 },
          { ...successCall, slug: 'other', latencyMs: 2600 },
        ]}
      />
    );
    // Total = 2850ms → 2.9s
    expect(screen.getByRole('button')).toHaveTextContent('2.9s');
  });

  it('shows cost only when costUsd is provided', () => {
    render(<MessageTrace toolCalls={[{ ...successCall, costUsd: 0.0042 }]} defaultOpen />);
    expect(screen.getByText('$0.0042')).toBeInTheDocument();
  });

  it('omits cost gracefully when not provided', () => {
    render(<MessageTrace toolCalls={[successCall]} defaultOpen />);
    expect(screen.queryByText(/\$\d/)).not.toBeInTheDocument();
  });

  it('respects defaultOpen and starts expanded', () => {
    render(<MessageTrace toolCalls={[successCall]} defaultOpen />);
    expect(screen.getAllByTestId('message-trace-call')).toHaveLength(1);
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
  });
});
