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
import { apiFailure, apiSuccess } from '@/tests/helpers/api';

// ─── Helpers ─────────────────────────────────────────────────────────────────

type Endpoint = 'workflows' | 'agents' | 'triggers';

const WORKFLOWS = [{ id: 'wf-1', name: 'Inbound', slug: 'inbound', isActive: true }];
const AGENTS = [{ id: 'ag-1', name: 'Support' }];

/** Answer each endpoint with a fresh Response per call; override one to fail it. */
function routeFetch(overrides: Partial<Record<Endpoint, () => Response>> = {}) {
  const answers: Record<Endpoint, () => Response> = {
    workflows: () => apiSuccess(WORKFLOWS),
    agents: () => apiSuccess(AGENTS),
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
    routeFetch({ workflows: () => apiSuccess([]) });

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
});
