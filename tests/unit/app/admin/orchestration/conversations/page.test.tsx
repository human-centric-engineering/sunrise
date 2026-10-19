// @vitest-environment happy-dom

/**
 * Unit Tests: ConversationsListPage (app/admin/orchestration/conversations/page.tsx)
 *
 * - a failed conversations load (5xx, success:false, no response) throws to
 *   the error boundary instead of rendering an empty table (#518)
 * - a failed agent-filter load shows a "Couldn't load" notice and the table
 *   still renders, with no filter options
 * - happy path → conversations, meta and agents forwarded to the table
 * - an empty list is rendered as an empty list
 *
 * @see app/admin/orchestration/conversations/page.tsx
 */

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

vi.mock('@/components/admin/orchestration/conversations-table', () => ({
  ConversationsTable: (props: {
    initialConversations: unknown[];
    initialMeta: { total: number };
    agents: unknown[];
  }) => (
    <div
      data-testid="conversations-table"
      data-count={String(props.initialConversations.length)}
      data-total={String(props.initialMeta.total)}
      data-agents={String(props.agents.length)}
    />
  ),
}));

vi.mock('@/components/ui/field-help', () => ({
  FieldHelp: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import ConversationsListPage from '@/app/admin/orchestration/conversations/page';
import { serverFetch } from '@/lib/api/server-fetch';
import { ServerLoadError } from '@/lib/api/server-load';
import { logger } from '@/lib/logging';
import { API } from '@/lib/api/endpoints';
import { apiFailure, apiSuccess } from '@/tests/helpers/api';

const META = { page: 1, limit: 25, total: 2, totalPages: 1 };
const AGENTS = [
  { id: 'ag-1', name: 'Support Bot' },
  { id: 'ag-2', name: 'Sales Bot' },
];

/** Route the two parallel reads; either can be replaced. */
function answer(
  overrides: { conversations?: () => Promise<Response>; agents?: () => Promise<Response> } = {}
) {
  vi.mocked(serverFetch).mockImplementation(async (url: string) => {
    if (url.startsWith(API.ADMIN.ORCHESTRATION.AGENTS)) {
      return overrides.agents ? overrides.agents() : apiSuccess(AGENTS);
    }
    return overrides.conversations
      ? overrides.conversations()
      : apiSuccess([{ id: 'c-1' }, { id: 'c-2' }], META);
  });
}

describe('ConversationsListPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws to the error boundary when the conversations API answers 500', async () => {
    answer({ conversations: async () => apiFailure(500) });

    await expect(ConversationsListPage()).rejects.toBeInstanceOf(ServerLoadError);
    expect(logger.error).toHaveBeenCalled();
  });

  it('throws when the conversations API answers success:false', async () => {
    answer({ conversations: async () => apiFailure(200) });

    await expect(ConversationsListPage()).rejects.toBeInstanceOf(ServerLoadError);
  });

  it('throws and logs when the conversations fetch rejects', async () => {
    const err = new Error('Network failure');
    answer({
      conversations: async () => {
        throw err;
      },
    });

    await expect(ConversationsListPage()).rejects.toBeInstanceOf(ServerLoadError);
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), err, expect.any(Object));
  });

  it('shows a notice and still renders the table when the agent filter load fails', async () => {
    answer({ agents: async () => apiFailure(500) });

    render(await ConversationsListPage());

    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load the agent filter options");
    const table = screen.getByTestId('conversations-table');
    expect(table).toHaveAttribute('data-count', '2');
    expect(table).toHaveAttribute('data-agents', '0');
    expect(logger.error).toHaveBeenCalled();
  });

  it('forwards conversations, meta and agents to the table, with no notice', async () => {
    answer();

    render(await ConversationsListPage());

    const paths = vi.mocked(serverFetch).mock.calls.map((call) => call[0]);
    expect(paths).toContain(`${API.ADMIN.ORCHESTRATION.CONVERSATIONS}?page=1&limit=25`);
    expect(paths).toContain(`${API.ADMIN.ORCHESTRATION.AGENTS}?page=1&limit=100`);
    const table = screen.getByTestId('conversations-table');
    expect(table).toHaveAttribute('data-count', '2');
    expect(table).toHaveAttribute('data-total', '2');
    expect(table).toHaveAttribute('data-agents', '2');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders an empty list as an empty list', async () => {
    answer({ conversations: async () => apiSuccess([]) });

    render(await ConversationsListPage());

    const table = screen.getByTestId('conversations-table');
    expect(table).toHaveAttribute('data-count', '0');
    expect(table).toHaveAttribute('data-total', '0');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
