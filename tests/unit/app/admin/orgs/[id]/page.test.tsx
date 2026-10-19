// @vitest-environment happy-dom

/**
 * Admin — one organisation (§120 t-745): the org, its approved providers,
 * the provider list and its usage this month against its cap (§110 t-790),
 * fetched in parallel.
 *
 * The org is the detail record: only a 404 (or an id that cannot name an org,
 * a 400) is the not-found page, and any other failure throws to the error
 * boundary (#518). The policy, providers and usage keep their own "could not
 * be loaded" text, and every failure is logged. Only `serverFetch` is faked:
 * the real parser and `lib/api/server-load.ts` run.
 *
 * @see app/admin/orgs/[id]/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Only the network is faked: the real parseApiResponse and server-load run.
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/api/client', () => ({
  apiClient: { put: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

vi.mock('next/navigation', () => ({
  unstable_rethrow: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import OrgPage from '@/app/admin/orgs/[id]/page';
import { notFound } from 'next/navigation';
import { serverFetch } from '@/lib/api/server-fetch';
import { ServerLoadError } from '@/lib/api/server-load';
import { logger } from '@/lib/logging';
import { apiFailure, apiSuccess, apiIdRejected } from '@/tests/helpers/api';

const ID = 'cmorg00000000000000grant';
const ORG_PATH = `/api/v1/admin/orgs/${ID}`;
const POLICY_PATH = `/api/v1/admin/orgs/${ID}/providers`;
const PROVIDERS_PATH = '/api/v1/admin/orchestration/providers?page=1&limit=100';
const USAGE_PATH = `/api/v1/admin/orchestration/costs/orgs?orgId=${ID}`;

/**
 * Answer each path with its body. A path mapped to `null` (or not mapped) is a
 * 404; one mapped to a number is that HTTP status. `metas` gives a path's
 * pagination meta.
 */
function serve(bodies: Record<string, unknown>, metas: Record<string, unknown> = {}) {
  vi.mocked(serverFetch).mockImplementation(async (path: string) => {
    const data = bodies[path];
    if (data === null || data === undefined) return apiFailure(404, 'NOT_FOUND');
    if (typeof data === 'number') return apiFailure(data);
    if (data instanceof Response) return data.clone();
    // A list with no meta given is one complete page, as the API reports it.
    const meta =
      metas[path] ??
      (Array.isArray(data)
        ? { page: 1, limit: 100, total: data.length, totalPages: 1 }
        : undefined);
    return apiSuccess(data, meta);
  });
}

const ORG = { id: ID, slug: 'acme', name: 'Acme', status: 'ACTIVE', members: [{ id: 'u1' }] };
const POLICY = {
  orgId: ID,
  unrestricted: false,
  enforced: true,
  approved: [{ id: 'id-anthropic', slug: 'anthropic' }],
  jurisdictions: null,
};
const PROVIDERS = [
  { id: 'id-anthropic', slug: 'anthropic', name: 'Anthropic', isActive: true, jurisdiction: null },
  { id: 'id-openai', slug: 'openai', name: 'OpenAI', isActive: true, jurisdiction: null },
];

const params = Promise.resolve({ id: ID });

describe('OrgPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the org and its approved providers for editing', async () => {
    serve({ [ORG_PATH]: ORG, [POLICY_PATH]: POLICY, [PROVIDERS_PATH]: PROVIDERS });

    render(await OrgPage({ params }));

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Acme');
    expect(screen.getByText(/1 member$/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Anthropic/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /OpenAI/ })).not.toBeChecked();
  });

  it('marks a suspended org, and counts its members', async () => {
    serve({
      [ORG_PATH]: { ...ORG, status: 'SUSPENDED', members: [{ id: 'u1' }, { id: 'u2' }] },
      [POLICY_PATH]: POLICY,
      [PROVIDERS_PATH]: PROVIDERS,
    });

    render(await OrgPage({ params }));

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('suspended');
    expect(screen.getByText(/2 members$/)).toBeInTheDocument();
  });

  it('treats a fetch that throws as not loaded, and logs which one', async () => {
    serve({ [ORG_PATH]: ORG, [PROVIDERS_PATH]: PROVIDERS });
    const answer = vi.mocked(serverFetch).getMockImplementation()!;
    vi.mocked(serverFetch).mockImplementation(async (path: string) => {
      if (path === POLICY_PATH) throw new Error('network');
      return answer(path);
    });

    render(await OrgPage({ params }));

    expect(screen.getByText(/approved providers could not be loaded/)).toBeInTheDocument();
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), expect.any(Error), {
      path: POLICY_PATH,
    });
  });

  it('is a 404 when the org does not exist', async () => {
    serve({ [ORG_PATH]: null, [POLICY_PATH]: null, [PROVIDERS_PATH]: PROVIDERS });

    await expect(OrgPage({ params })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalledOnce();
  });

  it('is a 404 when the id cannot name an org (the API answers 400)', async () => {
    serve({
      [ORG_PATH]: apiIdRejected('query'),
      [POLICY_PATH]: apiIdRejected('query'),
      [PROVIDERS_PATH]: PROVIDERS,
    });

    await expect(OrgPage({ params })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('sends any other failure to load the org to the error boundary, not to a 404', async () => {
    serve({ [ORG_PATH]: 500, [POLICY_PATH]: POLICY, [PROVIDERS_PATH]: PROVIDERS });

    await expect(OrgPage({ params })).rejects.toBeInstanceOf(ServerLoadError);
    expect(notFound).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), undefined, {
      path: ORG_PATH,
      status: 500,
      code: 'INTERNAL_ERROR',
    });
  });

  it('sends a fetch that throws for the org to the error boundary', async () => {
    serve({ [POLICY_PATH]: POLICY, [PROVIDERS_PATH]: PROVIDERS });
    const answer = vi.mocked(serverFetch).getMockImplementation()!;
    vi.mocked(serverFetch).mockImplementation(async (path: string) => {
      if (path === ORG_PATH) throw new Error('ECONNREFUSED');
      return answer(path);
    });

    await expect(OrgPage({ params })).rejects.toBeInstanceOf(ServerLoadError);
    expect(notFound).not.toHaveBeenCalled();
  });

  it('lists providers from every page, so each can be granted or revoked', async () => {
    const PAGE_2 = '/api/v1/admin/orchestration/providers?page=2&limit=100';
    serve(
      {
        [ORG_PATH]: ORG,
        [POLICY_PATH]: POLICY,
        [PROVIDERS_PATH]: PROVIDERS,
        [PAGE_2]: [{ id: 'id-far', slug: 'far', name: 'Far', isActive: true, jurisdiction: null }],
      },
      {
        [PROVIDERS_PATH]: { page: 1, limit: 100, total: 101, totalPages: 2 },
        [PAGE_2]: { page: 2, limit: 100, total: 101, totalPages: 2 },
      }
    );

    render(await OrgPage({ params }));

    expect(screen.getByRole('checkbox', { name: /Anthropic/ })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Far/ })).toBeInTheDocument();
  });

  it('lists a provider once when a page boundary shifts between requests', async () => {
    const PAGE_2 = '/api/v1/admin/orchestration/providers?page=2&limit=100';
    serve(
      {
        [ORG_PATH]: ORG,
        [POLICY_PATH]: POLICY,
        [PROVIDERS_PATH]: PROVIDERS,
        // OpenAI slid onto page 2 as well, after a provider was created.
        [PAGE_2]: [PROVIDERS[1]],
      },
      {
        [PROVIDERS_PATH]: { page: 1, limit: 100, total: 101, totalPages: 2 },
        [PAGE_2]: { page: 2, limit: 100, total: 101, totalPages: 2 },
      }
    );

    render(await OrgPage({ params }));

    expect(screen.getAllByRole('checkbox', { name: /OpenAI/ })).toHaveLength(1);
  });

  it('withholds the form when the provider list does not say how many pages it has', async () => {
    serve(
      { [ORG_PATH]: ORG, [POLICY_PATH]: POLICY, [PROVIDERS_PATH]: PROVIDERS },
      { [PROVIDERS_PATH]: { malformed: true } }
    );

    render(await OrgPage({ params }));

    expect(screen.getByText(/approved providers could not be loaded/)).toBeInTheDocument();
  });

  it('withholds the form when a later page of providers fails', async () => {
    serve(
      { [ORG_PATH]: ORG, [POLICY_PATH]: POLICY, [PROVIDERS_PATH]: PROVIDERS },
      { [PROVIDERS_PATH]: { page: 1, limit: 100, total: 101, totalPages: 2 } }
    );

    render(await OrgPage({ params }));

    expect(screen.getByText(/approved providers could not be loaded/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('says the providers could not be loaded rather than offering an empty set to save', async () => {
    serve({ [ORG_PATH]: ORG, [POLICY_PATH]: 500, [PROVIDERS_PATH]: PROVIDERS });

    render(await OrgPage({ params }));

    expect(screen.getByText(/approved providers could not be loaded/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save/ })).not.toBeInTheDocument();
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), undefined, {
      path: POLICY_PATH,
      status: 500,
      code: 'INTERNAL_ERROR',
    });
  });

  it('says so when the provider list cannot be loaded either', async () => {
    serve({ [ORG_PATH]: ORG, [POLICY_PATH]: POLICY, [PROVIDERS_PATH]: null });

    render(await OrgPage({ params }));

    expect(screen.getByText(/approved providers could not be loaded/)).toBeInTheDocument();
  });

  describe('AI usage this month (§110 t-790)', () => {
    const USAGE = {
      period: '2026-10',
      periodStart: '2026-10-01T00:00:00.000Z',
      periodEnd: '2026-11-01T00:00:00.000Z',
      orgs: [
        {
          orgId: ID,
          name: 'Acme',
          slug: 'acme',
          status: 'ACTIVE',
          totalCostUsd: 40,
          inputTokens: 900,
          outputTokens: 100,
          count: 12,
          monthlyBudgetUsd: 50,
          utilisation: 0.8,
        },
      ],
      detached: null,
      totals: { totalCostUsd: 40, inputTokens: 900, outputTokens: 100, count: 12 },
    };

    it("shows the org's spend against its cap, from the usage endpoint narrowed to it", async () => {
      serve({
        [ORG_PATH]: ORG,
        [POLICY_PATH]: POLICY,
        [PROVIDERS_PATH]: PROVIDERS,
        [USAGE_PATH]: USAGE,
      });

      render(await OrgPage({ params }));

      expect(vi.mocked(serverFetch).mock.calls.map((call) => call[0])).toContain(USAGE_PATH);
      expect(screen.getByTestId('org-usage-summary')).toBeInTheDocument();
      expect(screen.getByText('Spend (2026-10)')).toBeInTheDocument();
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '80');
    });

    it('says usage is install-org only when the endpoint refuses the caller', async () => {
      serve({
        [ORG_PATH]: ORG,
        [POLICY_PATH]: POLICY,
        [PROVIDERS_PATH]: PROVIDERS,
        [USAGE_PATH]: 403,
      });

      render(await OrgPage({ params }));

      expect(
        screen.getByText('Usage can only be viewed from the install organisation.')
      ).toBeInTheDocument();
      expect(screen.queryByTestId('org-usage-summary')).not.toBeInTheDocument();
      // An expected refusal, not a failure.
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('says the usage could not be loaded when the fetch fails, and still renders the rest', async () => {
      serve({
        [ORG_PATH]: ORG,
        [POLICY_PATH]: POLICY,
        [PROVIDERS_PATH]: PROVIDERS,
        [USAGE_PATH]: 500,
      });

      render(await OrgPage({ params }));

      expect(screen.getByText(/usage could not be loaded/)).toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: /Anthropic/ })).toBeChecked();
      // Before #518 a non-OK usage answer was not logged.
      expect(logger.error).toHaveBeenCalledWith(expect.any(String), undefined, {
        path: USAGE_PATH,
        status: 500,
        code: 'INTERNAL_ERROR',
      });
    });
  });
});
