/**
 * Integration Test: Admin Orchestration — New Provider Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/providers/new/page.tsx`.
 *
 * Test Coverage:
 * - Renders the create-mode form shell
 * - All 4 flavor radio options render
 * - "Create provider" submit button visible
 * - Shows the getting-started hint card when no providers exist
 * - Hides the hint once at least one provider is configured
 *
 * NewProviderPage is an async server component — it awaits `getSetupState`
 * to decide whether to render the first-time hint.
 *
 * @see app/admin/orchestration/providers/new/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

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
    constructor(message: string) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

vi.mock('@/lib/orchestration/setup-state', () => ({
  getSetupState: vi.fn(),
}));

vi.mock('@/lib/orchestration/llm/known-providers', () => ({
  KNOWN_PROVIDERS: [
    {
      slug: 'anthropic',
      name: 'Anthropic',
      providerType: 'anthropic',
      defaultBaseUrl: null,
      apiKeyEnvVars: ['ANTHROPIC_API_KEY'],
      isLocal: false,
      suggestedDefaultChatModel: 'claude-sonnet-4-6',
      suggestedRoutingModel: null,
      suggestedReasoningModel: null,
      suggestedEmbeddingModel: null,
    },
  ],
  detectApiKeyEnvVar: vi.fn(() => 'ANTHROPIC_API_KEY'),
}));

// Imported after the vi.mock above so the page picks up the stub.
import { getSetupState } from '@/lib/orchestration/setup-state';

function mockSetupState(hasProvider: boolean): void {
  vi.mocked(getSetupState).mockResolvedValue({
    hasProvider,
    hasAgent: false,
    hasDefaultChatModel: false,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('NewProviderPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders all 4 flavor radio options', async () => {
    mockSetupState(false);
    const { default: NewProviderPage } =
      await import('@/app/admin/orchestration/providers/new/page');

    render(await NewProviderPage());

    await waitFor(() => {
      // Flavor radios are custom <button role="radio"> containing both label and description text.
      // Use getAllByRole and check for buttons whose span text matches the flavor label exactly.
      const radios = screen.getAllByRole('radio');
      const labels = radios.map((r) =>
        Array.from(r.querySelectorAll('span'))
          .map((s) => s.textContent?.trim())
          .filter(Boolean)
      );
      const flatLabels = labels.flat().map((l) => l.toLowerCase());
      expect(flatLabels).toContain('anthropic');
      expect(flatLabels).toContain('openai');
      expect(flatLabels.some((l) => l.includes('ollama'))).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
      expect(flatLabels.some((l) => l.includes('openai-compatible'))).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
    });
  });

  it('renders "Create provider" submit button', async () => {
    mockSetupState(false);
    const { default: NewProviderPage } =
      await import('@/app/admin/orchestration/providers/new/page');

    render(await NewProviderPage());

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /create provider/i })).toBeInTheDocument();
    });
  });

  it('mounts the create-provider button inside a <form> for native submit', async () => {
    mockSetupState(false);
    const { default: NewProviderPage } =
      await import('@/app/admin/orchestration/providers/new/page');

    render(await NewProviderPage());

    // querySelector('form').toBeTruthy() reports `expected null to be
    // truthy` on failure, which doesn't tell you which form went
    // missing. Anchor on the submit button (a contract this page
    // owns) and walk up to the form ancestor — that proves both that
    // the form mounts AND that pressing Enter / clicking submit will
    // trigger native submission, which the original test did not.
    const submit = screen.getByRole('button', { name: /create provider/i });
    expect(submit.closest('form')).not.toBeNull();
  });

  it('renders breadcrumb navigation links', async () => {
    mockSetupState(false);
    const { default: NewProviderPage } =
      await import('@/app/admin/orchestration/providers/new/page');

    render(await NewProviderPage());

    expect(screen.getByRole('link', { name: /ai orchestration/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /providers/i })).toBeInTheDocument();
  });

  it('shows the first-time hint when no providers exist', async () => {
    mockSetupState(false);
    const { default: NewProviderPage } =
      await import('@/app/admin/orchestration/providers/new/page');

    render(await NewProviderPage());

    expect(screen.getByText(/First time configuring a provider/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /setup wizard/i })).toBeInTheDocument();
  });

  it('hides the hint once at least one provider is configured', async () => {
    mockSetupState(true);
    const { default: NewProviderPage } =
      await import('@/app/admin/orchestration/providers/new/page');

    render(await NewProviderPage());

    expect(screen.queryByText(/First time configuring a provider/i)).not.toBeInTheDocument();
  });
});
