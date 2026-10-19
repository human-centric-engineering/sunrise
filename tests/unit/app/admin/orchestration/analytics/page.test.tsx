// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Only the network is faked: the real parseApiResponse and server-load run.
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
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
import { serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { API } from '@/lib/api/endpoints';
import { apiFailure, apiSuccess } from '@/tests/helpers/api';

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

/** Happy-path bodies by endpoint (the page fetches in parallel). */
const HAPPY_BODIES: Record<string, unknown> = {
  [API.ADMIN.ORCHESTRATION.ANALYTICS_ENGAGEMENT]: { metrics: mockEngagement },
  [API.ADMIN.ORCHESTRATION.ANALYTICS_TOPICS]: { topics: mockTopics },
  [API.ADMIN.ORCHESTRATION.ANALYTICS_UNANSWERED]: { questions: mockUnanswered },
  [API.ADMIN.ORCHESTRATION.ANALYTICS_FEEDBACK]: { feedback: mockFeedback },
  [API.ADMIN.ORCHESTRATION.ANALYTICS_CONTENT_GAPS]: { gaps: mockContentGaps },
  // Agents endpoint returns paginatedResponse, where `data` is the array itself
  // (not wrapped in an `{ agents: [...] }` envelope).
  [API.ADMIN.ORCHESTRATION.AGENTS]: mockAgents,
};

/**
 * Route each fetch by its endpoint (query string stripped). Endpoints named in
 * `failing` answer with the given failure; every other one succeeds.
 */
function setupFetch(failing: Record<string, () => Response | Promise<Response>> = {}) {
  vi.mocked(serverFetch).mockImplementation(async (path: string) => {
    const endpoint = path.split('?')[0];
    if (failing[endpoint]) return failing[endpoint]();
    return apiSuccess(HAPPY_BODIES[endpoint]);
  });
}

function setupHappyPath() {
  setupFetch();
}

function fetchedPaths(): string[] {
  return vi.mocked(serverFetch).mock.calls.map((call) => call[0]);
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
    expect(fetchedPaths()).toEqual(
      expect.arrayContaining([
        `${API.ADMIN.ORCHESTRATION.ANALYTICS_ENGAGEMENT}${expectedQuery}`,
        `${API.ADMIN.ORCHESTRATION.ANALYTICS_TOPICS}${expectedQuery}`,
        `${API.ADMIN.ORCHESTRATION.ANALYTICS_UNANSWERED}${expectedQuery}`,
        `${API.ADMIN.ORCHESTRATION.ANALYTICS_FEEDBACK}${expectedQuery}`,
        `${API.ADMIN.ORCHESTRATION.ANALYTICS_CONTENT_GAPS}${expectedQuery}`,
      ])
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

    expect(fetchedPaths()).toContain(API.ADMIN.ORCHESTRATION.AGENTS);
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

  // 4. A failed load is a failure, not an empty panel (#518) — but one panel's
  // failure never takes the page down.
  it.each([
    ['topics', API.ADMIN.ORCHESTRATION.ANALYTICS_TOPICS],
    ['unanswered', API.ADMIN.ORCHESTRATION.ANALYTICS_UNANSWERED],
    ['contentGaps', API.ADMIN.ORCHESTRATION.ANALYTICS_CONTENT_GAPS],
  ])(
    'renders the rest of the page and passes %s as null (the panel shows a notice) when it fails',
    async (prop, endpoint) => {
      setupFetch({ [endpoint]: () => apiFailure(500) });

      render(await AnalyticsPage({ searchParams: Promise.resolve({}) }));

      const props = getRenderedProps();
      expect(props[prop]).toBeNull();
      const others = {
        topics: mockTopics,
        unanswered: mockUnanswered,
        contentGaps: mockContentGaps,
      };
      for (const [key, value] of Object.entries(others)) {
        if (key !== prop) expect(props[key]).toEqual(value);
      }
      expect(props.feedback).toEqual(mockFeedback);
      expect(logger.error).toHaveBeenCalled();
    }
  );

  it('renders the page with every analytics panel null when every read rejects', async () => {
    const err = new Error('Network failure');
    vi.mocked(serverFetch).mockRejectedValue(err);

    render(await AnalyticsPage({ searchParams: Promise.resolve({}) }));

    const props = getRenderedProps();
    expect(props.topics).toBeNull();
    expect(props.unanswered).toBeNull();
    expect(props.contentGaps).toBeNull();
    expect(props.engagement).toBeNull();
    expect(props.feedback).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), err, expect.any(Object));
  });

  it('shows a notice in place of the feedback summary when it fails, and passes no feedback', async () => {
    setupFetch({ [API.ADMIN.ORCHESTRATION.ANALYTICS_FEEDBACK]: () => apiFailure(500) });

    render(await AnalyticsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load the feedback summary");
    expect(getRenderedProps().feedback).toBeNull();
    // The rest of the page still renders its data.
    expect(getRenderedProps().topics).toEqual(mockTopics);
  });

  it('shows a notice when the agent filter options fail, and passes no options', async () => {
    setupFetch({ [API.ADMIN.ORCHESTRATION.AGENTS]: () => apiFailure(500) });

    render(await AnalyticsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load the agent filter options");
    expect(getRenderedProps().agents).toEqual([]);
  });

  it('passes null engagement (shown as "—") without a notice when engagement fails', async () => {
    setupFetch({ [API.ADMIN.ORCHESTRATION.ANALYTICS_ENGAGEMENT]: () => apiFailure(500) });

    render(await AnalyticsPage({ searchParams: Promise.resolve({}) }));

    expect(getRenderedProps().engagement).toBeNull();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('passes real empty lists through as empty, with no notice', async () => {
    vi.mocked(serverFetch).mockImplementation(async (path: string) => {
      const endpoint = path.split('?')[0];
      const empty: Record<string, unknown> = {
        [API.ADMIN.ORCHESTRATION.ANALYTICS_TOPICS]: { topics: [] },
        [API.ADMIN.ORCHESTRATION.ANALYTICS_UNANSWERED]: { questions: [] },
        [API.ADMIN.ORCHESTRATION.ANALYTICS_CONTENT_GAPS]: { gaps: [] },
      };
      return apiSuccess(empty[endpoint] ?? HAPPY_BODIES[endpoint]);
    });

    render(await AnalyticsPage({ searchParams: Promise.resolve({}) }));

    const props = getRenderedProps();
    expect(props.topics).toEqual([]);
    expect(props.unanswered).toEqual([]);
    expect(props.contentGaps).toEqual([]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // 7. filters fallback — omitted searchParams use getAnalyticsDefaultDateInputs()
  it('passes default date inputs to filters when searchParams omits from/to/agentId', async () => {
    setupHappyPath();

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
    setupHappyPath();

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
    setupHappyPath();

    const searchParams = Promise.resolve({});
    render(await AnalyticsPage({ searchParams }));

    expect(screen.getByRole('heading', { level: 1, name: 'Analytics' })).toBeInTheDocument();
  });

  it('renders the subtitle text', async () => {
    setupHappyPath();

    const searchParams = Promise.resolve({});
    render(await AnalyticsPage({ searchParams }));

    expect(
      screen.getByText(
        'Usage patterns, popular topics, feedback, and content gaps across your agents.'
      )
    ).toBeInTheDocument();
  });
});
