import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/orchestration/analytics/date-range', () => ({
  getAnalyticsDefaultDateInputs: vi.fn(() => ({ from: '2026-03-24', to: '2026-04-23' })),
}));

vi.mock('@/components/admin/orchestration/analytics/analytics-view', () => ({
  AnalyticsView: (props: Record<string, unknown>) => (
    <div data-testid="analytics-view" data-props={JSON.stringify(props)} />
  ),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import AnalyticsPage, { metadata } from '@/app/admin/orchestration/analytics/page';
import { serverFetch, parseApiResponse } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { API } from '@/lib/api/endpoints';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockEngagement = { totalSessions: 100, avgSessionLength: 4.2, totalMessages: 500 };
const mockTopics = [{ topic: 'billing', count: 42 }];
const mockUnanswered = [{ question: 'how do I cancel?', count: 10 }];
const mockFeedback = { thumbsUp: 80, thumbsDown: 20, avgRating: 4.0 };
const mockContentGaps = [{ gap: 'refund policy', count: 15 }];
const mockAgents = [
  { id: 'agent-1', name: 'Support Bot' },
  { id: 'agent-2', name: 'Sales Bot' },
];

/** Build a fake Response with ok=true for the parseApiResponse mock chain. */
function okResponse(): Response {
  return { ok: true } as Response;
}

function notOkResponse(): Response {
  return { ok: false } as Response;
}

/**
 * Set up serverFetch to return ok responses in Promise.all order:
 * engagement, topics, unanswered, feedback, content-gaps, agents.
 */
function setupHappyPath() {
  vi.mocked(serverFetch).mockResolvedValue(okResponse());
  vi.mocked(parseApiResponse)
    .mockResolvedValueOnce({ success: true, data: { metrics: mockEngagement } } as never)
    .mockResolvedValueOnce({ success: true, data: { topics: mockTopics } } as never)
    .mockResolvedValueOnce({ success: true, data: { questions: mockUnanswered } } as never)
    .mockResolvedValueOnce({ success: true, data: { feedback: mockFeedback } } as never)
    .mockResolvedValueOnce({ success: true, data: { gaps: mockContentGaps } } as never)
    .mockResolvedValueOnce({
      success: true,
      data: { agents: mockAgents },
    } as never);
}

// ---------------------------------------------------------------------------
// Helpers to parse props from the analytics-view stub
// ---------------------------------------------------------------------------

function getRenderedProps() {
  const el = screen.getByTestId('analytics-view');
  return JSON.parse(el.getAttribute('data-props') ?? '{}');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnalyticsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 1. Metadata
  it('has the correct title metadata', () => {
    expect(metadata.title).toBe('Analytics · AI Orchestration');
  });

  it('has the correct description metadata', () => {
    expect(metadata.description).toBe(
      'Usage analytics, popular topics, feedback, and content gaps.'
    );
  });

  // 2. serverFetch called with correct endpoints
  it('calls serverFetch with analytics endpoints carrying query string params', async () => {
    setupHappyPath();
    const searchParams = Promise.resolve({
      from: '2026-01-01',
      to: '2026-01-31',
      agentId: 'agent-123',
    });

    await AnalyticsPage({ searchParams });

    const expectedQuery = '?from=2026-01-01&to=2026-01-31&agentId=agent-123';
    expect(serverFetch).toHaveBeenCalledWith(
      `${API.ADMIN.ORCHESTRATION.ANALYTICS_ENGAGEMENT}${expectedQuery}`
    );
    expect(serverFetch).toHaveBeenCalledWith(
      `${API.ADMIN.ORCHESTRATION.ANALYTICS_TOPICS}${expectedQuery}`
    );
    expect(serverFetch).toHaveBeenCalledWith(
      `${API.ADMIN.ORCHESTRATION.ANALYTICS_UNANSWERED}${expectedQuery}`
    );
    expect(serverFetch).toHaveBeenCalledWith(
      `${API.ADMIN.ORCHESTRATION.ANALYTICS_FEEDBACK}${expectedQuery}`
    );
    expect(serverFetch).toHaveBeenCalledWith(
      `${API.ADMIN.ORCHESTRATION.ANALYTICS_CONTENT_GAPS}${expectedQuery}`
    );
  });

  it('calls the agents endpoint WITHOUT a query string', async () => {
    setupHappyPath();
    const searchParams = Promise.resolve({
      from: '2026-01-01',
      to: '2026-01-31',
      agentId: 'agent-123',
    });

    await AnalyticsPage({ searchParams });

    expect(serverFetch).toHaveBeenCalledWith(API.ADMIN.ORCHESTRATION.AGENTS);
  });

  // 3. Happy path — all fetchers succeed
  it('passes all data props to AnalyticsView when all fetchers succeed', async () => {
    setupHappyPath();
    const searchParams = Promise.resolve({
      from: '2026-01-01',
      to: '2026-01-31',
      agentId: 'agent-123',
    });

    render(await AnalyticsPage({ searchParams }));

    const props = getRenderedProps();
    expect(props.engagement).toEqual(mockEngagement);
    expect(props.topics).toEqual(mockTopics);
    expect(props.unanswered).toEqual(mockUnanswered);
    expect(props.feedback).toEqual(mockFeedback);
    expect(props.contentGaps).toEqual(mockContentGaps);
    expect(props.agents).toEqual(mockAgents);
  });

  // 4. res.ok === false path
  it('passes null for analytics props and [] for agents when res.ok is false', async () => {
    vi.mocked(serverFetch).mockResolvedValue(notOkResponse());

    const searchParams = Promise.resolve({});
    render(await AnalyticsPage({ searchParams }));

    const props = getRenderedProps();
    expect(props.engagement).toBeNull();
    expect(props.topics).toBeNull();
    expect(props.unanswered).toBeNull();
    expect(props.feedback).toBeNull();
    expect(props.contentGaps).toBeNull();
    expect(props.agents).toEqual([]);
  });

  // 5. body.success === false path
  it('passes null for analytics props and [] for agents when body.success is false', async () => {
    vi.mocked(serverFetch).mockResolvedValue(okResponse());
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'fail' },
    } as never);

    const searchParams = Promise.resolve({});
    render(await AnalyticsPage({ searchParams }));

    const props = getRenderedProps();
    expect(props.engagement).toBeNull();
    expect(props.topics).toBeNull();
    expect(props.unanswered).toBeNull();
    expect(props.feedback).toBeNull();
    expect(props.contentGaps).toBeNull();
    expect(props.agents).toEqual([]);
  });

  // 6. serverFetch throws — each fetcher logs and falls back
  it('logs the correct error message for each fetcher when serverFetch throws', async () => {
    const err = new Error('Network failure');
    vi.mocked(serverFetch).mockRejectedValue(err);

    const searchParams = Promise.resolve({});
    render(await AnalyticsPage({ searchParams }));

    expect(logger.error).toHaveBeenCalledWith('analytics page: failed to load engagement', err);
    expect(logger.error).toHaveBeenCalledWith('analytics page: failed to load topics', err);
    expect(logger.error).toHaveBeenCalledWith('analytics page: failed to load unanswered', err);
    expect(logger.error).toHaveBeenCalledWith('analytics page: failed to load feedback', err);
    expect(logger.error).toHaveBeenCalledWith('analytics page: failed to load content gaps', err);
    expect(logger.error).toHaveBeenCalledWith('analytics page: failed to load agents', err);
  });

  it('falls back to null/[] for all props when serverFetch throws', async () => {
    vi.mocked(serverFetch).mockRejectedValue(new Error('Network failure'));

    const searchParams = Promise.resolve({});
    render(await AnalyticsPage({ searchParams }));

    const props = getRenderedProps();
    expect(props.engagement).toBeNull();
    expect(props.topics).toBeNull();
    expect(props.unanswered).toBeNull();
    expect(props.feedback).toBeNull();
    expect(props.contentGaps).toBeNull();
    expect(props.agents).toEqual([]);
  });

  // 7. filters fallback — omitted searchParams use getAnalyticsDefaultDateInputs()
  it('passes default date inputs to filters when searchParams omits from/to/agentId', async () => {
    vi.mocked(serverFetch).mockResolvedValue(notOkResponse());

    const searchParams = Promise.resolve({});
    render(await AnalyticsPage({ searchParams }));

    const props = getRenderedProps();
    expect(props.filters).toEqual({
      from: '2026-03-24',
      to: '2026-04-23',
      agentId: '',
    });
  });

  // 8. filters forwarding — supplied searchParams are passed verbatim
  it('forwards supplied from/to/agentId values verbatim to filters', async () => {
    vi.mocked(serverFetch).mockResolvedValue(notOkResponse());

    const searchParams = Promise.resolve({
      from: '2026-01-01',
      to: '2026-01-31',
      agentId: 'agent-123',
    });
    render(await AnalyticsPage({ searchParams }));

    const props = getRenderedProps();
    expect(props.filters).toEqual({
      from: '2026-01-01',
      to: '2026-01-31',
      agentId: 'agent-123',
    });
  });

  // 9. Heading and subtitle
  it('renders the <h1>Analytics</h1> heading', async () => {
    vi.mocked(serverFetch).mockResolvedValue(notOkResponse());

    const searchParams = Promise.resolve({});
    render(await AnalyticsPage({ searchParams }));

    expect(screen.getByRole('heading', { level: 1, name: 'Analytics' })).toBeInTheDocument();
  });

  it('renders the subtitle text', async () => {
    vi.mocked(serverFetch).mockResolvedValue(notOkResponse());

    const searchParams = Promise.resolve({});
    render(await AnalyticsPage({ searchParams }));

    expect(
      screen.getByText(
        'Usage patterns, popular topics, feedback, and content gaps across your agents.'
      )
    ).toBeInTheDocument();
  });
});
