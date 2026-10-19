import type { Metadata } from 'next';

import {
  AnalyticsView,
  type AgentOption,
} from '@/components/admin/orchestration/analytics/analytics-view';
import { LoadFailedNotice } from '@/components/admin/load-failed-notice';
import { API } from '@/lib/api/endpoints';
import { loadServerData, type LoadResult } from '@/lib/api/server-load';
import type {
  TopicEntry,
  UnansweredEntry,
  EngagementMetrics,
  ContentGap,
  FeedbackSummary,
} from '@/lib/orchestration/analytics';
import { getAnalyticsDefaultDateInputs } from '@/lib/orchestration/analytics/date-range';

export const metadata: Metadata = {
  title: 'Analytics · AI Orchestration',
  description: 'Usage analytics, popular topics, feedback, and content gaps.',
};

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function buildQuery(params: Record<string, string | string[] | undefined>): string {
  const qs = new URLSearchParams();
  if (typeof params.from === 'string') qs.set('from', params.from);
  if (typeof params.to === 'string') qs.set('to', params.to);
  if (typeof params.agentId === 'string') qs.set('agentId', params.agentId);
  return qs.toString() ? `?${qs.toString()}` : '';
}

/*
 * A failed load never renders as an empty state (#518), and no single
 * analytics endpoint takes the page down. Topics, unanswered questions and
 * content gaps reach `<AnalyticsView>` as `null` when they fail, and that
 * panel shows `<LoadFailedNotice>` in place of an empty state ("No content
 * gaps detected") that would read as an all-clear. Engagement figures show
 * "—" when unknown, which already reads as unknown. The feedback summary and
 * the agent filter options each show `<LoadFailedNotice>` above the view.
 */

async function getEngagement(query: string): Promise<EngagementMetrics | null> {
  const result = await loadServerData<{ metrics: EngagementMetrics }>(
    `${API.ADMIN.ORCHESTRATION.ANALYTICS_ENGAGEMENT}${query}`
  );
  return result.ok ? result.data.metrics : null;
}

async function getTopics(query: string): Promise<TopicEntry[] | null> {
  const result = await loadServerData<{ topics: TopicEntry[] }>(
    `${API.ADMIN.ORCHESTRATION.ANALYTICS_TOPICS}${query}`
  );
  return result.ok ? result.data.topics : null;
}

async function getUnanswered(query: string): Promise<UnansweredEntry[] | null> {
  const result = await loadServerData<{ questions: UnansweredEntry[] }>(
    `${API.ADMIN.ORCHESTRATION.ANALYTICS_UNANSWERED}${query}`
  );
  return result.ok ? result.data.questions : null;
}

async function getFeedback(query: string): Promise<LoadResult<FeedbackSummary>> {
  const result = await loadServerData<{ feedback: FeedbackSummary }>(
    `${API.ADMIN.ORCHESTRATION.ANALYTICS_FEEDBACK}${query}`
  );
  return result.ok ? { ...result, data: result.data.feedback } : result;
}

async function getContentGaps(query: string): Promise<ContentGap[] | null> {
  const result = await loadServerData<{ gaps: ContentGap[] }>(
    `${API.ADMIN.ORCHESTRATION.ANALYTICS_CONTENT_GAPS}${query}`
  );
  return result.ok ? result.data.gaps : null;
}

async function getAgents(): Promise<LoadResult<AgentOption[]>> {
  const result = await loadServerData<Array<{ id: string; name: string }>>(
    API.ADMIN.ORCHESTRATION.AGENTS
  );
  return result.ok
    ? { ...result, data: result.data.map((a) => ({ id: a.id, name: a.name })) }
    : result;
}

export default async function AnalyticsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const query = buildQuery(params);

  const { from: thirtyDaysAgo, to: today } = getAnalyticsDefaultDateInputs();

  const [engagement, topics, unanswered, feedback, contentGaps, agents] = await Promise.all([
    getEngagement(query),
    getTopics(query),
    getUnanswered(query),
    getFeedback(query),
    getContentGaps(query),
    getAgents(),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Analytics</h1>
        <p className="text-muted-foreground text-sm">
          Usage patterns, popular topics, feedback, and content gaps across your agents.
        </p>
      </div>

      {!feedback.ok && <LoadFailedNotice what="the feedback summary" />}
      {!agents.ok && <LoadFailedNotice what="the agent filter options" />}

      <AnalyticsView
        engagement={engagement}
        topics={topics}
        unanswered={unanswered}
        feedback={feedback.ok ? feedback.data : null}
        contentGaps={contentGaps}
        agents={agents.ok ? agents.data : []}
        filters={{
          from: (typeof params.from === 'string' ? params.from : '') || thirtyDaysAgo,
          to: (typeof params.to === 'string' ? params.to : '') || today,
          agentId: typeof params.agentId === 'string' ? params.agentId : '',
        }}
      />
    </div>
  );
}
