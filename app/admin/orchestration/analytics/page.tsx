import type { Metadata } from 'next';

import { AnalyticsView } from '@/components/admin/orchestration/analytics/analytics-view';
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

async function getEngagement(): Promise<EngagementMetrics | null> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.ANALYTICS_ENGAGEMENT);
    if (!res.ok) return null;
    const body = await parseApiResponse<{ metrics: EngagementMetrics }>(res);
    return body.success ? body.data.metrics : null;
  } catch (err) {
    logger.error('analytics page: failed to load engagement', err);
    return null;
  }
}

async function getTopics(): Promise<TopicEntry[] | null> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.ANALYTICS_TOPICS);
    if (!res.ok) return null;
    const body = await parseApiResponse<{ topics: TopicEntry[] }>(res);
    return body.success ? body.data.topics : null;
  } catch (err) {
    logger.error('analytics page: failed to load topics', err);
    return null;
  }
}

async function getUnanswered(): Promise<UnansweredEntry[] | null> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.ANALYTICS_UNANSWERED);
    if (!res.ok) return null;
    const body = await parseApiResponse<{ questions: UnansweredEntry[] }>(res);
    return body.success ? body.data.questions : null;
  } catch (err) {
    logger.error('analytics page: failed to load unanswered', err);
    return null;
  }
}

async function getFeedback(): Promise<FeedbackSummary | null> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.ANALYTICS_FEEDBACK);
    if (!res.ok) return null;
    const body = await parseApiResponse<{ feedback: FeedbackSummary }>(res);
    return body.success ? body.data.feedback : null;
  } catch (err) {
    logger.error('analytics page: failed to load feedback', err);
    return null;
  }
}

async function getContentGaps(): Promise<ContentGap[] | null> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.ANALYTICS_CONTENT_GAPS);
    if (!res.ok) return null;
    const body = await parseApiResponse<{ gaps: ContentGap[] }>(res);
    return body.success ? body.data.gaps : null;
  } catch (err) {
    logger.error('analytics page: failed to load content gaps', err);
    return null;
  }
}

export default async function AnalyticsPage() {
  const [engagement, topics, unanswered, feedback, contentGaps] = await Promise.all([
    getEngagement(),
    getTopics(),
    getUnanswered(),
    getFeedback(),
    getContentGaps(),
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
      />
    </div>
  );
}
