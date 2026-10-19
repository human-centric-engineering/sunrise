// @vitest-environment happy-dom

/**
 * Unit Test: Admin Conversation Detail page
 *
 * @see app/admin/orchestration/conversations/[id]/page.tsx
 *
 * Server component. Fetches the conversation + messages in parallel,
 * calls notFound() only on a 404, throws to the error boundary on any
 * other failure (#518), otherwise renders the trace viewer with a
 * download-provenance button group.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  unstable_rethrow: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  useSearchParams: () => ({ get: () => null }),
}));

// Only the network is faked: the real parseApiResponse and server-load run.
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/components/admin/orchestration/conversation-tags', () => ({
  ConversationTags: ({
    conversationId,
    initialTags,
  }: {
    conversationId: string;
    initialTags: string[];
  }) => (
    <div
      data-testid="conversation-tags"
      data-id={conversationId}
      data-tags={initialTags.join(',')}
    />
  ),
}));

vi.mock('@/components/admin/orchestration/conversation-trace-viewer', () => ({
  ConversationTraceViewer: ({
    messages,
    conversationId,
  }: {
    messages: unknown[];
    conversationId?: string;
  }) => (
    <div
      data-testid="trace-viewer"
      data-message-count={messages.length}
      data-conversation-id={conversationId ?? ''}
    />
  ),
}));

vi.mock('@/components/ui/field-help', () => ({
  FieldHelp: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import React from 'react';
import ConversationDetailPage, {
  metadata,
} from '@/app/admin/orchestration/conversations/[id]/page';
import { serverFetch } from '@/lib/api/server-fetch';
import { ServerLoadError } from '@/lib/api/server-load';
import { logger } from '@/lib/logging';
import { notFound } from 'next/navigation';
import { apiFailure, apiSuccess } from '@/tests/helpers/api';

const CONV_ID = 'cmjbv4i3x00003wsloputgwu3';

const conversationFixture = {
  id: CONV_ID,
  title: 'Refund discussion',
  agentId: 'agent-1',
  isActive: true,
  tags: ['support', 'urgent'],
  createdAt: '2026-05-18T00:00:00Z',
  updatedAt: '2026-05-18T00:05:00Z',
  agent: { id: 'agent-1', name: 'Support Agent', slug: 'support' },
  _count: { messages: 2 },
};

const messagesFixture = [
  { id: 'm1', role: 'user', content: 'Help', provenance: null },
  { id: 'm2', role: 'assistant', content: 'Sure', provenance: null },
];

type Answer = Response | Error;

/** Route the two parallel fetches; an `Error` makes serverFetch reject. */
function route(conversation: Answer, messages: Answer = apiSuccess({ messages: [] })) {
  vi.mocked(serverFetch).mockImplementation((url: string) => {
    const answer = url.includes('messages') ? messages : conversation;
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ConversationDetailPage', () => {
  it('exports metadata with the conversation title', () => {
    expect(metadata.title).toBe('Conversation · AI Orchestration');
  });

  it('renders the title, tag chip, and trace viewer with messages on success', async () => {
    route(apiSuccess(conversationFixture), apiSuccess({ messages: messagesFixture }));

    const ui = await ConversationDetailPage({ params: Promise.resolve({ id: CONV_ID }) });
    render(ui);

    expect(
      screen.getByRole('heading', { level: 1, name: /Refund discussion/ })
    ).toBeInTheDocument();
    const viewer = screen.getByTestId('trace-viewer');
    expect(viewer.getAttribute('data-message-count')).toBe('2');
    expect(viewer.getAttribute('data-conversation-id')).toBe(CONV_ID);
    expect(screen.getByTestId('conversation-tags').getAttribute('data-tags')).toBe(
      'support,urgent'
    );
  });

  it('renders "Untitled" placeholder when the conversation has no title', async () => {
    route(apiSuccess({ ...conversationFixture, title: null }));

    const ui = await ConversationDetailPage({ params: Promise.resolve({ id: CONV_ID }) });
    render(ui);

    expect(
      screen.getByRole('heading', { level: 1, name: /Untitled conversation/ })
    ).toBeInTheDocument();
  });

  it('calls notFound() when the conversation does not exist (404)', async () => {
    route(apiFailure(404, 'NOT_FOUND'), apiFailure(404, 'NOT_FOUND'));

    await expect(
      ConversationDetailPage({ params: Promise.resolve({ id: CONV_ID }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(vi.mocked(notFound)).toHaveBeenCalled();
  });

  it('throws to the error boundary, not notFound(), when the conversation load fails', async () => {
    route(apiFailure(500));

    await expect(
      ConversationDetailPage({ params: Promise.resolve({ id: CONV_ID }) })
    ).rejects.toBeInstanceOf(ServerLoadError);
    expect(vi.mocked(notFound)).not.toHaveBeenCalled();
  });

  it('throws when the API answers success:false', async () => {
    route(apiFailure(200));

    await expect(
      ConversationDetailPage({ params: Promise.resolve({ id: CONV_ID }) })
    ).rejects.toBeInstanceOf(ServerLoadError);
    expect(vi.mocked(notFound)).not.toHaveBeenCalled();
  });

  it('renders the Inbound channel card when the conversation has a channel set', async () => {
    route(
      apiSuccess({
        ...conversationFixture,
        channel: 'whatsapp',
        provider: 'meta',
        fromAddress: '+447400123456',
        lastInboundAt: '2026-05-18T00:04:00Z',
        smsOptedOut: false,
      })
    );

    const ui = await ConversationDetailPage({ params: Promise.resolve({ id: CONV_ID }) });
    render(ui);

    // The card heading renders with the help-popover label.
    expect(screen.getByText(/Inbound channel/)).toBeInTheDocument();
    // The field grid shows channel + provider + fromAddress.
    expect(screen.getByText('whatsapp')).toBeInTheDocument();
    expect(screen.getByText('meta')).toBeInTheDocument();
    expect(screen.getByText('+447400123456')).toBeInTheDocument();
    // Not opted out → no STOP callout.
    expect(screen.queryByText(/Opted out/)).not.toBeInTheDocument();
  });

  it('renders the "Opted out (STOP)" callout when smsOptedOut is true', async () => {
    route(
      apiSuccess({
        ...conversationFixture,
        channel: 'sms',
        provider: 'twilio',
        fromAddress: '+12025550100',
        lastInboundAt: '2026-05-18T00:04:00Z',
        smsOptedOut: true,
      })
    );

    const ui = await ConversationDetailPage({ params: Promise.resolve({ id: CONV_ID }) });
    render(ui);

    expect(screen.getByText(/Opted out \(STOP\)/)).toBeInTheDocument();
    expect(screen.getByText(/Outbound dispatches refused/)).toBeInTheDocument();
  });

  it('does NOT render the Inbound channel card when channel is missing (web/admin chat)', async () => {
    // Existing fixture has no channel field — verify the conditional omits the card.
    route(apiSuccess(conversationFixture));

    const ui = await ConversationDetailPage({ params: Promise.resolve({ id: CONV_ID }) });
    render(ui);

    expect(screen.queryByText(/Inbound channel/)).not.toBeInTheDocument();
  });

  it('logs and throws, not notFound(), if the conversation fetch rejects', async () => {
    const err = new Error('network down');
    route(err);

    await expect(
      ConversationDetailPage({ params: Promise.resolve({ id: CONV_ID }) })
    ).rejects.toBeInstanceOf(ServerLoadError);
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.any(String),
      err,
      expect.any(Object)
    );
    expect(vi.mocked(notFound)).not.toHaveBeenCalled();
  });

  it('throws rather than showing an empty trace when the messages load fails', async () => {
    route(apiSuccess(conversationFixture), apiFailure(500));

    await expect(
      ConversationDetailPage({ params: Promise.resolve({ id: CONV_ID }) })
    ).rejects.toBeInstanceOf(ServerLoadError);
  });

  it('logs and throws when the messages fetch rejects', async () => {
    const err = new Error('messages went sideways');
    route(apiSuccess(conversationFixture), err);

    await expect(
      ConversationDetailPage({ params: Promise.resolve({ id: CONV_ID }) })
    ).rejects.toBeInstanceOf(ServerLoadError);
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.any(String),
      err,
      expect.objectContaining({ path: expect.stringContaining(CONV_ID) })
    );
  });

  it('renders a real empty message list as an empty trace', async () => {
    route(apiSuccess(conversationFixture), apiSuccess({ messages: [] }));

    render(await ConversationDetailPage({ params: Promise.resolve({ id: CONV_ID }) }));

    expect(screen.getByTestId('trace-viewer').getAttribute('data-message-count')).toBe('0');
  });
});
