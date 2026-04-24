/**
 * Tests for the analytics dashboard view component.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  AnalyticsView,
  type AnalyticsViewProps,
} from '@/components/admin/orchestration/analytics/analytics-view';

// Hoist a stable pushMock so filter-change assertions can observe router.push.
const pushMock = vi.fn();

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
  useSearchParams: () => new URLSearchParams(),
}));

// Minimal mock data
const baseProps: AnalyticsViewProps = {
  engagement: null,
  topics: null,
  unanswered: null,
  feedback: null,
  contentGaps: null,
  agents: [],
  filters: { from: '2026-03-21', to: '2026-04-20', agentId: '' },
};

describe('AnalyticsView', () => {
  beforeEach(() => {
    pushMock.mockClear();
  });

  // ── Existing tests (keep — do not modify) ──────────────────────────────────

  it('renders without data (null-safe)', () => {
    render(<AnalyticsView {...baseProps} />);
    expect(screen.getByTestId('engagement-cards')).toBeInTheDocument();
    expect(screen.getByTestId('analytics-filters')).toBeInTheDocument();
    expect(screen.getByText('No topic data yet.')).toBeInTheDocument();
    expect(screen.getByText('No unanswered questions found.')).toBeInTheDocument();
    expect(screen.getByText('No content gaps detected.')).toBeInTheDocument();
  });

  it('renders filter controls', () => {
    render(
      <AnalyticsView
        {...baseProps}
        agents={[
          { id: 'a1', name: 'FAQ Bot' },
          { id: 'a2', name: 'Sales Bot' },
        ]}
      />
    );

    expect(screen.getByLabelText('From')).toBeInTheDocument();
    expect(screen.getByLabelText('To')).toBeInTheDocument();
    expect(screen.getByText('All agents')).toBeInTheDocument();
  });

  it('renders engagement metrics including messages count', () => {
    render(
      <AnalyticsView
        {...baseProps}
        engagement={{
          totalConversations: 150,
          totalMessages: 1200,
          uniqueUsers: 45,
          avgMessagesPerConversation: 8.0,
          returningUsers: 20,
          returningUserRate: 0.444,
          conversationsByDay: [],
        }}
      />
    );

    expect(screen.getByText('150')).toBeInTheDocument();
    expect(screen.getByText('1,200')).toBeInTheDocument();
    expect(screen.getByText('45')).toBeInTheDocument();
    expect(screen.getByText('8.0')).toBeInTheDocument();
    expect(screen.getByText('44.4%')).toBeInTheDocument();
  });

  it('renders conversations-over-time trend when 2+ days of data', () => {
    render(
      <AnalyticsView
        {...baseProps}
        engagement={{
          totalConversations: 10,
          totalMessages: 50,
          uniqueUsers: 5,
          avgMessagesPerConversation: 5.0,
          returningUsers: 2,
          returningUserRate: 0.4,
          conversationsByDay: [
            { date: '2026-04-15', count: 4 },
            { date: '2026-04-16', count: 6 },
          ],
        }}
      />
    );

    expect(screen.getByTestId('conversations-trend')).toBeInTheDocument();
    expect(screen.getByText('Conversations Over Time')).toBeInTheDocument();
    expect(screen.getByText('2026-04-15')).toBeInTheDocument();
    expect(screen.getByText('2026-04-16')).toBeInTheDocument();
  });

  it('does not render trend chart when only 1 day of data', () => {
    render(
      <AnalyticsView
        {...baseProps}
        engagement={{
          totalConversations: 5,
          totalMessages: 20,
          uniqueUsers: 3,
          avgMessagesPerConversation: 4.0,
          returningUsers: 1,
          returningUserRate: 0.333,
          conversationsByDay: [{ date: '2026-04-15', count: 5 }],
        }}
      />
    );

    expect(screen.queryByTestId('conversations-trend')).not.toBeInTheDocument();
  });

  it('renders feedback summary with per-agent table', () => {
    render(
      <AnalyticsView
        {...baseProps}
        feedback={{
          overall: { thumbsUp: 100, thumbsDown: 10, total: 110, satisfactionRate: 0.909 },
          byAgent: [
            {
              agentId: 'a1',
              agentName: 'FAQ Bot',
              thumbsUp: 80,
              thumbsDown: 5,
              total: 85,
              satisfactionRate: 0.941,
            },
          ],
          recentNegative: [],
        }}
      />
    );

    expect(screen.getByTestId('feedback-summary')).toBeInTheDocument();
    expect(screen.getByText('90.9%')).toBeInTheDocument();
    expect(screen.getByText('100 up')).toBeInTheDocument();
    expect(screen.getByText('10 down')).toBeInTheDocument();
    expect(screen.getByText('FAQ Bot')).toBeInTheDocument();
  });

  it('renders recent negative feedback table', () => {
    render(
      <AnalyticsView
        {...baseProps}
        feedback={{
          overall: { thumbsUp: 5, thumbsDown: 3, total: 8, satisfactionRate: 0.625 },
          byAgent: [],
          recentNegative: [
            {
              messageId: 'msg_1',
              conversationId: 'conv_1',
              agentId: 'a1',
              content: 'This answer was wrong about pricing',
              userMessage: 'What is the pricing?',
              ratedAt: new Date('2026-04-18'),
            },
            {
              messageId: 'msg_2',
              conversationId: 'conv_2',
              agentId: 'a1',
              content: 'Completely unhelpful response',
              userMessage: 'How do I reset my password?',
              ratedAt: new Date('2026-04-17'),
            },
          ],
        }}
      />
    );

    expect(screen.getByTestId('recent-negative')).toBeInTheDocument();
    expect(screen.getByText('Recent Negative Feedback')).toBeInTheDocument();
    expect(screen.getByText('This answer was wrong about pricing')).toBeInTheDocument();
    expect(screen.getByText('Completely unhelpful response')).toBeInTheDocument();
  });

  it('renders popular topics table', () => {
    render(
      <AnalyticsView
        {...baseProps}
        topics={[
          { content: 'How to reset password', count: 42, lastAsked: new Date() },
          { content: 'Billing questions', count: 31, lastAsked: new Date() },
        ]}
      />
    );

    expect(screen.getByText('How to reset password')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('Billing questions')).toBeInTheDocument();
  });

  it('renders content gaps table', () => {
    render(
      <AnalyticsView
        {...baseProps}
        contentGaps={[
          { topic: 'integrations', queryCount: 20, unansweredCount: 15, gapRatio: 0.75 },
        ]}
      />
    );

    expect(screen.getByText('integrations')).toBeInTheDocument();
    expect(screen.getByText('75.0%')).toBeInTheDocument();
  });

  it('renders unanswered questions', () => {
    render(
      <AnalyticsView
        {...baseProps}
        unanswered={[
          {
            messageId: 'msg_1',
            conversationId: 'c1',
            agentId: 'a1',
            userMessage: 'How do I connect to Stripe?',
            assistantReply: "I'm not sure about that.",
            createdAt: new Date('2026-04-15'),
          },
        ]}
      />
    );

    expect(screen.getByText('How do I connect to Stripe?')).toBeInTheDocument();
    expect(screen.getByText("I'm not sure about that.")).toBeInTheDocument();
  });

  // ── New tests ───────────────────────────────────────────────────────────────

  it('From date filter change calls router.push with from= query param', () => {
    // Arrange
    render(<AnalyticsView {...baseProps} />);
    const fromInput = document.getElementById('filter-from')!;

    // Act — use fireEvent for date inputs (userEvent does not work well with type="date" in jsdom)
    fireEvent.change(fromInput, { target: { value: '2026-03-01' } });

    // Assert — router.push was called with the new from param
    expect(pushMock).toHaveBeenCalledWith(expect.stringContaining('from=2026-03-01'));
  });

  it('clearing the From date removes from= from the pushed URL', () => {
    // Arrange — start with an existing from filter
    render(
      <AnalyticsView
        {...baseProps}
        filters={{ from: '2026-03-21', to: '2026-04-20', agentId: '' }}
      />
    );
    const fromInput = document.getElementById('filter-from')!;

    // Act — clear the date value
    fireEvent.change(fromInput, { target: { value: '' } });

    // Assert — the pushed URL does NOT contain from=
    expect(pushMock).toHaveBeenCalledTimes(1);
    const pushedUrl: string = pushMock.mock.calls[0][0] as string;
    expect(pushedUrl).not.toContain('from=');
  });

  it('selecting an agent from the filter calls router.push with agentId param', async () => {
    // Arrange
    const user = userEvent.setup();
    render(
      <AnalyticsView
        {...baseProps}
        agents={[{ id: 'a1', name: 'FAQ Bot' }]}
        filters={{ from: '', to: '', agentId: '' }}
      />
    );

    // Open the Select
    await user.click(screen.getByRole('combobox'));

    // Act — click the agent option (Radix Select renders options in a Portal)
    await user.click(await screen.findByRole('option', { name: 'FAQ Bot' }));

    // Assert — router.push called with agentId=a1
    expect(pushMock).toHaveBeenCalledWith(expect.stringContaining('agentId=a1'));
  });

  it('selecting "All agents" removes agentId from the pushed URL', async () => {
    // Arrange — start with an agent already selected
    const user = userEvent.setup();
    render(
      <AnalyticsView
        {...baseProps}
        agents={[{ id: 'a1', name: 'FAQ Bot' }]}
        filters={{ from: '', to: '', agentId: 'a1' }}
      />
    );

    // Open the Select
    await user.click(screen.getByRole('combobox'));

    // Act — click "All agents"
    await user.click(await screen.findByRole('option', { name: 'All agents' }));

    // Assert — pushed URL does NOT contain agentId=
    expect(pushMock).toHaveBeenCalledTimes(1);
    const pushedUrl: string = pushMock.mock.calls[0][0] as string;
    expect(pushedUrl).not.toContain('agentId=');
  });

  it('trend chart renders one bar per day for 3 days of data', () => {
    // Arrange — 3 days of data means 3 bar divs inside the trend container
    const { container } = render(
      <AnalyticsView
        {...baseProps}
        engagement={{
          totalConversations: 15,
          totalMessages: 60,
          uniqueUsers: 8,
          avgMessagesPerConversation: 4.0,
          returningUsers: 3,
          returningUserRate: 0.375,
          conversationsByDay: [
            { date: '2026-04-14', count: 3 },
            { date: '2026-04-15', count: 7 },
            { date: '2026-04-16', count: 5 },
          ],
        }}
      />
    );

    // Assert — 3 bar elements inside the trend container
    const bars = container.querySelectorAll('[data-testid="conversations-trend"] .bg-primary');
    expect(bars).toHaveLength(3);
  });

  it('trend chart: zero-count day has minHeight 0px, non-zero day has minHeight 4px', () => {
    // Arrange — one zero day, one non-zero day (only 2 needed to show the trend chart)
    const { container } = render(
      <AnalyticsView
        {...baseProps}
        engagement={{
          totalConversations: 5,
          totalMessages: 20,
          uniqueUsers: 3,
          avgMessagesPerConversation: 4.0,
          returningUsers: 1,
          returningUserRate: 0.2,
          conversationsByDay: [
            { date: '2026-04-15', count: 0 },
            { date: '2026-04-16', count: 5 },
          ],
        }}
      />
    );

    const bars = container.querySelectorAll('[data-testid="conversations-trend"] .bg-primary');
    expect(bars).toHaveLength(2);

    // The zero-count bar should have minHeight: 0px
    const zeroBar = bars[0] as HTMLElement;
    expect(zeroBar.style.minHeight).toBe('0px');

    // The non-zero bar should have minHeight: 4px
    const nonZeroBar = bars[1] as HTMLElement;
    expect(nonZeroBar.style.minHeight).toBe('4px');
  });
});
