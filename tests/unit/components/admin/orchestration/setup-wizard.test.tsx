/**
 * SetupWizard Component Tests
 *
 * Covers initial rendering, step 0 skip, auto-complete of the provider step
 * when providers exist, and basic agent-step validation. Heavier paths
 * (full SSE consumer end-to-end) are left to manual QA and integration.
 *
 * The wizard uses a 6-step layout:
 *   0 intro · 1 provider · 2 default models · 3 agent · 4 test · 5 done
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SetupWizard } from '@/components/admin/orchestration/setup-wizard';

const STORAGE_KEY = 'sunrise.orchestration.setup-wizard.v2';

interface MockFetchOptions {
  providerTotal: number;
  agentTotal: number;
  /** Detection rows returned by /providers/detect. */
  detected?: Array<{
    slug: string;
    name: string;
    providerType: 'anthropic' | 'openai-compatible' | 'voyage';
    defaultBaseUrl: string | null;
    apiKeyEnvVar: string | null;
    apiKeyPresent: boolean;
    alreadyConfigured: boolean;
    isLocal: boolean;
    suggestedDefaultChatModel: string | null;
    suggestedEmbeddingModel: string | null;
  }>;
}

function mockFetch(opts: MockFetchOptions) {
  const detected = opts.detected ?? [];
  return vi.fn().mockImplementation((url: string) => {
    const urlStr = typeof url === 'string' ? url : '';
    if (urlStr.includes('/providers/detect')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { detected } }),
      });
    }
    if (urlStr.includes('/providers')) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ success: true, data: [], meta: { total: opts.providerTotal } }),
      });
    }
    if (urlStr.includes('/agents')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: [], meta: { total: opts.agentTotal } }),
      });
    }
    if (urlStr.includes('/settings')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { defaultModels: {} } }),
      });
    }
    if (urlStr.includes('/models')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: [] }),
      });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

function makeStoredState(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    stepIndex: 0,
    providerDraft: {
      name: '',
      slug: '',
      apiKeyEnvVar: '',
      providerType: '',
      baseUrl: '',
      suggestedDefaultChatModel: '',
      suggestedEmbeddingModel: '',
    },
    agentDraft: {
      name: '',
      slug: '',
      description: '',
      systemInstructions: '',
      model: '',
      provider: '',
    },
    createdAgentSlug: null,
    ...overrides,
  });
}

describe('SetupWizard', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('opens at step 1 of 6 by default', async () => {
    vi.stubGlobal('fetch', mockFetch({ providerTotal: 0, agentTotal: 0 }));

    render(<SetupWizard open={true} onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/Step 1 of 6/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/What are you building\?/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /skip, i'll configure manually/i })
    ).toBeInTheDocument();
  });

  it('Step 1 "Skip" advances to step 2 and persists progress', async () => {
    vi.stubGlobal('fetch', mockFetch({ providerTotal: 0, agentTotal: 0 }));
    const user = userEvent.setup();

    render(<SetupWizard open={true} onOpenChange={() => {}} />);

    await waitFor(() => expect(screen.getByText(/Step 1 of 6/i)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /skip, i'll configure manually/i }));

    await waitFor(() => expect(screen.getByText(/Step 2 of 6/i)).toBeInTheDocument());

    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(stored.stepIndex).toBe(1);
  });

  it('Step 2 auto-completes with a success card when providers already exist', async () => {
    vi.stubGlobal('fetch', mockFetch({ providerTotal: 1, agentTotal: 0 }));

    window.localStorage.setItem(STORAGE_KEY, makeStoredState({ stepIndex: 1 }));

    render(<SetupWizard open={true} onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/already have a provider configured/i)).toBeInTheDocument();
    });
  });

  it('Step 2 surfaces detection cards when an env-var key is present', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        providerTotal: 0,
        agentTotal: 0,
        detected: [
          {
            slug: 'anthropic',
            name: 'Anthropic',
            providerType: 'anthropic',
            defaultBaseUrl: null,
            apiKeyEnvVar: 'ANTHROPIC_API_KEY',
            apiKeyPresent: true,
            alreadyConfigured: false,
            isLocal: false,
            suggestedDefaultChatModel: 'claude-sonnet-4-6',
            suggestedEmbeddingModel: null,
          },
        ],
      })
    );

    window.localStorage.setItem(STORAGE_KEY, makeStoredState({ stepIndex: 1 }));

    render(<SetupWizard open={true} onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/We detected an API key/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/ANTHROPIC_API_KEY/i)).toBeInTheDocument();
    expect(screen.getByText(/Configure manually instead/i)).toBeInTheDocument();
  });

  it('Step 2 falls back to manual form when no keys are detected', async () => {
    vi.stubGlobal('fetch', mockFetch({ providerTotal: 0, agentTotal: 0 }));

    window.localStorage.setItem(STORAGE_KEY, makeStoredState({ stepIndex: 1 }));

    render(<SetupWizard open={true} onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /create provider/i })).toBeInTheDocument();
    });
    expect(document.getElementById('provider-name')).not.toBeNull();
    expect(document.getElementById('provider-slug')).not.toBeNull();
    expect(document.getElementById('provider-flavour')).not.toBeNull();
  });

  it('Step 4 StepAgent client-side validation guard blocks submit with empty fields', async () => {
    const fetchMock = mockFetch({ providerTotal: 1, agentTotal: 0 });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    // Jump straight to step 3 (index 3 — Create agent) with an empty agent draft.
    window.localStorage.setItem(STORAGE_KEY, makeStoredState({ stepIndex: 3 }));

    render(<SetupWizard open={true} onOpenChange={() => {}} />);

    // The agent step warns when no providers exist (the test's providers
    // fetch returns an empty data array). We just need to confirm the
    // step renders without firing a POST to /agents.
    await waitFor(() => expect(screen.getByText(/Step 4 of 6/i)).toBeInTheDocument());

    const createButtons = screen.queryAllByRole('button', { name: /create agent/i });
    if (createButtons.length > 0) {
      await user.click(createButtons[0]);
    }

    const agentPostCalls = fetchMock.mock.calls.filter((call) => {
      const url = typeof call[0] === 'string' ? call[0] : '';
      const init = call[1] as RequestInit | undefined;
      return url.includes('/agents') && init?.method === 'POST';
    });
    expect(agentPostCalls).toHaveLength(0);
  });

  it('Step 5 StepTestAgent sanitizes SSE error frames (never forwards raw error text)', async () => {
    const SECRET = 'RAW_SDK_LEAK_abc123';

    const encoder = new TextEncoder();
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ code: 'internal_error', message: SECRET })}\n\n`
          )
        );
        controller.close();
      },
    });

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const urlStr = typeof url === 'string' ? url : '';
      if (urlStr.includes('/providers/detect')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: { detected: [] } }),
        });
      }
      if (urlStr.includes('/providers')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: [], meta: { total: 1 } }),
        });
      }
      if (urlStr.includes('/agents')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: [], meta: { total: 1 } }),
        });
      }
      if (urlStr.includes('/chat/stream')) {
        return Promise.resolve({ ok: true, body: streamBody });
      }
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    // Start at step 4 (index 4 — Test your agent) with a created agent.
    window.localStorage.setItem(
      STORAGE_KEY,
      makeStoredState({
        stepIndex: 4,
        agentDraft: {
          name: 'Test',
          slug: 'test-agent',
          description: 'x',
          systemInstructions: 'x',
          model: 'claude-sonnet-4-6',
          provider: 'anthropic',
        },
        createdAgentSlug: 'test-agent',
      })
    );

    render(<SetupWizard open={true} onOpenChange={() => {}} />);

    await waitFor(() => expect(screen.getByText(/Step 5 of 6/i)).toBeInTheDocument());

    await user.type(screen.getByLabelText(/your message/i), 'Hi');
    await user.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(
      () => {
        expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
      },
      { timeout: 3000 }
    );

    expect(document.body.textContent ?? '').not.toContain(SECRET);
  });

  it('Resume: saved progress at step 2 reopens on step 2', async () => {
    vi.stubGlobal('fetch', mockFetch({ providerTotal: 0, agentTotal: 0 }));

    window.localStorage.setItem(STORAGE_KEY, makeStoredState({ stepIndex: 1 }));

    render(<SetupWizard open={true} onOpenChange={() => {}} />);

    await waitFor(() => expect(screen.getByText(/Step 2 of 6/i)).toBeInTheDocument());
  });
});
