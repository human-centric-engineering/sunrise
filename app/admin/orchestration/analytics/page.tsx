import type { Metadata } from 'next';

import {
  AnalyticsView,
  type AgentOption,
} from '@/components/admin/orchestration/analytics/analytics-view';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import type {
  TopicEntry,
  UnansweredEntry,
  EngagementMetrics,
  ContentGap,
  FeedbackSummary,
} from '@/lib/orchestration/analytics';

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

async function getEngagement(query: string): Promise<EngagementMetrics | null> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.ANALYTICS_ENGAGEMENT}${query}`);
    if (!res.ok) return null;
    const body = await parseApiResponse<{ metrics: EngagementMetrics }>(res);
    return body.success ? body.data.metrics : null;
  } catch (err) {
    logger.error('analytics page: failed to load engagement', err);
    return null;
  }
}

async function getTopics(query: string): Promise<TopicEntry[] | null> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.ANALYTICS_TOPICS}${query}`);
    if (!res.ok) return null;
    const body = await parseApiResponse<{ topics: TopicEntry[] }>(res);
    return body.success ? body.data.topics : null;
  } catch (err) {
    logger.error('analytics page: failed to load topics', err);
    return null;
  }
}

async function getUnanswered(query: string): Promise<UnansweredEntry[] | null> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.ANALYTICS_UNANSWERED}${query}`);
    if (!res.ok) return null;
    const body = await parseApiResponse<{ questions: UnansweredEntry[] }>(res);
    return body.success ? body.data.questions : null;
  } catch (err) {
    logger.error('analytics page: failed to load unanswered', err);
    return null;
  }
}

async function getFeedback(query: string): Promise<FeedbackSummary | null> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.ANALYTICS_FEEDBACK}${query}`);
    if (!res.ok) return null;
    const body = await parseApiResponse<{ feedback: FeedbackSummary }>(res);
    return body.success ? body.data.feedback : null;
  } catch (err) {
    logger.error('analytics page: failed to load feedback', err);
    return null;
  }
}

async function getContentGaps(query: string): Promise<ContentGap[] | null> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.ANALYTICS_CONTENT_GAPS}${query}`);
    if (!res.ok) return null;
    const body = await parseApiResponse<{ gaps: ContentGap[] }>(res);
    return body.success ? body.data.gaps : null;
  } catch (err) {
    logger.error('analytics page: failed to load content gaps', err);
    return null;
  }
}

async function getAgents(): Promise<AgentOption[]> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.AGENTS);
    if (!res.ok) return [];
    const body = await parseApiResponse<{ agents: Array<{ id: string; name: string }> }>(res);
    if (!body.success) return [];
    return body.data.agents.map((a) => ({ id: a.id, name: a.name }));
  } catch (err) {
    logger.error('analytics page: failed to load agents', err);
    return [];
  }
}

function getDefaultDates(): { today: string; thirtyDaysAgo: string } {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return { today, thirtyDaysAgo };
}

export default async function AnalyticsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const query = buildQuery(params);

  const { today, thirtyDaysAgo } = getDefaultDates();

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

      <AnalyticsView
        engagement={engagement}
        topics={topics}
        unanswered={unanswered}
        feedback={feedback}
        contentGaps={contentGaps}
        agents={agents}
        filters={{
          from: (typeof params.from === 'string' ? params.from : '') || thirtyDaysAgo,
          to: (typeof params.to === 'string' ? params.to : '') || today,
          agentId: typeof params.agentId === 'string' ? params.agentId : '',
        }}
      />
    </div>
  );
}
