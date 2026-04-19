/**
 * Tests for the analytics dashboard view component.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  AnalyticsView,
  type AnalyticsViewProps,
} from '@/components/admin/orchestration/analytics/analytics-view';

// Minimal mock data
const baseProps: AnalyticsViewProps = {
  engagement: null,
  topics: null,
  unanswered: null,
  feedback: null,
  contentGaps: null,
};

describe('AnalyticsView', () => {
  it('renders without data (null-safe)', () => {
    render(<AnalyticsView {...baseProps} />);
    expect(screen.getByTestId('engagement-cards')).toBeInTheDocument();
    expect(screen.getByText('No topic data yet.')).toBeInTheDocument();
    expect(screen.getByText('No unanswered questions found.')).toBeInTheDocument();
    expect(screen.getByText('No content gaps detected.')).toBeInTheDocument();
  });

  it('renders engagement metrics', () => {
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
    expect(screen.getByText('45')).toBeInTheDocument();
    expect(screen.getByText('8.0')).toBeInTheDocument();
    expect(screen.getByText('44.4%')).toBeInTheDocument();
  });

  it('renders feedback summary', () => {
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
