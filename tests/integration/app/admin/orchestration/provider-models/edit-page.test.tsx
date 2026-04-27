/**
 * Integration Test: Admin Orchestration — Edit Provider Model Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/provider-models/[id]/page.tsx`.
 *
 * Test Coverage:
 * - Renders model name in heading
 * - Shows seed-managed warning when isDefault is true
 * - Hides seed-managed warning when isDefault is false
 * - Shows success banner when ?created=1 query param is present
 * - Hides success banner when ?created query param is absent
 * - Calls notFound() when model fetch returns null
 * - Graceful behaviour when fetch rejects
 *
 * @see app/admin/orchestration/provider-models/[id]/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockNotFound = vi.fn();

vi.mock('next/navigation', () => ({
  notFound: (...args: unknown[]) => {
    mockNotFound(...args);
    throw new Error('NEXT_NOT_FOUND');
  },
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
  useSearchParams: vi.fn(() => ({ get: vi.fn(() => null) })),
}));

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    withContext: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    })),
  },
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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeModel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'model-1',
    slug: 'openai-gpt-5',
    providerSlug: 'openai',
    modelId: 'gpt-5',
    name: 'GPT-5',
    description: 'Flagship model',
    capabilities: ['chat'],
    tierRole: 'thinking',
    reasoningDepth: 'very_high',
    latency: 'medium',
    costEfficiency: 'medium',
    contextLength: 'very_high',
    toolUse: 'strong',
    bestRole: 'Planner',
    isDefault: true,
    isActive: true,
    configured: true,
    configuredActive: true,
    dimensions: null,
    schemaCompatible: null,
    costPerMillionTokens: null,
    hasFreeTier: null,
    local: false,
    quality: null,
    strengths: null,
    setup: null,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EditProviderModelPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders model name in heading', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: makeModel(),
    } as never);

    const { default: EditPage } =
      await import('@/app/admin/orchestration/provider-models/[id]/page');

    render(
      await EditPage({
        params: Promise.resolve({ id: 'model-1' }),
        searchParams: Promise.resolve({}),
      })
    );

    expect(screen.getByRole('heading', { name: /GPT-5/i })).toBeInTheDocument();
  });

  it('shows seed-managed warning when isDefault is true', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: makeModel({ isDefault: true }),
    } as never);

    const { default: EditPage } =
      await import('@/app/admin/orchestration/provider-models/[id]/page');

    render(
      await EditPage({
        params: Promise.resolve({ id: 'model-1' }),
        searchParams: Promise.resolve({}),
      })
    );

    expect(screen.getByText(/seed-managed model/i)).toBeInTheDocument();
    expect(screen.getByText(/re-seeds will skip this row/i)).toBeInTheDocument();
  });

  it('hides seed-managed warning when isDefault is false', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: makeModel({ isDefault: false }),
    } as never);

    const { default: EditPage } =
      await import('@/app/admin/orchestration/provider-models/[id]/page');

    render(
      await EditPage({
        params: Promise.resolve({ id: 'model-1' }),
        searchParams: Promise.resolve({}),
      })
    );

    expect(screen.queryByText(/seed-managed model/i)).not.toBeInTheDocument();
  });

  it('shows success banner when ?created=1', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: makeModel(),
    } as never);

    const { default: EditPage } =
      await import('@/app/admin/orchestration/provider-models/[id]/page');

    render(
      await EditPage({
        params: Promise.resolve({ id: 'model-1' }),
        searchParams: Promise.resolve({ created: '1' }),
      })
    );

    expect(screen.getByText(/model created successfully/i)).toBeInTheDocument();
  });

  it('hides success banner when created param is absent', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: makeModel(),
    } as never);

    const { default: EditPage } =
      await import('@/app/admin/orchestration/provider-models/[id]/page');

    render(
      await EditPage({
        params: Promise.resolve({ id: 'model-1' }),
        searchParams: Promise.resolve({}),
      })
    );

    expect(screen.queryByText(/model created successfully/i)).not.toBeInTheDocument();
  });

  it('calls notFound() when model fetch returns null', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Not found' },
    } as never);

    const { default: EditPage } =
      await import('@/app/admin/orchestration/provider-models/[id]/page');

    await expect(
      EditPage({
        params: Promise.resolve({ id: 'nonexistent' }),
        searchParams: Promise.resolve({}),
      })
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockNotFound).toHaveBeenCalled(); // test-review:accept no_arg_called — callback-fired guard;
  });

  it('calls notFound() when serverFetch rejects', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockRejectedValue(new Error('Network error'));

    const { default: EditPage } =
      await import('@/app/admin/orchestration/provider-models/[id]/page');

    await expect(
      EditPage({
        params: Promise.resolve({ id: 'model-1' }),
        searchParams: Promise.resolve({}),
      })
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockNotFound).toHaveBeenCalled(); // test-review:accept no_arg_called — callback-fired guard;
  });

  it('calls notFound() when serverFetch returns not ok', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: false } as Response);

    const { default: EditPage } =
      await import('@/app/admin/orchestration/provider-models/[id]/page');

    await expect(
      EditPage({
        params: Promise.resolve({ id: 'model-1' }),
        searchParams: Promise.resolve({}),
      })
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockNotFound).toHaveBeenCalled(); // test-review:accept no_arg_called — callback-fired guard;
  });
});
