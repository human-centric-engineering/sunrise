/**
 * Tests for the analytics dashboard view component.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  AnalyticsView,
  type AnalyticsViewProps,
} from '@/components/admin/orchestration/analytics/analytics-view';

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
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
              ratedAt: new Date('2026-04-18'),
            },
            {
              messageId: 'msg_2',
              conversationId: 'conv_2',
              agentId: 'a1',
              content: 'Completely unhelpful response',
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
});
