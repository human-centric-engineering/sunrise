// @vitest-environment happy-dom

/**
 * Providers page — whether it offers the model audit (§116 t-725).
 *
 * The audit runs the install org's workflow and its two install-only agents,
 * which no other org has. The page reads which org the request acts for from
 * `getSharedSettingsAccess` (§107 t-753 — the read the admin layout makes
 * once per request) and passes `canAuditModels` down only for the install
 * org.
 *
 * @see app/admin/orchestration/providers/page.tsx
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(async () => ({ ok: true }) as unknown as Response),
  parseApiResponse: vi.fn(async () => ({ success: true, data: [] })),
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/lib/tenancy/shared-settings-access', () => ({
  getSharedSettingsAccess: vi.fn(),
}));

const tabsProps = vi.fn();
vi.mock('@/components/admin/orchestration/providers-tabs', () => ({
  ProvidersTabs: (props: Record<string, unknown>) => {
    tabsProps(props);
    return null;
  },
}));

import { getSharedSettingsAccess } from '@/lib/tenancy/shared-settings-access';

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
    vi.mocked(getSharedSettingsAccess).mockResolvedValue({
      isInstallOrg: true,
      readOnly: false,
      canSwitch: true,
    });

    expect(await renderedCanAudit()).toBe(true);
  });

  it('hides it in any other org, read-only or not', async () => {
    // At `multi` another org is read-only; at `single` a session pointing at
    // another org is not, and the audit is still the install org's.
    for (const readOnly of [true, false]) {
      vi.mocked(getSharedSettingsAccess).mockResolvedValue({
        isInstallOrg: false,
        readOnly,
        canSwitch: true,
      });

      expect(await renderedCanAudit()).toBe(false);
    }
  });
});
