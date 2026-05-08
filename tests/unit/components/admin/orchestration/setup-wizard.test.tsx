/**
 * SetupWizard Component Tests
 *
 * Covers initial render, the new 4-step layout, snap-back when persisted
 * state is stale, and the step indicator.
 *
 * The wizard's 4-step layout (config-oriented):
 *   0 provider · 1 defaults · 2 smoke test · 3 done
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SetupWizard } from '@/components/admin/orchestration/setup-wizard';

const STORAGE_KEY = 'sunrise.orchestration.setup-wizard.v3';

interface MockFetchOptions {
  providerTotal: number;
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

  it('opens at step 1 of 4 (Provider) by default on a fresh install', async () => {
    vi.stubGlobal('fetch', mockFetch({ providerTotal: 0 }));

    render(<SetupWizard open={true} onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/Step 1 of 4/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Configure a provider/i)).toBeInTheDocument();
  });

  it('Provider step auto-completes with a success card when providers already exist', async () => {
    vi.stubGlobal('fetch', mockFetch({ providerTotal: 1 }));

    window.localStorage.setItem(STORAGE_KEY, makeStoredState({ stepIndex: 0 }));

    render(<SetupWizard open={true} onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/already have a provider configured/i)).toBeInTheDocument();
    });
  });

  it('Provider step surfaces detection cards when an env-var key is present', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        providerTotal: 0,
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

    window.localStorage.setItem(STORAGE_KEY, makeStoredState({ stepIndex: 0 }));

    render(<SetupWizard open={true} onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/We detected an API key/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/ANTHROPIC_API_KEY/i)).toBeInTheDocument();
    // The card now shows the suggested chat model up front and warns
    // that Anthropic doesn't offer embeddings — so the operator knows
    // what they're getting before clicking Configure.
    expect(screen.getByText('claude-sonnet-4-6')).toBeInTheDocument();
    expect(screen.getByText(/Anthropic doesn't offer embeddings/i)).toBeInTheDocument();
    expect(screen.getByText(/Existing defaults are never overwritten/i)).toBeInTheDocument();
  });

  it('Provider step shows both chat + embedding suggestions when the provider supports both', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        providerTotal: 0,
        detected: [
          {
            slug: 'openai',
            name: 'OpenAI',
            providerType: 'openai-compatible',
            defaultBaseUrl: 'https://api.openai.com/v1',
            apiKeyEnvVar: 'OPENAI_API_KEY',
            apiKeyPresent: true,
            alreadyConfigured: false,
            isLocal: false,
            suggestedDefaultChatModel: 'gpt-4o-mini',
            suggestedEmbeddingModel: 'text-embedding-3-small',
          },
        ],
      })
    );

    window.localStorage.setItem(STORAGE_KEY, makeStoredState({ stepIndex: 0 }));

    render(<SetupWizard open={true} onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
    });
    expect(screen.getByText('text-embedding-3-small')).toBeInTheDocument();
    expect(screen.queryByText(/doesn't offer embeddings/i)).not.toBeInTheDocument();
  });

  it('Provider step falls back to the manual form when no keys are detected', async () => {
    vi.stubGlobal('fetch', mockFetch({ providerTotal: 0 }));

    window.localStorage.setItem(STORAGE_KEY, makeStoredState({ stepIndex: 0 }));

    render(<SetupWizard open={true} onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /create provider/i })).toBeInTheDocument();
    });
    expect(document.getElementById('provider-name')).not.toBeNull();
    expect(document.getElementById('provider-slug')).not.toBeNull();
    expect(document.getElementById('provider-flavour')).not.toBeNull();
  });

  it('Snaps back to Provider step when persisted state points beyond actual setup', async () => {
    // No providers configured but persisted stepIndex points at smoke test.
    // The wizard should redirect back to Provider, not let the user sit on
    // a step that has no prerequisites met.
    vi.stubGlobal('fetch', mockFetch({ providerTotal: 0 }));

    window.localStorage.setItem(STORAGE_KEY, makeStoredState({ stepIndex: 2 }));

    render(<SetupWizard open={true} onOpenChange={() => {}} />);

    await waitFor(() => expect(screen.getByText(/Step 1 of 4/i)).toBeInTheDocument());
  });

  it('Resume: saved progress at Defaults reopens on Defaults', async () => {
    vi.stubGlobal('fetch', mockFetch({ providerTotal: 1 }));

    window.localStorage.setItem(STORAGE_KEY, makeStoredState({ stepIndex: 1 }));

    render(<SetupWizard open={true} onOpenChange={() => {}} />);

    await waitFor(() => expect(screen.getByText(/Step 2 of 4/i)).toBeInTheDocument());
  });

  it('Step indicator shows a clickable trail of completed steps', async () => {
    vi.stubGlobal('fetch', mockFetch({ providerTotal: 1 }));
    const user = userEvent.setup();

    // Open at step 3 (smoke test) — provider configured, defaults set.
    window.localStorage.setItem(STORAGE_KEY, makeStoredState({ stepIndex: 2 }));

    render(<SetupWizard open={true} onOpenChange={() => {}} />);

    await waitFor(() => expect(screen.getByText(/Step 3 of 4/i)).toBeInTheDocument());

    const ol = screen.getByLabelText(/setup progress/i);
    const buttons = ol.querySelectorAll('button');
    expect(buttons).toHaveLength(4);

    // Steps 0 and 1 are completed (clickable). Step 2 (current) and Step 3 (upcoming) are disabled.
    expect(buttons[0]).not.toBeDisabled();
    expect(buttons[1]).not.toBeDisabled();
    expect(buttons[2]).toBeDisabled();
    expect(buttons[3]).toBeDisabled();

    // Clicking a completed step jumps the wizard back to it.
    await user.click(buttons[0]);
    await waitFor(() => expect(screen.getByText(/Step 1 of 4/i)).toBeInTheDocument());
  });
});
