// @vitest-environment happy-dom

/**
 * ProvidersList — failed row actions (§124)
 *
 * A refused reactivate or breaker reset shows in the one box above the
 * provider grid and takes focus; each used to draw its own red box.
 *
 * @see components/admin/orchestration/providers-list.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ProvidersList, type ProviderRow } from '@/components/admin/orchestration/providers-list';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));

// The real APIClientError, so the list reads the failure as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

function provider(overrides: Partial<ProviderRow> = {}): ProviderRow {
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

describe('ProvidersList — failed row actions', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    const { apiClient } = await import('@/lib/api/client');
    // Background loads (model counts, auto-probe) never settle: not under test.
    vi.mocked(apiClient.get).mockImplementation(() => new Promise(() => {}));
    vi.mocked(apiClient.post).mockImplementation(() => new Promise(() => {}));
    // The detections banner's own fetch finds nothing to offer.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ success: true, data: { detected: [] } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
      )
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows a refused reactivate above the grid and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    // Refused after a round trip, as over the network: by then the menu has
    // closed and handed focus back to its trigger.
    vi.mocked(apiClient.patch).mockImplementation(
      () =>
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new APIClientError('API key env var is not set', 'VALIDATION_ERROR', 400)),
            20
          )
        )
    );
    const user = userEvent.setup();
    render(<ProvidersList initialProviders={[provider({ isActive: false })]} />);

    await user.click(document.querySelector<HTMLElement>('button[aria-haspopup="menu"]')!);
    await user.click(await screen.findByRole('menuitem', { name: /reactivate/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('API key env var is not set');
    expect(alert.nextElementSibling).toHaveTextContent('Anthropic');
    expect(alert).toHaveFocus();
  });

  it('shows a refused breaker reset in the same box', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockImplementation((url: string) =>
      url.includes('/health')
        ? Promise.reject(new APIClientError('Upstream timeout', 'TIMEOUT', 504))
        : new Promise(() => {})
    );
    const user = userEvent.setup();
    render(
      <ProvidersList
        initialProviders={[
          provider({
            circuitBreaker: { state: 'open', failureCount: 5, openedAt: '2025-01-01T00:00:00Z' },
          }),
        ]}
      />
    );

    await user.click(screen.getByRole('button', { name: /reset/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Upstream timeout');
    expect(alert).toHaveFocus();
  });
});
