// @vitest-environment happy-dom

/**
 * Admin — AI keys page (§137 t-1045).
 *
 * A thin shell over `GET /api/v1/orgs/[id]/provider-keys`, so what is under
 * test is what it chooses to show: the list, with saving offered only when
 * the API says it is not blocked, and the reason in words when it is —
 * switched off, no master key, a support session. At `single`, with no org,
 * and in the install org it explains and fetches nothing. Keys that cannot be
 * loaded are an alert, never an empty list. Only `serverFetch` is faked.
 *
 * @see app/admin/provider-keys/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/auth/admin-page-viewer', () => ({ requestActingOrg: vi.fn() }));

vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
}));

const multi = vi.hoisted(() => ({ on: true }));
vi.mock('@/lib/tenancy/context', () => ({ isMultiTenant: () => multi.on }));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const listProps = vi.fn();
vi.mock('@/components/admin/provider-keys/provider-keys-list', () => ({
  ProviderKeysList: (props: unknown) => {
    listProps(props);
    return <div data-testid="keys-list" />;
  },
}));

import ProviderKeysPage from '@/app/admin/provider-keys/page';
import { requestActingOrg } from '@/lib/auth/admin-page-viewer';
import { serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { apiFailure, apiSuccess } from '@/tests/helpers/api';

const ORG = { id: 'org-entered', name: 'Acme' };
const PROVIDERS = [
  {
    providerConfigId: 'p1',
    name: 'Anthropic',
    slug: 'anthropic',
    approved: true,
    takesKey: true,
    key: null,
  },
];

function keysAre(saveBlocked: string | null, readOnly = false) {
  vi.mocked(serverFetch).mockResolvedValue(
    apiSuccess({ orgId: ORG.id, saveBlocked, readOnly, providers: PROVIDERS })
  );
}

describe('ProviderKeysPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    multi.on = true;
    vi.mocked(requestActingOrg).mockResolvedValue(ORG);
  });

  it('loads the entered org’s keys and offers saving when nothing blocks it', async () => {
    keysAre(null);

    render(await ProviderKeysPage());

    expect(vi.mocked(serverFetch).mock.calls[0][0]).toBe('/api/v1/orgs/org-entered/provider-keys');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('AI keys for Acme');
    expect(listProps).toHaveBeenCalledWith({
      orgId: ORG.id,
      providers: PROVIDERS,
      canSave: true,
      canChange: true,
      masterKeyMissing: false,
    });
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it.each([
    ['switched_off', /switched off on this platform/],
    ['master_key_missing', /nowhere to keep keys safely/],
    ['support_session', /as platform support.*cannot save or replace/],
  ])('says why saving is blocked (%s), and offers no saving', async (reason, sentence) => {
    keysAre(reason);

    render(await ProviderKeysPage());

    expect(screen.getByRole('note')).toHaveTextContent(sentence);
    expect(listProps).toHaveBeenCalledWith(expect.objectContaining({ canSave: false }));
  });

  it('tells a read-only support session it can change nothing, and lets it change nothing', async () => {
    keysAre('support_session', true);

    render(await ProviderKeysPage());

    expect(screen.getByRole('note')).toHaveTextContent(/read-only.*not test, replace or remove/);
    expect(listProps).toHaveBeenCalledWith(
      expect.objectContaining({ canSave: false, canChange: false })
    );
  });

  it('tells the list when no master key is configured', async () => {
    keysAre('master_key_missing');

    render(await ProviderKeysPage());

    expect(listProps).toHaveBeenCalledWith(expect.objectContaining({ masterKeyMissing: true }));
  });

  it('explains, and fetches nothing, in the install org', async () => {
    vi.mocked(requestActingOrg).mockResolvedValue({ id: INSTALL_ORG_ID, name: 'Default' });

    render(await ProviderKeysPage());

    expect(screen.getByText(/runs on the platform.s own keys/)).toBeInTheDocument();
    expect(serverFetch).not.toHaveBeenCalled();
    expect(listProps).not.toHaveBeenCalled();
  });

  it('explains, and fetches nothing, at single', async () => {
    multi.on = false;

    render(await ProviderKeysPage());

    expect(screen.getByText(/more than one organisation/)).toBeInTheDocument();
    expect(serverFetch).not.toHaveBeenCalled();
  });

  it('explains, and fetches nothing, with no org entered', async () => {
    vi.mocked(requestActingOrg).mockResolvedValue(null);

    render(await ProviderKeysPage());

    expect(screen.getByText(/not acting in an organisation/)).toBeInTheDocument();
    expect(serverFetch).not.toHaveBeenCalled();
  });

  it('says so, and logs, when the keys could not be loaded — never an empty list', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(500));

    render(await ProviderKeysPage());

    expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded');
    expect(listProps).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });
});
