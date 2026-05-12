/**
 * ProviderDetectionsBanner Tests
 *
 * Test Coverage:
 * - Renders nothing while detection is loading
 * - Renders nothing when no detections are unconfigured
 * - Lists detections that are apiKeyPresent && !alreadyConfigured
 * - Hides detections that are already configured
 * - One-click Configure POSTs the suggested config + writes settings
 *   defaults when slots are empty
 * - Shows inline error when the POST fails; row stays visible
 * - Calls onProviderCreated and refetches detection on success
 *
 * @see components/admin/orchestration/provider-detections-banner.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ProviderDetectionsBanner } from '@/components/admin/orchestration/provider-detections-banner';

interface DetectionRow {
  slug: string;
  name: string;
  providerType: 'anthropic' | 'openai-compatible' | 'voyage';
  defaultBaseUrl: string | null;
  apiKeyEnvVar: string | null;
  apiKeyPresent: boolean;
  alreadyConfigured: boolean;
  isLocal: boolean;
  suggestedDefaultChatModel: string | null;
  suggestedRoutingModel: string | null;
  suggestedReasoningModel: string | null;
  suggestedEmbeddingModel: string | null;
}

function makeDetection(overrides: Partial<DetectionRow> = {}): DetectionRow {
  return {
    slug: 'anthropic',
    name: 'Anthropic',
    providerType: 'anthropic',
    defaultBaseUrl: null,
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    apiKeyPresent: true,
    alreadyConfigured: false,
    isLocal: false,
    suggestedDefaultChatModel: 'claude-sonnet-4-6',
    suggestedRoutingModel: null,
    suggestedReasoningModel: null,
    suggestedEmbeddingModel: null,
    ...overrides,
  };
}

interface FetchMockOptions {
  detected?: DetectionRow[];
  postProviderOk?: boolean;
  defaultModels?: Record<string, string>;
}

function makeFetchMock(opts: FetchMockOptions = {}) {
  const { detected = [], postProviderOk = true, defaultModels = {} } = opts;
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : '';
    if (u.includes('/providers/detect')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { detected } }),
      });
    }
    if (init?.method === 'POST' && u.includes('/providers')) {
      if (!postProviderOk) {
        return Promise.resolve({
          ok: false,
          status: 400,
          json: () =>
            Promise.resolve({ success: false, error: { code: 'VALIDATION', message: 'bad' } }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { id: 'prov-1' } }),
      });
    }
    if (init?.method === 'PATCH' && u.includes('/settings')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: {} }),
      });
    }
    if (u.includes('/settings')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { defaultModels } }),
      });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

describe('ProviderDetectionsBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing when no API keys are detected', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ detected: [] }));

    const { container } = render(<ProviderDetectionsBanner />);

    // Wait for the detection fetch to settle, then assert empty.
    await waitFor(() => {
      // Banner only mounts content when there's something unconfigured.
      expect(container.querySelector('[data-testid="provider-detections-banner"]')).toBeNull();
    });
  });

  it('shows the no-keys warning when showNoKeysWarning and nothing is detected', async () => {
    // Mirrors the providers-list empty-state branch: when the
    // operator has zero providers AND zero env keys are set, the
    // banner surfaces the same "add env vars and restart" guidance
    // the setup wizard shows. Includes candidate env vars from
    // detection rows whose key isn't present.
    vi.stubGlobal(
      'fetch',
      makeFetchMock({
        detected: [
          makeDetection({
            slug: 'anthropic',
            name: 'Anthropic',
            apiKeyEnvVar: 'ANTHROPIC_API_KEY',
            apiKeyPresent: false,
          }),
          makeDetection({
            slug: 'openai',
            name: 'OpenAI',
            apiKeyEnvVar: 'OPENAI_API_KEY',
            apiKeyPresent: false,
          }),
        ],
      })
    );

    render(<ProviderDetectionsBanner showNoKeysWarning />);

    await waitFor(() => {
      expect(screen.getByTestId('provider-no-keys-banner')).toBeInTheDocument();
    });
    expect(screen.getByText(/no llm api keys detected/i)).toBeInTheDocument();
    expect(screen.getByText(/ANTHROPIC_API_KEY/)).toBeInTheDocument();
    expect(screen.getByText(/OPENAI_API_KEY/)).toBeInTheDocument();
  });

  it('does not show the no-keys warning when showNoKeysWarning is false', async () => {
    // Default behaviour — banner stays silent when there is nothing
    // to surface, regardless of detection state. Prevents the warning
    // appearing in contexts that don't opt in (e.g. providers list
    // after the operator has already configured something).
    vi.stubGlobal(
      'fetch',
      makeFetchMock({
        detected: [makeDetection({ apiKeyPresent: false })],
      })
    );

    const { container } = render(<ProviderDetectionsBanner />);

    await waitFor(() => {
      expect(container.querySelector('[data-testid="provider-no-keys-banner"]')).toBeNull();
    });
  });

  it('renders nothing when every detection is already configured', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock({
        detected: [makeDetection({ apiKeyPresent: true, alreadyConfigured: true })],
      })
    );

    const { container } = render(<ProviderDetectionsBanner />);

    await waitFor(() => {
      expect(container.querySelector('[data-testid="provider-detections-banner"]')).toBeNull();
    });
  });

  it('renders a row for each unconfigured detection with an env-var hint', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock({
        detected: [
          makeDetection({
            slug: 'openai',
            name: 'OpenAI',
            apiKeyEnvVar: 'OPENAI_API_KEY',
            suggestedDefaultChatModel: 'gpt-4o-mini',
          }),
          makeDetection({
            slug: 'anthropic',
            name: 'Anthropic',
            apiKeyEnvVar: 'ANTHROPIC_API_KEY',
          }),
          // Already-configured row should be filtered out.
          makeDetection({
            slug: 'voyage',
            name: 'Voyage AI',
            apiKeyEnvVar: 'VOYAGE_API_KEY',
            alreadyConfigured: true,
          }),
        ],
      })
    );

    render(<ProviderDetectionsBanner />);

    await waitFor(() => {
      expect(screen.getByText(/Detected 2 API keys/i)).toBeInTheDocument();
    });
    expect(screen.getByText('OpenAI')).toBeInTheDocument();
    expect(screen.getByText('Anthropic')).toBeInTheDocument();
    expect(screen.getByText(/OPENAI_API_KEY/)).toBeInTheDocument();
    expect(screen.getByText(/ANTHROPIC_API_KEY/)).toBeInTheDocument();
    // Voyage was already-configured — must not appear as a row. The
    // string "Voyage AI" can still appear inside the embedding-gap
    // warning copy ("Anthropic doesn't offer embeddings — knowledge
    // base search needs a separate embedding provider (Voyage AI,
    // OpenAI, or Ollama)"), so check for the env var instead, which
    // only renders on actual rows.
    expect(screen.queryByText(/VOYAGE_API_KEY/)).not.toBeInTheDocument();
  });

  it('Configure POSTs the suggested config and notifies the parent', async () => {
    const fetchMock = makeFetchMock({
      detected: [makeDetection()],
    });
    vi.stubGlobal('fetch', fetchMock);
    const onProviderCreated = vi.fn();
    const user = userEvent.setup();

    render(<ProviderDetectionsBanner onProviderCreated={onProviderCreated} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^configure$/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /^configure$/i }));

    await waitFor(() => {
      const postCalls = fetchMock.mock.calls.filter((call) => {
        const u = typeof call[0] === 'string' ? call[0] : '';
        const init = call[1] as RequestInit | undefined;
        return u.includes('/providers') && init?.method === 'POST' && !u.includes('/detect');
      });
      expect(postCalls.length).toBeGreaterThanOrEqual(1);
      // The POST body carries the detection's slug + providerType.
      const firstPost = postCalls[0];
      const body = JSON.parse((firstPost[1] as RequestInit).body as string);
      expect(body.slug).toBe('anthropic');
      expect(body.providerType).toBe('anthropic');
    });
    expect(onProviderCreated).toHaveBeenCalled();
  });

  it('PATCHes /settings with routing + reasoning when those slots are empty', async () => {
    // Source `persistSuggestedDefaults` writes patch.routing /
    // patch.reasoning when the detection row carries non-null
    // suggestions AND the stored defaults haven't already filled
    // them. Without this test, a regression in the routing/reasoning
    // write branches would ship green — the slots are unchecked by
    // the existing "Configure POSTs" test, which only verifies the
    // /providers POST body.
    const fetchMock = makeFetchMock({
      detected: [
        makeDetection({
          suggestedRoutingModel: 'claude-haiku-4-5',
          suggestedReasoningModel: 'claude-opus-4-6',
          suggestedEmbeddingModel: null,
        }),
      ],
      defaultModels: {}, // no stored defaults — every slot is empty
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<ProviderDetectionsBanner />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^configure$/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /^configure$/i }));

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find((call) => {
        const u = typeof call[0] === 'string' ? call[0] : '';
        const init = call[1] as RequestInit | undefined;
        return u.includes('/settings') && init?.method === 'PATCH';
      });
      expect(patchCall).toBeDefined();
      const body = JSON.parse((patchCall![1] as RequestInit).body as string);
      expect(body.defaultModels).toMatchObject({
        chat: 'claude-sonnet-4-6',
        routing: 'claude-haiku-4-5',
        reasoning: 'claude-opus-4-6',
      });
    });
  });

  it('shows an inline error when the POST fails and keeps the row visible', async () => {
    const fetchMock = makeFetchMock({
      detected: [makeDetection()],
      postProviderOk: false,
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<ProviderDetectionsBanner />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^configure$/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /^configure$/i }));

    await waitFor(() => {
      expect(screen.getByText(/Could not configure Anthropic/i)).toBeInTheDocument();
    });
    // Row still visible — operator can retry or open the wizard.
    expect(screen.getByText('Anthropic')).toBeInTheDocument();
  });

  it('renders a "setup wizard" footer link', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ detected: [makeDetection()] }));

    render(<ProviderDetectionsBanner />);

    await waitFor(() => {
      expect(screen.getByRole('link', { name: /setup wizard/i })).toBeInTheDocument();
    });
  });

  describe('Configure preview', () => {
    it('shows the suggested chat + embedding model defaults pre-click', async () => {
      vi.stubGlobal(
        'fetch',
        makeFetchMock({
          detected: [
            makeDetection({
              slug: 'openai',
              name: 'OpenAI',
              suggestedDefaultChatModel: 'gpt-4o-mini',
              suggestedEmbeddingModel: 'text-embedding-3-small',
            }),
          ],
        })
      );

      render(<ProviderDetectionsBanner />);

      await waitFor(() => {
        expect(screen.getByText(/default chat model/i)).toBeInTheDocument();
      });
      // Both suggestions visible before the operator clicks Configure.
      expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
      expect(screen.getByText('text-embedding-3-small')).toBeInTheDocument();
      // No embedding-gap warning when a model is suggested.
      expect(screen.queryByText(/doesn't offer embeddings/i)).not.toBeInTheDocument();
    });

    it('warns prominently when the chosen provider has no embedding model', async () => {
      vi.stubGlobal(
        'fetch',
        makeFetchMock({
          detected: [
            makeDetection({
              slug: 'anthropic',
              name: 'Anthropic',
              suggestedDefaultChatModel: 'claude-sonnet-4-6',
              suggestedEmbeddingModel: null,
            }),
          ],
        })
      );

      render(<ProviderDetectionsBanner />);

      await waitFor(() => {
        expect(screen.getByText(/Anthropic doesn't offer embeddings/i)).toBeInTheDocument();
      });
      // Embedding-gap warning points at the alternatives.
      expect(screen.getByText(/Voyage AI, OpenAI, or Ollama/i)).toBeInTheDocument();
      // Chat suggestion still visible.
      expect(screen.getByText('claude-sonnet-4-6')).toBeInTheDocument();
    });

    it('warns when an embeddings-only provider has no chat model', async () => {
      vi.stubGlobal(
        'fetch',
        makeFetchMock({
          detected: [
            makeDetection({
              slug: 'voyage',
              name: 'Voyage AI',
              suggestedDefaultChatModel: null,
              suggestedEmbeddingModel: 'voyage-3',
            }),
          ],
        })
      );

      render(<ProviderDetectionsBanner />);

      await waitFor(() => {
        expect(screen.getByText(/Voyage AI is embeddings-only/i)).toBeInTheDocument();
      });
      // Embedding suggestion shown; no chat model row.
      expect(screen.getByText('voyage-3')).toBeInTheDocument();
      expect(screen.queryByText(/default chat model/i)).not.toBeInTheDocument();
    });

    it('explains that existing defaults are not overwritten', async () => {
      vi.stubGlobal('fetch', makeFetchMock({ detected: [makeDetection()] }));

      render(<ProviderDetectionsBanner />);

      await waitFor(() => {
        expect(screen.getByText(/Existing defaults are never overwritten/i)).toBeInTheDocument();
      });
    });
  });
});
