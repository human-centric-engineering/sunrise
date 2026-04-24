'use client';

/**
 * AnalyticsView — Client island for the analytics dashboard.
 *
 * Renders engagement cards, trend chart, popular topics, unanswered
 * questions, feedback summary with recent negative, and content gaps.
 * Includes date range and agent filter controls.
 */

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type {
  TopicEntry,
  UnansweredEntry,
  EngagementMetrics,
  ContentGap,
  FeedbackSummary,
} from '@/lib/orchestration/analytics';

export interface AgentOption {
  id: string;
  name: string;
}

export interface AnalyticsViewProps {
  engagement: EngagementMetrics | null;
  topics: TopicEntry[] | null;
  unanswered: UnansweredEntry[] | null;
  feedback: FeedbackSummary | null;
  contentGaps: ContentGap[] | null;
  agents: AgentOption[];
  filters: {
    from: string;
    to: string;
    agentId: string;
  };
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
  agents,
  filters,
}: AnalyticsViewProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const updateFilter = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) {
        params.set(key, value);
      } else {
        params.delete(key);
      }
      router.push(`?${params.toString()}`);
    },
    [router, searchParams]
  );

  // Compute max bar height for trend chart
  const maxDayCount =
    engagement?.conversationsByDay?.reduce((m, d) => Math.max(m, d.count), 0) ?? 0;

  return (
    <div className="space-y-6">
      {/* Filters */}
      <Card data-testid="analytics-filters">
        <CardContent className="flex flex-wrap items-end gap-4 pt-4">
          <div className="space-y-1">
            <label htmlFor="filter-from" className="text-muted-foreground text-xs font-medium">
              From
            </label>
            <input
              id="filter-from"
              type="date"
              className="border-input bg-background ring-offset-background focus-visible:ring-ring block h-9 rounded-md border px-3 py-1 text-sm shadow-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              value={filters.from}
              onChange={(e) => updateFilter('from', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="filter-to" className="text-muted-foreground text-xs font-medium">
              To
            </label>
            <input
              id="filter-to"
              type="date"
              className="border-input bg-background ring-offset-background focus-visible:ring-ring block h-9 rounded-md border px-3 py-1 text-sm shadow-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              value={filters.to}
              onChange={(e) => updateFilter('to', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <span id="agent-filter-label" className="text-muted-foreground text-xs font-medium">
              Agent
            </span>
            <Select
              value={filters.agentId || '__all__'}
              onValueChange={(v) => updateFilter('agentId', v === '__all__' ? '' : v)}
            >
              <SelectTrigger className="w-[200px]" aria-labelledby="agent-filter-label">
                <SelectValue placeholder="All agents" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All agents</SelectItem>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Engagement summary cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5" data-testid="engagement-cards">
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
            <CardTitle className="text-muted-foreground text-sm font-medium">Messages</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{formatNumber(engagement?.totalMessages)}</p>
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
              <FieldHelp title="Average conversation depth">
                Average messages per conversation
              </FieldHelp>
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
              <FieldHelp title="Returning users">
                Percentage of users who started more than one conversation
              </FieldHelp>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{formatPercent(engagement?.returningUserRate)}</p>
          </CardContent>
        </Card>
      </div>

      {/* Conversations by day trend */}
      {engagement?.conversationsByDay && engagement.conversationsByDay.length > 1 && (
        <Card data-testid="conversations-trend">
          <CardHeader>
            <CardTitle className="text-base font-medium">Conversations Over Time</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex h-32 items-end gap-[2px]">
              {engagement.conversationsByDay.map((day) => (
                <div
                  key={day.date}
                  className="bg-primary flex-1 rounded-t transition-all"
                  style={{
                    height: maxDayCount > 0 ? `${(day.count / maxDayCount) * 100}%` : '0%',
                    minHeight: day.count > 0 ? '4px' : '0px',
                  }}
                  title={`${day.date}: ${day.count} conversations`}
                />
              ))}
            </div>
            <div className="text-muted-foreground mt-1 flex justify-between text-xs">
              <span>{engagement.conversationsByDay[0]?.date}</span>
              <span>
                {engagement.conversationsByDay[engagement.conversationsByDay.length - 1]?.date}
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Feedback summary */}
      {feedback && (
        <Card data-testid="feedback-summary">
          <CardHeader>
            <CardTitle className="flex items-center gap-1 text-base font-medium">
              Feedback Summary
              <FieldHelp title="Feedback summary">
                Based on thumbs-up / thumbs-down ratings on individual agent responses. Satisfaction
                rate = thumbs-up / total ratings.
              </FieldHelp>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {feedback.overall.total === 0 ? (
              <p className="text-muted-foreground text-sm">No feedback ratings in this period.</p>
            ) : (
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
            )}
            {feedback.byAgent.length > 0 && (
              <Table>
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
            {feedback.recentNegative.length > 0 && (
              <div data-testid="recent-negative">
                <h4 className="text-muted-foreground mb-2 text-sm font-medium">
                  Recent Negative Feedback
                </h4>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>User Asked</TableHead>
                      <TableHead>Agent Response</TableHead>
                      <TableHead>Date</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {feedback.recentNegative.slice(0, 10).map((n) => (
                      <TableRow key={n.messageId}>
                        <TableCell className="text-muted-foreground max-w-[300px] truncate">
                          {n.userMessage || '\u2014'}
                        </TableCell>
                        <TableCell className="max-w-[300px] truncate">{n.content}</TableCell>
                        <TableCell className="text-sm whitespace-nowrap">
                          {new Date(n.ratedAt).toLocaleDateString()}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Popular topics */}
        <Card data-testid="popular-topics">
          <CardHeader>
            <CardTitle className="flex items-center gap-1 text-base font-medium">
              Popular Topics
              <FieldHelp title="Popular topics">
                Most frequently asked user messages, grouped case-insensitively. Shows the top 15
                topics in the selected period.
              </FieldHelp>
            </CardTitle>
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
                  {topics.slice(0, 15).map((t) => (
                    <TableRow key={t.content}>
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
              <FieldHelp title="Content gaps">
                Topics where a high proportion of questions go unanswered, indicating missing
                knowledge base content. Based on the 500 most recent conversations in the selected
                period using heuristic phrase detection.
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
                    <TableHead className="text-right">Unanswered</TableHead>
                    <TableHead className="text-right">Gap Ratio</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {contentGaps.slice(0, 15).map((g) => (
                    <TableRow key={g.topic}>
                      <TableCell className="max-w-[300px] truncate">{g.topic}</TableCell>
                      <TableCell className="text-right">{g.queryCount}</TableCell>
                      <TableCell className="text-right">{g.unansweredCount}</TableCell>
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
            <FieldHelp title="Unanswered questions">
              Conversations where the assistant responded with hedging phrases like &quot;I
              don&apos;t know&quot;, &quot;I&apos;m not sure&quot;, or &quot;I cannot find&quot;.
              Uses exact phrase matching to detect uncertainty.
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
                  <TableRow key={u.messageId}>
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
