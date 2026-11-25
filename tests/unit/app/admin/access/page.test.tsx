// @vitest-environment happy-dom

/**
 * Admin — the access explainer page (§143 t-1091).
 *
 * A shell over `GET /api/v1/admin/access`: what the route returns is what it
 * renders, a response that cannot be loaded or does not match the schema is
 * said to be unavailable (and logged), and the org is named only to a viewer
 * who is not the platform. Only `serverFetch` is faked: the real parser,
 * `loadServerData` and the schema run. Who reaches the page is the layout's
 * (`tests/unit/app/admin/layout.test.tsx`); each viewer's slice is the view's
 * and the read model's.
 *
 * @see app/admin/access/page.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/auth/admin-page-viewer', () => ({ requestActingOrg: vi.fn() }));
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import AccessExplainerPage, { generateMetadata } from '@/app/admin/access/page';
import { requestActingOrg } from '@/lib/auth/admin-page-viewer';
import { serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { env } from '@/lib/env';
import { apiFailure, apiSuccess } from '@/tests/helpers/api';

const ORG_VIEW = {
  audience: 'org',
  tenancy: 'multi',
  sections: ['your-access', 'roles'],
  you: {
    audience: 'org',
    orgRole: 'ADMIN',
    tiers: ['org'],
    switchesOn: [],
    switchesUnreadable: false,
    supportEntry: false,
    tierLabels: { org: 'Owners and admins' },
    switchLabels: {},
    anySwitches: false,
  },
  roles: [
    { key: 'admin', kind: 'org-role', label: 'Admin', description: 'Helps run it.', held: true },
  ],
  appSections: [],
};

let previousMode: typeof env.TENANCY_MODE;

beforeEach(() => {
  vi.clearAllMocks();
  previousMode = env.TENANCY_MODE;
  env.TENANCY_MODE = 'multi';
  vi.mocked(requestActingOrg).mockResolvedValue({ id: 'org-1', name: 'Acme' });
});
afterEach(() => {
  env.TENANCY_MODE = previousMode;
});

describe('AccessExplainerPage', () => {
  it('reads the explainer route and renders what it returned, naming the org', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(ORG_VIEW));

    render(await AccessExplainerPage());

    expect(vi.mocked(serverFetch).mock.calls[0][0]).toBe('/api/v1/admin/access');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Who can do what');
    expect(screen.getByRole('heading', { name: 'Your access in Acme' })).toBeInTheDocument();
    expect(screen.getByText('Your role here: Admin')).toBeInTheDocument();
    // Only the sections the route returned.
    expect(screen.queryByRole('heading', { name: 'Pages by area' })).not.toBeInTheDocument();
  });

  it('leaves the org’s name out, not the page, when the org cannot be read', async () => {
    vi.mocked(requestActingOrg).mockRejectedValue(new Error('db down'));
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(ORG_VIEW));

    render(await AccessExplainerPage());

    expect(screen.getByRole('heading', { name: 'Your access' })).toBeInTheDocument();
    expect(screen.getByText('Your role here: Admin')).toBeInTheDocument();
  });

  it('does not look the org up at single, where there is one', async () => {
    env.TENANCY_MODE = 'single';
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(ORG_VIEW));

    render(await AccessExplainerPage());

    expect(requestActingOrg).not.toHaveBeenCalled(); // test-review:accept no_arg_called — at single the page must not read the org;
    expect(screen.getByRole('heading', { name: 'Your access' })).toBeInTheDocument();
  });

  it('names no org to a platform admin', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      apiSuccess({
        ...ORG_VIEW,
        audience: 'platform',
        you: { ...ORG_VIEW.you, audience: 'platform', tiers: 'platform' },
      })
    );

    render(await AccessExplainerPage());

    expect(screen.getByRole('heading', { name: 'Your access' })).toBeInTheDocument();
  });

  it('says the explainer is unavailable, and logs, when the route fails', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(500));

    render(await AccessExplainerPage());

    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load who can do what");
    expect(logger.error).toHaveBeenCalled();
  });

  it('treats a response that does not match the schema as a failure, not as an empty page', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess({ ...ORG_VIEW, sections: 'all' }));

    render(await AccessExplainerPage());

    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load who can do what");
    expect(logger.error).toHaveBeenCalledWith(
      'access explainer: the response did not match its schema',
      expect.objectContaining({ issues: expect.any(Array) })
    );
  });

  it('takes its title from the catalogue', async () => {
    expect(await generateMetadata()).toEqual({
      title: 'Who can do what',
      description: 'Who can open each part of the admin console, and what decides it.',
    });
  });
});
