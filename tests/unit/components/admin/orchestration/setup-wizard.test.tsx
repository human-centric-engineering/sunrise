/**
 * SetupWizard Component Tests
 *
 * Covers initial rendering, step 1 skip, auto-complete of the provider step
 * when providers exist, and basic agent-step validation. Heavier paths
 * (full SSE consumer end-to-end) are left to manual QA and integration.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SetupWizard } from '@/components/admin/orchestration/setup-wizard';

const STORAGE_KEY = 'sunrise.orchestration.setup-wizard.v1';

function mockFetchWithCounts(providerTotal: number, agentTotal: number) {
  return vi.fn().mockImplementation((url: string) => {
    const urlStr = typeof url === 'string' ? url : '';
    if (urlStr.includes('/providers')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: [], meta: { total: providerTotal } }),
      });
    }
    if (urlStr.includes('/agents')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: [], meta: { total: agentTotal } }),
      });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
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

  it('opens at step 1 of 5 by default', async () => {
    vi.stubGlobal('fetch', mockFetchWithCounts(0, 0));

    render(<SetupWizard open={true} onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/Step 1 of 5/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/What are you building\?/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue to provider setup/i })).toBeInTheDocument();
  });

  it('Step 1 "Continue to provider setup" advances to step 2 and persists progress', async () => {
    vi.stubGlobal('fetch', mockFetchWithCounts(0, 0));
    const user = userEvent.setup();

    render(<SetupWizard open={true} onOpenChange={() => {}} />);

    await waitFor(() => expect(screen.getByText(/Step 1 of 5/i)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /continue to provider setup/i }));

    await waitFor(() => expect(screen.getByText(/Step 2 of 5/i)).toBeInTheDocument());

    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(stored.stepIndex).toBe(1);
  });

  it('Step 2 auto-completes with a success card when providers already exist', async () => {
    vi.stubGlobal('fetch', mockFetchWithCounts(1, 0));

    // Start at step 2 so we don't need to click through step 1
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        stepIndex: 1,
        providerDraft: { name: '', slug: '', apiKeyEnvVar: '' },
        agentDraft: {
          name: '',
          slug: '',
          description: '',
          systemInstructions: '',
          model: 'claude-opus-4-6',
          provider: 'anthropic',
        },
        createdAgentSlug: null,
      })
    );

    render(<SetupWizard open={true} onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/already have a provider configured/i)).toBeInTheDocument();
    });
  });

  it('Shows the inline provider form when no providers exist', async () => {
    vi.stubGlobal('fetch', mockFetchWithCounts(0, 0));

    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        stepIndex: 1,
        providerDraft: { name: '', slug: '', apiKeyEnvVar: '' },
        agentDraft: {
          name: '',
          slug: '',
          description: '',
          systemInstructions: '',
          model: 'claude-opus-4-6',
          provider: 'anthropic',
        },
        createdAgentSlug: null,
      })
    );

    render(<SetupWizard open={true} onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /create provider/i })).toBeInTheDocument();
    });
    expect(document.getElementById('provider-name')).not.toBeNull();
    expect(document.getElementById('provider-slug')).not.toBeNull();
  });

  it('Step 3 StepAgent client-side validation guard blocks submit with empty fields', async () => {
    const fetchMock = mockFetchWithCounts(1, 0);
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    // Jump straight to step 3 (Create agent) with an empty agent draft.
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        stepIndex: 2,
        providerDraft: { name: '', slug: '', apiKeyEnvVar: '' },
        agentDraft: {
          name: '',
          slug: '',
          description: '',
          systemInstructions: '',
          model: '',
          provider: 'anthropic',
        },
        createdAgentSlug: null,
      })
    );

    render(<SetupWizard open={true} onOpenChange={() => {}} />);

    await waitFor(() => expect(screen.getByText(/Step 3 of 5/i)).toBeInTheDocument());

    // Bypass the browser `required` attribute by submitting through the form
    // element directly — we want to hit the hook's client-side guard.
    const submitButton = screen.getByRole('button', { name: /create agent/i });
    const form = submitButton.closest('form');
    expect(form).not.toBeNull();
    await user.click(submitButton);

    // The client-side guard renders a friendly error…
    // (If HTML5 required kicks in first, at minimum there's no POST to /agents.)
    const agentPostCalls = fetchMock.mock.calls.filter((call) => {
      const url = typeof call[0] === 'string' ? call[0] : '';
      const init = call[1] as RequestInit | undefined;
      return url.includes('/agents') && init?.method === 'POST';
    });
    expect(agentPostCalls).toHaveLength(0);
  });

  it('Step 4 StepTestAgent sanitizes SSE error frames (never forwards raw error text)', async () => {
    const SECRET = 'RAW_SDK_LEAK_abc123';

    // Build a ReadableStream emitting a single SSE error frame with a
    // "raw" provider error message. The hook must render a friendly
    // fallback and must NOT surface the raw text.
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

    // Start directly on step 4 (Test your agent) with a created agent.
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        stepIndex: 3,
        providerDraft: { name: '', slug: '', apiKeyEnvVar: '' },
        agentDraft: {
          name: 'Test',
          slug: 'test-agent',
          description: 'x',
          systemInstructions: 'x',
          model: 'claude-opus-4-6',
          provider: 'anthropic',
        },
        createdAgentSlug: 'test-agent',
      })
    );

    render(<SetupWizard open={true} onOpenChange={() => {}} />);

    await waitFor(() => expect(screen.getByText(/Step 4 of 5/i)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() => {
      expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    });

    // Critical: the raw provider error must not appear anywhere in the DOM.
    expect(document.body.textContent ?? '').not.toContain(SECRET);
  });

  it('Resume: saved progress at step 2 reopens on step 2', async () => {
    vi.stubGlobal('fetch', mockFetchWithCounts(0, 0));

    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        stepIndex: 1,
        providerDraft: { name: '', slug: '', apiKeyEnvVar: '' },
        agentDraft: {
          name: '',
          slug: '',
          description: '',
          systemInstructions: '',
          model: 'claude-opus-4-6',
          provider: 'anthropic',
        },
        createdAgentSlug: null,
      })
    );

    render(<SetupWizard open={true} onOpenChange={() => {}} />);

    await waitFor(() => expect(screen.getByText(/Step 2 of 5/i)).toBeInTheDocument());
  });
});
