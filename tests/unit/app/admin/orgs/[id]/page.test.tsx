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

const ID = 'cmorg00000000000000grant';
const ORG_PATH = `/api/v1/admin/orgs/${ID}`;
const POLICY_PATH = `/api/v1/admin/orgs/${ID}/providers`;
const PROVIDERS_PATH = '/api/v1/admin/orchestration/providers?page=1&limit=100';

/** Answer each path with its body; a path mapped to `null` is refused. */
function serve(bodies: Record<string, unknown>) {
  vi.mocked(serverFetch).mockImplementation(
    async (path: string) =>
      ({ ok: bodies[path] !== null && bodies[path] !== undefined, path }) as unknown as Response
  );
  vi.mocked(parseApiResponse).mockImplementation((async (res: { path: string }) => ({
    success: true,
    data: bodies[res.path],
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

  it('is a 404 when the org does not exist', async () => {
    serve({ [ORG_PATH]: null, [POLICY_PATH]: null, [PROVIDERS_PATH]: PROVIDERS });

    await expect(OrgPage({ params })).rejects.toThrow('NEXT_NOT_FOUND');
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
