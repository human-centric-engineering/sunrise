// @vitest-environment happy-dom

/**
 * Integration Test: Admin Orchestration — Conversation Detail Page
 *
 * Tests the server component at
 * `app/admin/orchestration/conversations/[id]/page.tsx`.
 *
 * Test coverage:
 * - Happy path: renders conversation title as heading, breadcrumb
 * - notFound() called on a 404, and only on a 404: a 500 throws to the
 *   error boundary instead of reading as a missing conversation (#518)
 *
 * @see app/admin/orchestration/conversations/[id]/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { apiFailure, apiSuccess } from '@/tests/helpers/api';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Only the network is faked: the real parseApiResponse and server-load run.
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    withContext: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    })),
  },
}));

const mockNotFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});

vi.mock('next/navigation', () => ({
  notFound: mockNotFound,
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/'),

  useSearchParams: () => ({ get: () => null }),
}));

// next/link is used by the page — keep real implementation
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

// ConversationTraceViewer is a client component; stub it out
vi.mock('@/components/admin/orchestration/conversation-trace-viewer', () => ({
  ConversationTraceViewer: () => <div data-testid="trace-viewer" />,
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CONV_ID = 'cmjbv4i3x00003wsloputgwu3';
const AGENT_ID = 'cmjbv4i3x00003wsloputgwu2';

const MOCK_CONVERSATION = {
  id: CONV_ID,
  title: 'My Test Conversation',
  agentId: AGENT_ID,
  isActive: true,
  createdAt: '2025-01-01T10:00:00.000Z',
  updatedAt: '2025-01-01T10:05:00.000Z',
  agent: { id: AGENT_ID, name: 'Test Agent', slug: 'test-agent' },
  _count: { messages: 3 },
};

const MOCK_MESSAGES = [
  {
    id: 'msg-1',
    role: 'user',
    content: 'Hello',
    capabilitySlug: null,
    toolCallId: null,
    metadata: null,
    createdAt: '2025-01-01T10:00:00.000Z',
  },
];

/** Route the page's two parallel fetches: the conversation, then its messages. */
async function route(conversation: Response, messages: Response) {
  const { serverFetch } = await import('@/lib/api/server-fetch');
  vi.mocked(serverFetch).mockImplementation(async (url: string) =>
    url.includes('messages') ? messages : conversation
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ConversationDetailPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders conversation title as heading', async () => {
    await route(apiSuccess(MOCK_CONVERSATION), apiSuccess({ messages: MOCK_MESSAGES }));

    const { default: ConversationDetailPage } =
      await import('@/app/admin/orchestration/conversations/[id]/page');

    render(await ConversationDetailPage({ params: Promise.resolve({ id: CONV_ID }) }));

    expect(screen.getByRole('heading', { name: /My Test Conversation/i })).toBeInTheDocument();
  });

  it('shows "AI Orchestration" breadcrumb link', async () => {
    await route(apiSuccess(MOCK_CONVERSATION), apiSuccess({ messages: MOCK_MESSAGES }));

    const { default: ConversationDetailPage } =
      await import('@/app/admin/orchestration/conversations/[id]/page');

    render(await ConversationDetailPage({ params: Promise.resolve({ id: CONV_ID }) }));

    const breadcrumbLink = screen.getByRole('link', { name: /AI Orchestration/i });
    expect(breadcrumbLink).toBeInTheDocument();
    expect(breadcrumbLink).toHaveAttribute('href', '/admin/orchestration');
  });

  it('renders the ConversationTraceViewer', async () => {
    await route(apiSuccess(MOCK_CONVERSATION), apiSuccess({ messages: MOCK_MESSAGES }));

    const { default: ConversationDetailPage } =
      await import('@/app/admin/orchestration/conversations/[id]/page');

    render(await ConversationDetailPage({ params: Promise.resolve({ id: CONV_ID }) }));

    expect(screen.getByTestId('trace-viewer')).toBeInTheDocument();
  });

  it('calls notFound() when the conversation does not exist', async () => {
    await route(apiFailure(404, 'NOT_FOUND'), apiFailure(404, 'NOT_FOUND'));

    const { default: ConversationDetailPage } =
      await import('@/app/admin/orchestration/conversations/[id]/page');

    await expect(
      ConversationDetailPage({ params: Promise.resolve({ id: CONV_ID }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');

    expect(mockNotFound).toHaveBeenCalled();
  });

  it('throws to the error boundary, not notFound(), when the load fails', async () => {
    await route(apiFailure(500), apiSuccess({ messages: MOCK_MESSAGES }));
    const { ServerLoadError } = await import('@/lib/api/server-load');

    const { default: ConversationDetailPage } =
      await import('@/app/admin/orchestration/conversations/[id]/page');

    await expect(
      ConversationDetailPage({ params: Promise.resolve({ id: CONV_ID }) })
    ).rejects.toBeInstanceOf(ServerLoadError);
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it('shows "Untitled conversation" as heading when title is null', async () => {
    await route(apiSuccess({ ...MOCK_CONVERSATION, title: null }), apiSuccess({ messages: [] }));

    const { default: ConversationDetailPage } =
      await import('@/app/admin/orchestration/conversations/[id]/page');

    render(await ConversationDetailPage({ params: Promise.resolve({ id: CONV_ID }) }));

    expect(screen.getByRole('heading', { name: /Untitled conversation/i })).toBeInTheDocument();
  });
});
