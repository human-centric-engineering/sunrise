// @vitest-environment happy-dom

/**
 * Unit Tests: EditTriggerPage (app/admin/orchestration/triggers/[id]/page.tsx)
 *
 * - the trigger: a 404 → notFound(); any other failure throws ServerLoadError
 *   and does NOT call notFound() (#518)
 * - the agents and registered channels are form options the page cannot
 *   render honestly without, so a failed load of either throws too
 *
 * @see app/admin/orchestration/triggers/[id]/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  unstable_rethrow: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

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
    initial?: { id: string; name: string };
    workflows: Array<{ id: string }>;
    agents: unknown[];
    enabledChannels: string[];
  }) => (
    <div
      data-testid="trigger-form"
      data-mode={props.mode}
      data-trigger-id={props.initial?.id}
      data-workflow-ids={props.workflows.map((w) => w.id).join(',')}
      data-agents={String(props.agents.length)}
      data-channels={props.enabledChannels.join(',')}
    />
  ),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────────

import EditTriggerPage from '@/app/admin/orchestration/triggers/[id]/page';
import { serverFetch } from '@/lib/api/server-fetch';
import { ServerLoadError } from '@/lib/api/server-load';
import { logger } from '@/lib/logging';
import { notFound } from 'next/navigation';
import { API } from '@/lib/api/endpoints';
import { apiFailure, apiSuccess, apiPage } from '@/tests/helpers/api';
import { listAgentsQuerySchema } from '@/lib/validations/orchestration';

// ─── Helpers ─────────────────────────────────────────────────────────────────

type Endpoint = 'trigger' | 'agents' | 'triggers';

const TRIGGER = {
  id: 'tr-1',
  channel: 'twilio',
  name: 'SMS intake',
  workflowId: 'wf-1',
  metadata: { conversationAgentId: 'ag-1' },
  isEnabled: true,
  hasSigningSecret: true,
  lastFiredAt: null,
  workflow: { id: 'wf-1', name: 'Inbound', slug: 'inbound', isActive: true },
};

/** Answer each endpoint with a fresh Response per call; override one to fail it. */
function routeFetch(overrides: Partial<Record<Endpoint, () => Response>> = {}) {
  const answers: Record<Endpoint, () => Response> = {
    trigger: () => apiSuccess(TRIGGER),
    agents: () => apiPage([{ id: 'ag-1', name: 'Support' }]),
    triggers: () => apiSuccess([], { enabledChannels: ['twilio'] }),
    ...overrides,
  };
  vi.mocked(serverFetch).mockImplementation(async (url: string) => {
    if (url.startsWith(API.ADMIN.ORCHESTRATION.AGENTS)) return answers.agents();
    if (url.startsWith(`${API.ADMIN.ORCHESTRATION.TRIGGERS}?`)) return answers.triggers();
    if (url.startsWith(API.ADMIN.ORCHESTRATION.TRIGGERS)) return answers.trigger();
    throw new Error(`Unexpected URL: ${url}`);
  });
}

const params = (id = 'tr-1') => ({ params: Promise.resolve({ id }) });

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EditTriggerPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the form in edit mode with the trigger, its workflow, agents and channels', async () => {
    routeFetch();

    render(await EditTriggerPage(params()));

    expect(vi.mocked(serverFetch).mock.calls.map(([url]) => url)).toContain(
      API.ADMIN.ORCHESTRATION.triggerById('tr-1')
    );
    const form = screen.getByTestId('trigger-form');
    expect(form).toHaveAttribute('data-mode', 'edit');
    expect(form).toHaveAttribute('data-trigger-id', 'tr-1');
    expect(form).toHaveAttribute('data-workflow-ids', 'wf-1');
    expect(form).toHaveAttribute('data-agents', '1');
    expect(form).toHaveAttribute('data-channels', 'twilio');
  });

  it('calls notFound() when the trigger does not exist', async () => {
    routeFetch({ trigger: () => apiFailure(404, 'NOT_FOUND') });

    await expect(EditTriggerPage(params('tr-missing'))).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalledOnce();
  });

  // ── A failed load is a failure, not a missing trigger (#518) ─────────────

  it('throws to the error boundary, not notFound(), when the trigger API answers 500', async () => {
    routeFetch({ trigger: () => apiFailure(500) });

    await expect(EditTriggerPage(params())).rejects.toBeInstanceOf(ServerLoadError);
    expect(notFound).not.toHaveBeenCalled();
  });

  it('logs and throws, not notFound(), when the trigger fetch rejects', async () => {
    const fetchErr = new Error('Network failure');
    routeFetch({
      trigger: () => {
        throw fetchErr;
      },
    });

    await expect(EditTriggerPage(params())).rejects.toBeInstanceOf(ServerLoadError);
    expect(notFound).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), fetchErr, expect.any(Object));
  });

  it('throws when the agents fail, rather than hiding the conversation agent', async () => {
    routeFetch({ agents: () => apiFailure(500) });

    await expect(EditTriggerPage(params())).rejects.toBeInstanceOf(ServerLoadError);
    expect(notFound).not.toHaveBeenCalled();
  });

  it('throws when the channels fail, rather than flagging the adapter as unregistered', async () => {
    routeFetch({ triggers: () => apiFailure(200) });

    await expect(EditTriggerPage(params())).rejects.toBeInstanceOf(ServerLoadError);
  });

  // The agents route caps `limit` at 100 and answers more with a 400, which
  // requireServerData turns into the error boundary on every visit.
  it('asks the agents route for no more than its schema accepts', async () => {
    routeFetch();

    await EditTriggerPage(params());

    const url = vi
      .mocked(serverFetch)
      .mock.calls.map(([u]) => u)
      .find((u) => u.startsWith(`${API.ADMIN.ORCHESTRATION.AGENTS}?`));
    const query = Object.fromEntries(new URL(url ?? '', 'http://x').searchParams);
    expect(listAgentsQuerySchema.safeParse(query).success).toBe(true);
  });

  // Past 100 agents, one page could leave out the trigger's own agent.
  it("offers the trigger's agent even when it is past the first page", async () => {
    routeFetch();
    const happy = vi.mocked(serverFetch).getMockImplementation();
    const firstPage = Array.from({ length: 100 }, (_, i) => ({
      id: `other-${i}`,
      name: `Other ${i}`,
    }));
    vi.mocked(serverFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (!url.startsWith(`${API.ADMIN.ORCHESTRATION.AGENTS}?`)) return happy!(url, init);
      return url.includes('page=1&')
        ? apiPage(firstPage, 1, 2)
        : apiPage([{ id: 'ag-1', name: 'Support' }], 2, 2);
    });

    render(await EditTriggerPage(params()));

    expect(screen.getByTestId('trigger-form')).toHaveAttribute('data-agents', '101');
  });
});
