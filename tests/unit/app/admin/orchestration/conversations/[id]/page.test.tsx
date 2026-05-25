/**
 * Unit Test: Admin Conversation Detail page
 *
 * @see app/admin/orchestration/conversations/[id]/page.tsx
 *
 * Server component. Fetches the conversation + messages in parallel,
 * calls notFound() if the conversation isn't returned, otherwise
 * renders the trace viewer with a download-provenance button group.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  useSearchParams: () => ({ get: () => null }),
}));

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
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
import { serverFetch, parseApiResponse } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { notFound } from 'next/navigation';

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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ConversationDetailPage', () => {
  it('exports metadata with the conversation title', () => {
    expect(metadata.title).toBe('Conversation · AI Orchestration');
  });

  it('renders the title, tag chip, and trace viewer with messages on success', async () => {
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    // Two parallel fetches happen — the mock returns the conversation
    // then the messages.
    vi.mocked(parseApiResponse)
      .mockResolvedValueOnce({ success: true, data: conversationFixture })
      .mockResolvedValueOnce({ success: true, data: { messages: messagesFixture } });

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
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse)
      .mockResolvedValueOnce({
        success: true,
        data: { ...conversationFixture, title: null },
      })
      .mockResolvedValueOnce({ success: true, data: { messages: [] } });

    const ui = await ConversationDetailPage({ params: Promise.resolve({ id: CONV_ID }) });
    render(ui);

    expect(
      screen.getByRole('heading', { level: 1, name: /Untitled conversation/ })
    ).toBeInTheDocument();
  });

  it('calls notFound() when the conversation fetch returns not ok', async () => {
    vi.mocked(serverFetch).mockResolvedValue({ ok: false } as Response);

    await expect(
      ConversationDetailPage({ params: Promise.resolve({ id: CONV_ID }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(vi.mocked(notFound)).toHaveBeenCalled();
  });

  it('calls notFound() when the API response indicates failure', async () => {
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: false,
      error: { code: 'not_found', message: 'gone' },
    });

    await expect(
      ConversationDetailPage({ params: Promise.resolve({ id: CONV_ID }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('renders the Inbound channel card when the conversation has a channel set', async () => {
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse)
      .mockResolvedValueOnce({
        success: true,
        data: {
          ...conversationFixture,
          channel: 'whatsapp',
          provider: 'meta',
          fromAddress: '+447400123456',
          lastInboundAt: '2026-05-18T00:04:00Z',
          smsOptedOut: false,
        },
      })
      .mockResolvedValueOnce({ success: true, data: { messages: [] } });

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
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse)
      .mockResolvedValueOnce({
        success: true,
        data: {
          ...conversationFixture,
          channel: 'sms',
          provider: 'twilio',
          fromAddress: '+12025550100',
          lastInboundAt: '2026-05-18T00:04:00Z',
          smsOptedOut: true,
        },
      })
      .mockResolvedValueOnce({ success: true, data: { messages: [] } });

    const ui = await ConversationDetailPage({ params: Promise.resolve({ id: CONV_ID }) });
    render(ui);

    expect(screen.getByText(/Opted out \(STOP\)/)).toBeInTheDocument();
    expect(screen.getByText(/Outbound dispatches refused/)).toBeInTheDocument();
  });

  it('does NOT render the Inbound channel card when channel is missing (web/admin chat)', async () => {
    // Existing fixture has no channel field — verify the conditional omits the card.
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse)
      .mockResolvedValueOnce({ success: true, data: conversationFixture })
      .mockResolvedValueOnce({ success: true, data: { messages: [] } });

    const ui = await ConversationDetailPage({ params: Promise.resolve({ id: CONV_ID }) });
    render(ui);

    expect(screen.queryByText(/Inbound channel/)).not.toBeInTheDocument();
  });

  it('logs and treats the conversation as missing if its fetch throws', async () => {
    vi.mocked(serverFetch).mockImplementation((url: string) => {
      // First call (conversation): throw. Second call (messages): succeed.
      if (url.includes('messages')) {
        return Promise.resolve({ ok: true } as Response);
      }
      return Promise.reject(new Error('network down'));
    });
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: { messages: [] },
    });

    await expect(
      ConversationDetailPage({ params: Promise.resolve({ id: CONV_ID }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(vi.mocked(logger.error)).toHaveBeenCalled();
  });

  it('falls back to an empty messages array when the messages fetch fails', async () => {
    vi.mocked(serverFetch).mockImplementation((url: string) => {
      // Conversation: ok. Messages: not ok.
      if (url.includes('messages')) {
        return Promise.resolve({ ok: false } as Response);
      }
      return Promise.resolve({ ok: true } as Response);
    });
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: conversationFixture,
    });

    const ui = await ConversationDetailPage({ params: Promise.resolve({ id: CONV_ID }) });
    render(ui);

    const viewer = screen.getByTestId('trace-viewer');
    expect(viewer.getAttribute('data-message-count')).toBe('0');
  });

  it('logs and falls back to an empty messages array when the messages fetch throws', async () => {
    vi.mocked(serverFetch).mockImplementation((url: string) => {
      if (url.includes('messages')) {
        return Promise.reject(new Error('messages went sideways'));
      }
      return Promise.resolve({ ok: true } as Response);
    });
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: conversationFixture,
    });

    const ui = await ConversationDetailPage({ params: Promise.resolve({ id: CONV_ID }) });
    render(ui);

    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      'conversation detail page: messages fetch failed',
      expect.any(Error),
      expect.objectContaining({ id: CONV_ID })
    );
    expect(screen.getByTestId('trace-viewer').getAttribute('data-message-count')).toBe('0');
  });
});
