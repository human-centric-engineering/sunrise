/**
 * Integration Test: Admin Orchestration — Conversation Detail Page
 *
 * Tests the server component at
 * `app/admin/orchestration/conversations/[id]/page.tsx`.
 *
 * Test coverage:
 * - Happy path: renders conversation title as heading, breadcrumb
 * - notFound() called when conversation fetch returns null
 *
 * @see app/admin/orchestration/conversations/[id]/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/auth/utils', () => ({
  getServerSession: vi.fn(),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiConversation: {
      findFirst: vi.fn(),
    },
    aiMessage: {
      findMany: vi.fn(),
    },
  },
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

const MOCK_CONVERSATION_ROW = {
  id: CONV_ID,
  title: 'My Test Conversation',
  agentId: AGENT_ID,
  userId: 'test-user-id',
  isActive: true,
  createdAt: new Date('2025-01-01T10:00:00.000Z'),
  updatedAt: new Date('2025-01-01T10:05:00.000Z'),
  agent: { id: AGENT_ID, name: 'Test Agent', slug: 'test-agent' },
  _count: { messages: 3 },
};

const MOCK_MESSAGE_ROWS = [
  {
    id: 'msg-1',
    role: 'user',
    content: 'Hello',
    capabilitySlug: null,
    toolCallId: null,
    metadata: null,
    conversationId: CONV_ID,
    createdAt: new Date('2025-01-01T10:00:00.000Z'),
  },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ConversationDetailPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders conversation title as heading', async () => {
    const { getServerSession } = await import('@/lib/auth/utils');
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: 'test-user-id', role: 'ADMIN' },
    } as any);
    vi.mocked(prisma.aiConversation.findFirst).mockResolvedValue(MOCK_CONVERSATION_ROW as any);
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValue(MOCK_MESSAGE_ROWS as any);

    const { default: ConversationDetailPage } =
      await import('@/app/admin/orchestration/conversations/[id]/page');

    render(await ConversationDetailPage({ params: Promise.resolve({ id: CONV_ID }) }));

    expect(screen.getByRole('heading', { name: /My Test Conversation/i })).toBeInTheDocument();
  });

  it('shows "AI Orchestration" breadcrumb link', async () => {
    const { getServerSession } = await import('@/lib/auth/utils');
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: 'test-user-id', role: 'ADMIN' },
    } as any);
    vi.mocked(prisma.aiConversation.findFirst).mockResolvedValue(MOCK_CONVERSATION_ROW as any);
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValue(MOCK_MESSAGE_ROWS as any);

    const { default: ConversationDetailPage } =
      await import('@/app/admin/orchestration/conversations/[id]/page');

    render(await ConversationDetailPage({ params: Promise.resolve({ id: CONV_ID }) }));

    const breadcrumbLink = screen.getByRole('link', { name: /AI Orchestration/i });
    expect(breadcrumbLink).toBeInTheDocument();
    expect(breadcrumbLink).toHaveAttribute('href', '/admin/orchestration');
  });

  it('renders the ConversationTraceViewer', async () => {
    const { getServerSession } = await import('@/lib/auth/utils');
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: 'test-user-id', role: 'ADMIN' },
    } as any);
    vi.mocked(prisma.aiConversation.findFirst).mockResolvedValue(MOCK_CONVERSATION_ROW as any);
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValue(MOCK_MESSAGE_ROWS as any);

    const { default: ConversationDetailPage } =
      await import('@/app/admin/orchestration/conversations/[id]/page');

    render(await ConversationDetailPage({ params: Promise.resolve({ id: CONV_ID }) }));

    expect(screen.getByTestId('trace-viewer')).toBeInTheDocument();
  });

  it('calls notFound() when conversation fetch returns null', async () => {
    const { getServerSession } = await import('@/lib/auth/utils');
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: 'test-user-id', role: 'ADMIN' },
    } as any);
    vi.mocked(prisma.aiConversation.findFirst).mockResolvedValue(null);

    const { default: ConversationDetailPage } =
      await import('@/app/admin/orchestration/conversations/[id]/page');

    await expect(
      ConversationDetailPage({ params: Promise.resolve({ id: CONV_ID }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');

    expect(mockNotFound).toHaveBeenCalledOnce();
  });

  it('shows "Untitled conversation" as heading when title is null', async () => {
    const { getServerSession } = await import('@/lib/auth/utils');
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: 'test-user-id', role: 'ADMIN' },
    } as any);
    vi.mocked(prisma.aiConversation.findFirst).mockResolvedValue({
      ...MOCK_CONVERSATION_ROW,
      title: null,
    } as any);
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([]);

    const { default: ConversationDetailPage } =
      await import('@/app/admin/orchestration/conversations/[id]/page');

    render(await ConversationDetailPage({ params: Promise.resolve({ id: CONV_ID }) }));

    expect(screen.getByRole('heading', { name: /Untitled conversation/i })).toBeInTheDocument();
  });
});
