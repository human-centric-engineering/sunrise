// @vitest-environment happy-dom

/**
 * Providers page — whether it offers the model audit (§116 t-725).
 *
 * The audit runs the install org's workflow and its two install-only agents,
 * which no other org has. The page asks `GET /api/v1/orgs` which org the
 * request acts for and passes `canAuditModels` down only for the install
 * org; any failure to find out hides it.
 *
 * @see app/admin/orchestration/providers/page.tsx
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

import { API } from '@/lib/api/endpoints';

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

const tabsProps = vi.fn();
vi.mock('@/components/admin/orchestration/providers-tabs', () => ({
  ProvidersTabs: (props: Record<string, unknown>) => {
    tabsProps(props);
    return null;
  },
}));

import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';

/** Each fetched path answers with its own body; the orgs call with `orgs`. */
function answer(orgs: { ok: boolean; body?: unknown } | Error) {
  vi.mocked(serverFetch).mockImplementation(async (path: string) => {
    if (path === API.ORGS.LIST) {
      if (orgs instanceof Error) throw orgs;
      return { ok: orgs.ok, path } as unknown as Response;
    }
    return { ok: true, path } as unknown as Response;
  });
  vi.mocked(parseApiResponse).mockImplementation(async (res: Response) => {
    const { path } = res as unknown as { path: string };
    if (path === API.ORGS.LIST && !(orgs instanceof Error)) return orgs.body as never;
    return { success: true, data: [] } as never;
  });
}

async function renderedCanAudit(): Promise<unknown> {
  const { default: ProvidersListPage } = await import('@/app/admin/orchestration/providers/page');
  render(await ProvidersListPage());
  const props = tabsProps.mock.calls.at(-1)?.[0] as { canAuditModels: unknown };
  return props.canAuditModels;
}

describe('ProvidersListPage — model audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers the audit in the install org', async () => {
    answer({ ok: true, body: { success: true, data: { activeOrgId: 'install', orgs: [] } } });

    expect(await renderedCanAudit()).toBe(true);
  });

  it('hides it in any other org', async () => {
    answer({ ok: true, body: { success: true, data: { activeOrgId: 'org-b', orgs: [] } } });

    expect(await renderedCanAudit()).toBe(false);
  });

  it('hides it when the request acts for no org', async () => {
    answer({ ok: true, body: { success: true, data: { activeOrgId: null, orgs: [] } } });

    expect(await renderedCanAudit()).toBe(false);
  });

  it('hides it when the orgs call fails or throws', async () => {
    answer({ ok: false });
    expect(await renderedCanAudit()).toBe(false);

    answer(new Error('network'));
    expect(await renderedCanAudit()).toBe(false);
  });
});
