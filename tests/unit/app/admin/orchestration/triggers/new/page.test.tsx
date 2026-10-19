// @vitest-environment happy-dom

/**
 * Unit Tests: NewTriggerPage (app/admin/orchestration/triggers/new/page.tsx)
 *
 * The page loads three things the form cannot work honestly without — the
 * workflows, the agents and the registered channels — so each is required:
 * a failed load throws to the error boundary (#518). Before, a failed
 * workflows load read as "You need a workflow first", and a failed channels
 * load flagged every adapter as unregistered.
 *
 * @see app/admin/orchestration/triggers/new/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Only the network is faked: the real parseApiResponse and server-load run.
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/components/admin/orchestration/trigger-form', () => ({
  TriggerForm: (props: {
    mode: string;
    workflows: unknown[];
    agents: unknown[];
    enabledChannels: string[];
  }) => (
    <div
      data-testid="trigger-form"
      data-mode={props.mode}
      data-workflows={String(props.workflows.length)}
      data-agents={String(props.agents.length)}
      data-channels={props.enabledChannels.join(',')}
    />
  ),
}));

vi.mock('@/components/admin/orchestration/whatsapp-worked-example', () => ({
  WhatsAppWorkedExample: () => <div data-testid="whatsapp-example" />,
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────────

import NewTriggerPage from '@/app/admin/orchestration/triggers/new/page';
import { serverFetch } from '@/lib/api/server-fetch';
import { ServerLoadError } from '@/lib/api/server-load';
import { logger } from '@/lib/logging';
import { API } from '@/lib/api/endpoints';
import { apiFailure, apiSuccess, apiPage } from '@/tests/helpers/api';
import { listAgentsQuerySchema, listWorkflowsQuerySchema } from '@/lib/validations/orchestration';

// ─── Helpers ─────────────────────────────────────────────────────────────────

type Endpoint = 'workflows' | 'agents' | 'triggers';

const WORKFLOWS = [{ id: 'wf-1', name: 'Inbound', slug: 'inbound', isActive: true }];
const AGENTS = [{ id: 'ag-1', name: 'Support' }];

/** Answer each endpoint with a fresh Response per call; override one to fail it. */
function routeFetch(overrides: Partial<Record<Endpoint, () => Response>> = {}) {
  const answers: Record<Endpoint, () => Response> = {
    workflows: () => apiPage(WORKFLOWS),
    agents: () => apiPage(AGENTS),
    triggers: () => apiSuccess([], { enabledChannels: ['slack', 'twilio'] }),
    ...overrides,
  };
  vi.mocked(serverFetch).mockImplementation(async (url: string) => {
    if (url.startsWith(API.ADMIN.ORCHESTRATION.WORKFLOWS)) return answers.workflows();
    if (url.startsWith(API.ADMIN.ORCHESTRATION.AGENTS)) return answers.agents();
    if (url.startsWith(API.ADMIN.ORCHESTRATION.TRIGGERS)) return answers.triggers();
    throw new Error(`Unexpected URL: ${url}`);
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('NewTriggerPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the form with workflows, agents and the registered channels', async () => {
    routeFetch();

    render(await NewTriggerPage());

    const form = screen.getByTestId('trigger-form');
    expect(form).toHaveAttribute('data-mode', 'create');
    expect(form).toHaveAttribute('data-workflows', '1');
    expect(form).toHaveAttribute('data-agents', '1');
    expect(form).toHaveAttribute('data-channels', 'slack,twilio');
  });

  it('shows "You need a workflow first" when there genuinely are no workflows', async () => {
    routeFetch({ workflows: () => apiPage([]) });

    render(await NewTriggerPage());

    expect(screen.getByText('You need a workflow first')).toBeInTheDocument();
    expect(screen.queryByTestId('trigger-form')).not.toBeInTheDocument();
  });

  // ── A failed load throws rather than reading as empty (#518) ─────────────

  it('throws, rather than showing "You need a workflow first", when the workflows fail', async () => {
    routeFetch({ workflows: () => apiFailure(500) });

    await expect(NewTriggerPage()).rejects.toBeInstanceOf(ServerLoadError);
  });

  it('throws when the agents fail to load', async () => {
    routeFetch({ agents: () => apiFailure(200) });

    await expect(NewTriggerPage()).rejects.toBeInstanceOf(ServerLoadError);
  });

  it('logs and throws when the channels load rejects, rather than flagging every adapter', async () => {
    const fetchErr = new Error('Network failure');
    routeFetch({
      triggers: () => {
        throw fetchErr;
      },
    });

    await expect(NewTriggerPage()).rejects.toBeInstanceOf(ServerLoadError);
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), fetchErr, expect.any(Object));
  });

  // The list routes cap `limit` at 100 and answer more with a 400, which
  // requireServerData turns into the error boundary on every visit.
  it('asks the list routes for no more than their schemas accept', async () => {
    routeFetch();

    await NewTriggerPage();

    const query = (prefix: string) => {
      const url = vi
        .mocked(serverFetch)
        .mock.calls.map(([u]) => u)
        .find((u) => u.startsWith(`${prefix}?`));
      return Object.fromEntries(new URL(url ?? '', 'http://x').searchParams);
    };
    expect(
      listWorkflowsQuerySchema.safeParse(query(API.ADMIN.ORCHESTRATION.WORKFLOWS)).success
    ).toBe(true);
    expect(listAgentsQuerySchema.safeParse(query(API.ADMIN.ORCHESTRATION.AGENTS)).success).toBe(
      true
    );
  });

  // A single page stops at 100 rows, which would leave options out unseen.
  it('offers every workflow and agent, across pages', async () => {
    routeFetch();
    const happy = vi.mocked(serverFetch).getMockImplementation();
    const firstPage = Array.from({ length: 100 }, (_, i) => ({
      id: `ag-${i}`,
      name: `Agent ${i}`,
    }));
    vi.mocked(serverFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (!url.startsWith(`${API.ADMIN.ORCHESTRATION.AGENTS}?`)) return happy!(url, init);
      return url.includes('page=1&')
        ? apiPage(firstPage, 1, 2)
        : apiPage([{ id: 'ag-100', name: 'Agent 100' }], 2, 2);
    });

    render(await NewTriggerPage());

    expect(screen.getByTestId('trigger-form')).toHaveAttribute('data-agents', '101');
  });

  it('throws rather than offering a list it cannot tell is complete', async () => {
    routeFetch({ agents: () => apiSuccess(AGENTS) });

    await expect(NewTriggerPage()).rejects.toBeInstanceOf(ServerLoadError);
  });
});
