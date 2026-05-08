/**
 * ProvidersList Component Tests
 *
 * Test Coverage:
 * - Renders a 3-provider card grid with correct provider names
 * - Missing env var case shows "Env var X is missing on the server"
 * - Status dot: red for apiKeyPresent=false (non-local)
 * - Lazy model-count fetch fills in after mount; failure renders em-dash
 * - Test-connection success updates dot to green and renders model count
 * - Test-connection rejection → friendly fallback; raw SDK error absent
 * - Delete dropdown → AlertDialog → confirm → DELETE removes the card
 * - Circuit breaker badge shown when state is open/half-open; reset button
 * - Reactivate action shown for inactive providers; PATCHes isActive=true
 *
 * @see components/admin/orchestration/providers-list.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ProvidersList } from '@/components/admin/orchestration/providers-list';
import type { ProviderRow } from '@/components/admin/orchestration/providers-list';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
}));

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  APIClientError: class APIClientError extends Error {
    constructor(
      message: string,
      public code = 'INTERNAL_ERROR',
      public status = 500
    ) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeProvider(overrides: Partial<ProviderRow> = {}): ProviderRow {
  return {
    id: 'prov-1',
    name: 'Anthropic',
    slug: 'anthropic',
    providerType: 'anthropic',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    baseUrl: null,
    isActive: true,
    isLocal: false,
    apiKeyPresent: true,
    createdBy: 'system',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    deletedAt: null,
    metadata: {},
    circuitBreaker: { state: 'closed', failureCount: 0, openedAt: null },
    ...overrides,
  } as ProviderRow;
}

const THREE_PROVIDERS: ProviderRow[] = [
  makeProvider({
    id: 'prov-1',
    name: 'Anthropic',
    slug: 'anthropic',
    providerType: 'anthropic',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    apiKeyPresent: true,
    isLocal: false,
  }),
  makeProvider({
    id: 'prov-2',
    name: 'OpenAI',
    slug: 'openai',
    providerType: 'openai-compatible',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    apiKeyPresent: false,
    isLocal: false,
    baseUrl: 'https://api.openai.com/v1',
  }),
  makeProvider({
    id: 'prov-3',
    name: 'Ollama',
    slug: 'ollama-local',
    providerType: 'openai-compatible',
    apiKeyEnvVar: null,
    apiKeyPresent: false,
    isLocal: true,
    baseUrl: 'http://localhost:11434/v1',
  }),
];

const MOCK_MODELS_RESPONSE = {
  providerId: 'prov-1',
  slug: 'anthropic',
  models: [
    {
      id: 'claude-opus-4-6',
      name: 'Claude Opus',
      provider: 'anthropic',
      tier: 'frontier',
      inputCostPerMillion: 15,
      outputCostPerMillion: 75,
      maxContext: 200000,
      supportsTools: true,
      available: true,
    },
  ],
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ProvidersList', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // The provider-test-cache persists results in localStorage across
    // tests within the same vitest worker; clear it so a "tested OK"
    // state from a prior test doesn't bleed in and pre-paint the dot
    // green before the test under examination clicks anything.
    window.localStorage.clear();
    // Default the lazy model-count fetch to a never-resolving promise.
    // This prevents the useEffect-triggered setState from firing after
    // synchronous render-based tests finish, which would otherwise cause
    // React "not wrapped in act(...)" warnings. Tests that need the
    // resolved state override this mock explicitly.
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockImplementation(() => new Promise(() => {}));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  // ── Rendering ──────────────────────────────────────────────────────────────

  describe('rendering', () => {
    it('renders all 3 provider cards', () => {
      render(<ProvidersList initialProviders={THREE_PROVIDERS} />);

      expect(screen.getByText('Anthropic')).toBeInTheDocument();
      expect(screen.getByText('OpenAI')).toBeInTheDocument();
      expect(screen.getByText('Ollama')).toBeInTheDocument();
    });

    it('renders provider slugs', () => {
      render(<ProvidersList initialProviders={THREE_PROVIDERS} />);

      expect(screen.getByText('anthropic')).toBeInTheDocument();
      expect(screen.getByText('openai')).toBeInTheDocument();
      expect(screen.getByText('ollama-local')).toBeInTheDocument();
    });

    it('renders "+ Add provider" link', () => {
      render(<ProvidersList initialProviders={THREE_PROVIDERS} />);

      expect(screen.getByRole('link', { name: /add provider/i })).toBeInTheDocument();
    });

    it('renders "Local" badge for local provider', () => {
      render(<ProvidersList initialProviders={THREE_PROVIDERS} />);

      expect(screen.getByText('Local')).toBeInTheDocument();
    });

    it('renders empty state when no providers', () => {
      render(<ProvidersList initialProviders={[]} />);

      expect(screen.getByText(/no providers configured yet/i)).toBeInTheDocument();
    });

    it('renders "N providers configured" count', () => {
      render(<ProvidersList initialProviders={THREE_PROVIDERS} />);

      expect(screen.getByText(/3 providers configured/i)).toBeInTheDocument();
    });
  });

  // ── Missing API key warning ────────────────────────────────────────────────

  describe('missing API key warning', () => {
    it('shows env var missing warning for non-local provider with apiKeyPresent=false', () => {
      render(<ProvidersList initialProviders={THREE_PROVIDERS} />);

      // OpenAI has apiKeyPresent: false and is not local → warning
      expect(screen.getByText(/openai_api_key/i)).toBeInTheDocument();
      expect(screen.getByText(/API key not found/i)).toBeInTheDocument();
    });

    it('status dot for OpenAI (apiKeyPresent=false) has red class', () => {
      render(<ProvidersList initialProviders={THREE_PROVIDERS} />);

      // The red dot has class 'bg-red-500'
      const redDots = document.querySelectorAll('.bg-red-500');
      expect(redDots.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Lazy model count ───────────────────────────────────────────────────────

  describe('lazy model count', () => {
    it('renders model count after lazy fetch resolves', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(MOCK_MODELS_RESPONSE);

      render(<ProvidersList initialProviders={[THREE_PROVIDERS[0]]} />);

      await waitFor(() => {
        expect(screen.getByText(/1 model.* available/i)).toBeInTheDocument();
      });
    });

    it('renders em-dash when model count fetch fails', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockRejectedValue(new Error('Network error'));

      render(<ProvidersList initialProviders={THREE_PROVIDERS} />);

      await waitFor(() => {
        const dashes = screen.getAllByText('—');
        expect(dashes.length).toBeGreaterThanOrEqual(1);
      });

      // Critical: provider names still rendered
      expect(screen.getByText('Anthropic')).toBeInTheDocument();
    });
  });

  // ── Test connection ────────────────────────────────────────────────────────

  describe('test connection button', () => {
    it('success surfaces model count in the test button aria-label', async () => {
      const { apiClient } = await import('@/lib/api/client');
      // First call = model count (lazy), second+ = test connection
      vi.mocked(apiClient.get).mockResolvedValue(MOCK_MODELS_RESPONSE);
      vi.mocked(apiClient.post).mockResolvedValue({
        ok: true,
        models: Array.from({ length: 12 }, (_, i) => `model-${i}`),
      });

      const user = userEvent.setup();
      render(<ProvidersList initialProviders={[THREE_PROVIDERS[0]]} />);

      await user.click(screen.getByRole('button', { name: /test connection/i }));

      // The visible label is just an icon (footer was crowded otherwise).
      // The count moved to aria-label / title on the success element.
      await waitFor(() => {
        expect(screen.getByLabelText(/12 models available/i)).toBeInTheDocument();
      });
    });

    it('failure renders friendly fallback, raw SDK error text absent', async () => {
      const RAW_SDK_LEAK_SECRET = 'RAW_SDK_LEAK_SECRET_XYZ';
      const { apiClient, APIClientError } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(MOCK_MODELS_RESPONSE);
      vi.mocked(apiClient.post).mockRejectedValue(
        new APIClientError(RAW_SDK_LEAK_SECRET, 'PROVIDER_ERROR', 500)
      );

      const user = userEvent.setup();
      render(<ProvidersList initialProviders={[THREE_PROVIDERS[0]]} />);

      await user.click(screen.getByRole('button', { name: /test connection/i }));

      await waitFor(() => {
        expect(screen.getByText(/couldn't reach this provider/i)).toBeInTheDocument();
      });

      // Critical: raw SDK error must NOT be in the DOM
      expect(document.body.textContent ?? '').not.toContain(RAW_SDK_LEAK_SECRET);
    });

    it('success updates status dot to green', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(MOCK_MODELS_RESPONSE);
      vi.mocked(apiClient.post).mockResolvedValue({
        ok: true,
        models: ['m1', 'm2', 'm3', 'm4', 'm5'],
      });

      const user = userEvent.setup();
      render(<ProvidersList initialProviders={[THREE_PROVIDERS[0]]} />);

      // No green dot yet
      expect(document.querySelectorAll('.bg-green-500').length).toBe(0);

      await user.click(screen.getByRole('button', { name: /test connection/i }));

      await waitFor(() => {
        const greenDots = document.querySelectorAll('.bg-green-500');
        expect(greenDots.length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  // ── Deactivate confirm flow ────────────────────────────────────────────────
  // The dropdown's "Delete" action was renamed to "Deactivate" because
  // soft-delete is what it actually does. Hard-delete now lives behind
  // a separate "Delete permanently" action covered below.

  describe('deactivate confirm flow', () => {
    async function openDeactivateDialog(user: ReturnType<typeof userEvent.setup>) {
      const moreBtn = document.querySelectorAll('button[aria-haspopup="menu"]')[0];
      await user.click(moreBtn as HTMLElement);

      const deactivateItem = await screen.findByRole('menuitem', {
        name: /^deactivate$/i,
        hidden: true,
      });
      await user.click(deactivateItem);

      await waitFor(() => expect(screen.getByText('Deactivate provider')).toBeInTheDocument());
    }

    it('clicking Deactivate in dropdown opens the AlertDialog', async () => {
      const user = userEvent.setup();
      render(<ProvidersList initialProviders={THREE_PROVIDERS} />);

      await openDeactivateDialog(user);

      expect(screen.getByText('Deactivate provider')).toBeInTheDocument();
    });

    it('confirm Deactivate calls apiClient.delete (soft-delete, no ?permanent flag)', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.delete).mockResolvedValue({ success: true });

      const user = userEvent.setup();
      render(<ProvidersList initialProviders={THREE_PROVIDERS} />);

      await openDeactivateDialog(user);
      await user.click(screen.getByRole('button', { name: /^deactivate$/i }));

      await waitFor(() => {
        expect(apiClient.delete).toHaveBeenCalledWith(expect.stringContaining('/providers/prov-1'));
        // Soft-delete must NOT use the permanent flag.
        const lastCallUrl = vi.mocked(apiClient.delete).mock.calls.at(-1)?.[0] as string;
        expect(lastCallUrl).not.toContain('permanent=true');
      });
    });

    it('cancelling closes the dialog without calling delete', async () => {
      const { apiClient } = await import('@/lib/api/client');

      const user = userEvent.setup();
      render(<ProvidersList initialProviders={THREE_PROVIDERS} />);

      await openDeactivateDialog(user);
      await user.click(screen.getByRole('button', { name: /cancel/i }));

      await waitFor(() => {
        expect(screen.queryByText('Deactivate provider')).not.toBeInTheDocument();
      });
      expect(apiClient.delete).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });
  });

  // ── Permanent delete flow ──────────────────────────────────────────────────

  describe('permanent delete flow', () => {
    async function openPermanentDialog(user: ReturnType<typeof userEvent.setup>) {
      const moreBtn = document.querySelectorAll('button[aria-haspopup="menu"]')[0];
      await user.click(moreBtn as HTMLElement);

      const permanentItem = await screen.findByRole('menuitem', {
        name: /delete permanently/i,
        hidden: true,
      });
      await user.click(permanentItem);

      // Wait for the dialog body — uniquely identifies the dialog
      // (the phrase "Delete permanently" itself appears multiple
      // times: dialog title + action button + dropdown item).
      await waitFor(() => expect(screen.getByText(/permanently deletes/i)).toBeInTheDocument());
    }

    it('clicking Delete permanently opens the strict dialog', async () => {
      const user = userEvent.setup();
      render(<ProvidersList initialProviders={THREE_PROVIDERS} />);

      await openPermanentDialog(user);

      expect(screen.getByText(/permanently deletes/i)).toBeInTheDocument();
    });

    it('confirm calls apiClient.delete with ?permanent=true and drops the card on success', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.delete).mockResolvedValue({ success: true });

      const user = userEvent.setup();
      render(<ProvidersList initialProviders={THREE_PROVIDERS} />);

      await openPermanentDialog(user);
      await user.click(screen.getByRole('button', { name: /^Delete permanently$/i }));

      await waitFor(() => {
        const lastCallUrl = vi.mocked(apiClient.delete).mock.calls.at(-1)?.[0] as string;
        expect(lastCallUrl).toContain('/providers/prov-1');
        expect(lastCallUrl).toContain('permanent=true');
      });
    });

    it('surfaces the server 409 message in the dialog when references block the delete', async () => {
      const { apiClient, APIClientError } = await import('@/lib/api/client');
      vi.mocked(apiClient.delete).mockRejectedValue(
        new APIClientError(
          "Cannot permanently delete 'anthropic' — it is referenced by 3 agents and 0 cost log rows. Re-point or clear those first, or deactivate instead.",
          'CONFLICT',
          409
        )
      );

      const user = userEvent.setup();
      render(<ProvidersList initialProviders={THREE_PROVIDERS} />);

      await openPermanentDialog(user);
      await user.click(screen.getByRole('button', { name: /^Delete permanently$/i }));

      await waitFor(() => {
        expect(screen.getByText(/3 agents/i)).toBeInTheDocument();
      });
    });
  });

  // ── Circuit breaker badge ─────────────────────────────────────────────────

  describe('circuit breaker badge', () => {
    it('shows "Circuit open" badge when breaker state is open', () => {
      const provider = makeProvider({
        circuitBreaker: { state: 'open', failureCount: 5, openedAt: '2025-01-01T00:00:00Z' },
      });
      render(<ProvidersList initialProviders={[provider]} />);

      expect(screen.getByText(/circuit open/i)).toBeInTheDocument();
    });

    it('shows "Circuit half-open" badge when breaker state is half-open', () => {
      const provider = makeProvider({
        circuitBreaker: { state: 'half-open', failureCount: 3, openedAt: null },
      });
      render(<ProvidersList initialProviders={[provider]} />);

      expect(screen.getByText(/circuit half-open/i)).toBeInTheDocument();
    });

    it('does not show breaker badge when state is closed', () => {
      const provider = makeProvider({
        circuitBreaker: { state: 'closed', failureCount: 0, openedAt: null },
      });
      render(<ProvidersList initialProviders={[provider]} />);

      expect(screen.queryByText(/circuit open/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/circuit half-open/i)).not.toBeInTheDocument();
    });

    it('Reset button calls POST /providers/:id/health', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({
        state: 'closed',
        failureCount: 0,
        openedAt: null,
      });

      const provider = makeProvider({
        circuitBreaker: { state: 'open', failureCount: 5, openedAt: '2025-01-01T00:00:00Z' },
      });
      const user = userEvent.setup();
      render(<ProvidersList initialProviders={[provider]} />);

      await user.click(screen.getByRole('button', { name: /reset/i }));

      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          expect.stringContaining('/providers/prov-1/health'),
          expect.anything()
        );
      });

      // Badge should disappear after successful reset
      await waitFor(() => {
        expect(screen.queryByText(/circuit open/i)).not.toBeInTheDocument();
      });
    });
  });

  // ── Circuit breaker reset error ────────────────────────────────────────────

  describe('circuit breaker reset error', () => {
    it('shows error banner when breaker reset fails with APIClientError', async () => {
      const { apiClient, APIClientError } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockRejectedValue(
        new APIClientError('Upstream timeout', 'TIMEOUT', 504)
      );

      const provider = makeProvider({
        circuitBreaker: { state: 'open', failureCount: 5, openedAt: '2025-01-01T00:00:00Z' },
      });
      const user = userEvent.setup();
      render(<ProvidersList initialProviders={[provider]} />);

      await user.click(screen.getByRole('button', { name: /reset/i }));

      await waitFor(() => {
        expect(screen.getByText('Upstream timeout')).toBeInTheDocument();
      });
    });

    it('shows generic error banner when breaker reset fails with unknown error', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockRejectedValue(new Error('network'));

      const provider = makeProvider({
        circuitBreaker: { state: 'open', failureCount: 5, openedAt: '2025-01-01T00:00:00Z' },
      });
      const user = userEvent.setup();
      render(<ProvidersList initialProviders={[provider]} />);

      await user.click(screen.getByRole('button', { name: /reset/i }));

      await waitFor(() => {
        expect(screen.getByText(/couldn't reset the circuit breaker/i)).toBeInTheDocument();
      });
    });
  });

  // ── View models dialog ──────────────────────────────────────────────────────

  describe('view models dialog', () => {
    it('opens models dialog from dropdown menu', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(MOCK_MODELS_RESPONSE);

      const user = userEvent.setup();
      render(<ProvidersList initialProviders={[THREE_PROVIDERS[0]]} />);

      const moreBtn = document.querySelector('button[aria-haspopup="menu"]')!;
      await user.click(moreBtn as HTMLElement);

      const viewModels = await screen.findByRole('menuitem', { name: /view models/i });
      await user.click(viewModels);

      await waitFor(() => {
        expect(screen.getByText('Model catalogue')).toBeInTheDocument();
      });
    });
  });

  // ── Reactivate action ─────────────────────────────────────────────────────

  describe('reactivate action', () => {
    it('shows Reactivate menu item for inactive providers', async () => {
      const inactiveProvider = makeProvider({ isActive: false });
      const user = userEvent.setup();
      render(<ProvidersList initialProviders={[inactiveProvider]} />);

      const moreBtn = document.querySelector('button[aria-haspopup="menu"]')!;
      await user.click(moreBtn as HTMLElement);

      expect(await screen.findByRole('menuitem', { name: /reactivate/i })).toBeInTheDocument();
    });

    it('does NOT show Reactivate menu item for active providers', async () => {
      const activeProvider = makeProvider({ isActive: true });
      const user = userEvent.setup();
      render(<ProvidersList initialProviders={[activeProvider]} />);

      const moreBtn = document.querySelector('button[aria-haspopup="menu"]')!;
      await user.click(moreBtn as HTMLElement);

      await waitFor(() => {
        expect(screen.queryByRole('menuitem', { name: /reactivate/i })).not.toBeInTheDocument();
      });
    });

    it('clicking Reactivate PATCHes isActive=true and updates card', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.patch).mockResolvedValue({ id: 'prov-1', isActive: true });

      const inactiveProvider = makeProvider({ isActive: false });
      const user = userEvent.setup();
      render(<ProvidersList initialProviders={[inactiveProvider]} />);

      const moreBtn = document.querySelector('button[aria-haspopup="menu"]')!;
      await user.click(moreBtn as HTMLElement);

      const reactivateItem = await screen.findByRole('menuitem', { name: /reactivate/i });
      await user.click(reactivateItem);

      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          expect.stringContaining('/providers/prov-1'),
          expect.objectContaining({ body: { isActive: true } })
        );
      });
    });
  });
});
