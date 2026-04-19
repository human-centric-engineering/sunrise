'use client';

/**
 * AnalyticsView — Client island for the analytics dashboard.
 *
 * Receives pre-fetched data from the server component page and renders
 * engagement cards, popular topics, unanswered questions, feedback
 * summary, and content gaps.
 */

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { FieldHelp } from '@/components/ui/field-help';
import type {
  TopicEntry,
  UnansweredEntry,
  EngagementMetrics,
  ContentGap,
  FeedbackSummary,
} from '@/lib/orchestration/analytics';

export interface AnalyticsViewProps {
  engagement: EngagementMetrics | null;
  topics: TopicEntry[] | null;
  unanswered: UnansweredEntry[] | null;
  feedback: FeedbackSummary | null;
  contentGaps: ContentGap[] | null;
}

function formatNumber(n: number | null | undefined): string {
  if (n == null) return '\u2014';
  return n.toLocaleString();
}

function formatPercent(n: number | null | undefined): string {
  if (n == null) return '\u2014';
  return `${(n * 100).toFixed(1)}%`;
}

export function AnalyticsView({
  engagement,
  topics,
  unanswered,
  feedback,
  contentGaps,
}: AnalyticsViewProps) {
  return (
    <div className="space-y-6">
      {/* Engagement summary cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="engagement-cards">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground text-sm font-medium">
              Conversations
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{formatNumber(engagement?.totalConversations)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground text-sm font-medium">
              Unique Users
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{formatNumber(engagement?.uniqueUsers)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground flex items-center gap-1 text-sm font-medium">
              Avg Depth
              <FieldHelp>Average messages per conversation</FieldHelp>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">
              {engagement?.avgMessagesPerConversation != null
                ? engagement.avgMessagesPerConversation.toFixed(1)
                : '\u2014'}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground flex items-center gap-1 text-sm font-medium">
              Returning Users
              <FieldHelp>Percentage of users who started more than one conversation</FieldHelp>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{formatPercent(engagement?.returningUserRate)}</p>
          </CardContent>
        </Card>
      </div>

      {/* Feedback summary */}
      {feedback && (
        <Card data-testid="feedback-summary">
          <CardHeader>
            <CardTitle className="text-base font-medium">Feedback Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-6 text-sm">
              <div>
                <span className="text-muted-foreground">Satisfaction:</span>{' '}
                <span className="font-medium">
                  {formatPercent(feedback.overall.satisfactionRate)}
                </span>
              </div>
              <div>
                <Badge variant="default" className="bg-green-600">
                  {feedback.overall.thumbsUp} up
                </Badge>
              </div>
              <div>
                <Badge variant="destructive">{feedback.overall.thumbsDown} down</Badge>
              </div>
              <div className="text-muted-foreground">{feedback.overall.total} total ratings</div>
            </div>
            {feedback.byAgent.length > 0 && (
              <Table className="mt-4">
                <TableHeader>
                  <TableRow>
                    <TableHead>Agent</TableHead>
                    <TableHead className="text-right">Up</TableHead>
                    <TableHead className="text-right">Down</TableHead>
                    <TableHead className="text-right">Satisfaction</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {feedback.byAgent.map((a) => (
                    <TableRow key={a.agentId}>
                      <TableCell className="font-medium">{a.agentName}</TableCell>
                      <TableCell className="text-right">{a.thumbsUp}</TableCell>
                      <TableCell className="text-right">{a.thumbsDown}</TableCell>
                      <TableCell className="text-right">
                        {formatPercent(a.satisfactionRate)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Popular topics */}
        <Card data-testid="popular-topics">
          <CardHeader>
            <CardTitle className="text-base font-medium">Popular Topics</CardTitle>
          </CardHeader>
          <CardContent>
            {!topics || topics.length === 0 ? (
              <p className="text-muted-foreground text-sm">No topic data yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Topic</TableHead>
                    <TableHead className="text-right">Count</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {topics.slice(0, 15).map((t, i) => (
                    <TableRow key={i}>
                      <TableCell className="max-w-[300px] truncate">{t.content}</TableCell>
                      <TableCell className="text-right">{t.count}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Content gaps */}
        <Card data-testid="content-gaps">
          <CardHeader>
            <CardTitle className="flex items-center gap-1 text-base font-medium">
              Content Gaps
              <FieldHelp>
                Topics where a high proportion of questions go unanswered, indicating missing
                knowledge base content
              </FieldHelp>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!contentGaps || contentGaps.length === 0 ? (
              <p className="text-muted-foreground text-sm">No content gaps detected.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Topic</TableHead>
                    <TableHead className="text-right">Queries</TableHead>
                    <TableHead className="text-right">Gap Ratio</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {contentGaps.slice(0, 15).map((g, i) => (
                    <TableRow key={i}>
                      <TableCell className="max-w-[300px] truncate">{g.topic}</TableCell>
                      <TableCell className="text-right">{g.queryCount}</TableCell>
                      <TableCell className="text-right">{formatPercent(g.gapRatio)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Unanswered questions */}
      <Card data-testid="unanswered-questions">
        <CardHeader>
          <CardTitle className="flex items-center gap-1 text-base font-medium">
            Unanswered Questions
            <FieldHelp>
              Recent user messages where the assistant replied with an apology or uncertainty signal
            </FieldHelp>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!unanswered || unanswered.length === 0 ? (
            <p className="text-muted-foreground text-sm">No unanswered questions found.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User Message</TableHead>
                  <TableHead>Assistant Reply</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {unanswered.slice(0, 20).map((u) => (
                  <TableRow key={u.conversationId}>
                    <TableCell className="max-w-[300px] truncate">{u.userMessage}</TableCell>
                    <TableCell className="text-muted-foreground max-w-[300px] truncate">
                      {u.assistantReply}
                    </TableCell>
                    <TableCell className="text-sm whitespace-nowrap">
                      {new Date(u.createdAt).toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
