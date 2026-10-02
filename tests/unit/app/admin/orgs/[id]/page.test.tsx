// @vitest-environment happy-dom

/**
 * Admin — one organisation (§120 t-745): the org, its approved providers and
 * the provider list, fetched in parallel.
 *
 * @see app/admin/orgs/[id]/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/api/client', () => ({
  apiClient: { put: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

vi.mock('next/navigation', () => ({
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
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';

const ID = 'cmorg00000000000000grant';
const ORG_PATH = `/api/v1/admin/orgs/${ID}`;
const POLICY_PATH = `/api/v1/admin/orgs/${ID}/providers`;
const PROVIDERS_PATH = '/api/v1/admin/orchestration/providers?page=1&limit=100';

/**
 * Answer each path with its body. A path mapped to `null` (or not mapped) is a
 * 404; one mapped to a number is that HTTP status. `metas` gives a path's
 * pagination meta.
 */
function serve(bodies: Record<string, unknown>, metas: Record<string, unknown> = {}) {
  vi.mocked(serverFetch).mockImplementation(async (path: string) => {
    const body = bodies[path];
    const status =
      typeof body === 'number' ? body : body === null || body === undefined ? 404 : 200;
    return { ok: status === 200, status, path } as unknown as Response;
  });
  vi.mocked(parseApiResponse).mockImplementation((async (res: { path: string }) => ({
    success: true,
    data: bodies[res.path],
    meta: metas[res.path],
  })) as never);
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
    expect(logger.error).toHaveBeenCalledWith(
      'org page: provider policy fetch failed',
      expect.any(Error),
      { path: POLICY_PATH }
    );
  });

  it('is a 404 when the org does not exist', async () => {
    serve({ [ORG_PATH]: null, [POLICY_PATH]: null, [PROVIDERS_PATH]: PROVIDERS });

    await expect(OrgPage({ params })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('sends any other failure to load the org to the error boundary, not to a 404', async () => {
    serve({ [ORG_PATH]: 500, [POLICY_PATH]: POLICY, [PROVIDERS_PATH]: PROVIDERS });

    await expect(OrgPage({ params })).rejects.toThrow(
      'Organisation could not be loaded (HTTP 500)'
    );
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
    serve({ [ORG_PATH]: ORG, [POLICY_PATH]: null, [PROVIDERS_PATH]: PROVIDERS });

    render(await OrgPage({ params }));

    expect(screen.getByText(/approved providers could not be loaded/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save/ })).not.toBeInTheDocument();
  });

  it('says so when the provider list cannot be loaded either', async () => {
    serve({ [ORG_PATH]: ORG, [POLICY_PATH]: POLICY, [PROVIDERS_PATH]: null });

    render(await OrgPage({ params }));

    expect(screen.getByText(/approved providers could not be loaded/)).toBeInTheDocument();
  });
});
