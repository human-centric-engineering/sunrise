/**
 * Integration Test: Admin Orchestration — Conversation Detail Page
 *
 * Tests the server component at
 * `app/admin/orchestration/conversations/[id]/page.tsx`.
 *
 * Test coverage:
 * - Happy path: renders conversation title as heading, breadcrumb
 * - notFound() called when conversation fetch returns non-ok
 *
 * @see app/admin/orchestration/conversations/[id]/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ConversationDetailPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders conversation title as heading', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse)
      .mockResolvedValueOnce({ success: true, data: MOCK_CONVERSATION })
      .mockResolvedValueOnce({ success: true, data: { messages: MOCK_MESSAGES } });

    const { default: ConversationDetailPage } =
      await import('@/app/admin/orchestration/conversations/[id]/page');

    render(await ConversationDetailPage({ params: Promise.resolve({ id: CONV_ID }) }));

    expect(screen.getByRole('heading', { name: /My Test Conversation/i })).toBeInTheDocument();
  });

  it('shows "AI Orchestration" breadcrumb link', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse)
      .mockResolvedValueOnce({ success: true, data: MOCK_CONVERSATION })
      .mockResolvedValueOnce({ success: true, data: { messages: MOCK_MESSAGES } });

    const { default: ConversationDetailPage } =
      await import('@/app/admin/orchestration/conversations/[id]/page');

    render(await ConversationDetailPage({ params: Promise.resolve({ id: CONV_ID }) }));

    const breadcrumbLink = screen.getByRole('link', { name: /AI Orchestration/i });
    expect(breadcrumbLink).toBeInTheDocument();
    expect(breadcrumbLink).toHaveAttribute('href', '/admin/orchestration');
  });

  it('renders the ConversationTraceViewer', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse)
      .mockResolvedValueOnce({ success: true, data: MOCK_CONVERSATION })
      .mockResolvedValueOnce({ success: true, data: { messages: MOCK_MESSAGES } });

    const { default: ConversationDetailPage } =
      await import('@/app/admin/orchestration/conversations/[id]/page');

    render(await ConversationDetailPage({ params: Promise.resolve({ id: CONV_ID }) }));

    expect(screen.getByTestId('trace-viewer')).toBeInTheDocument();
  });

  it('calls notFound() when conversation fetch returns non-ok', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: false, status: 404 } as Response);

    const { default: ConversationDetailPage } =
      await import('@/app/admin/orchestration/conversations/[id]/page');

    await expect(
      ConversationDetailPage({ params: Promise.resolve({ id: CONV_ID }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');

    expect(mockNotFound).toHaveBeenCalledOnce();
  });

  it('shows "Untitled conversation" as heading when title is null', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse)
      .mockResolvedValueOnce({
        success: true,
        data: { ...MOCK_CONVERSATION, title: null },
      })
      .mockResolvedValueOnce({ success: true, data: { messages: [] } });

    const { default: ConversationDetailPage } =
      await import('@/app/admin/orchestration/conversations/[id]/page');

    render(await ConversationDetailPage({ params: Promise.resolve({ id: CONV_ID }) }));

    expect(screen.getByRole('heading', { name: /Untitled conversation/i })).toBeInTheDocument();
  });
});
