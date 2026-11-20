// @vitest-environment happy-dom

/**
 * Which admin screens follow the viewer's language (§138 t-1074).
 *
 * Owner ruling at planning: the five org-settings pages, and the shell an org
 * admin sees on them, read from the catalogue; staff-only pages and nav
 * entries, and the orchestration console, stay literal English. Rendered here
 * under the pseudo-locale, where every catalogue string comes out accented
 * and bracketed (`Members` → `[Ṁéṁƀéŕš]`), so English that survives is
 * English that was never converted, and pseudo text on a staff screen is a
 * staff string that moved into the catalogue by mistake.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

const pathname = vi.hoisted(() => ({ current: '/admin/members' }));
vi.mock('next/navigation', () => ({
  usePathname: () => pathname.current,
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/components/layouts/header-actions', () => ({ HeaderActions: () => null }));

// The pseudo-locale's catalogue in place of the source English.
vi.mock('next-intl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next-intl')>();
  const { messagesFor } = await import('@/lib/i18n/catalogue');
  const messages = messagesFor('en-XA');
  return {
    ...actual,
    useTranslations: (namespace?: string) =>
      actual.createTranslator({
        locale: 'en-XA',
        messages,
        namespace: namespace as never,
        timeZone: 'UTC',
      }),
    useFormatter: () => actual.createFormatter({ locale: 'en-XA', timeZone: 'UTC' }),
    useLocale: () => 'en-XA',
  };
});

import { AdminSidebar } from '@/components/admin/admin-sidebar';
import { AdminHeader } from '@/components/admin/admin-header';
import { FeatureFlagsPage } from '@/components/admin/feature-flags-page';
import { ORG_TIER_ADMIN_PAGES } from '@/lib/auth/admin-tier';
import { pseudoLocalizeMessage } from '@/lib/i18n/pseudo';

const pseudo = (english: string) => pseudoLocalizeMessage(english);

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true, data: [], meta: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    )
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the admin console under the pseudo-locale', () => {
  it('shows the org-settings items in the viewer’s language and the staff items in English', () => {
    render(<AdminSidebar reach="platform" orgTierPages={ORG_TIER_ADMIN_PAGES} multiTenant />);
    const nav = screen.getByRole('navigation');

    for (const english of ['Members', 'Options', 'AI keys', 'Support access']) {
      expect(within(nav).getByRole('link', { name: pseudo(english) })).toBeInTheDocument();
    }
    expect(within(nav).getByText(pseudo('Management'))).toBeInTheDocument();
    // Staff-only, and the orchestration console: literal English.
    for (const english of ['Users', 'Organisations', 'Feature Flags', 'Logs', 'Agents']) {
      expect(within(nav).getByRole('link', { name: english })).toBeInTheDocument();
    }
    expect(within(nav).getByText('System')).toBeInTheDocument();
  });

  it('names an org-settings page in the viewer’s language and a staff page in English', () => {
    pathname.current = '/admin/support-access';
    const { unmount } = render(<AdminHeader orgTierPages={ORG_TIER_ADMIN_PAGES} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(pseudo('Support access'));
    unmount();

    pathname.current = '/admin/users';
    render(<AdminHeader orgTierPages={ORG_TIER_ADMIN_PAGES} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Users$/);
  });

  it('renders a staff-only page in English', async () => {
    render(<FeatureFlagsPage />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const text = document.body.textContent ?? '';
    expect(text).toContain('Feature Flags');
    // No catalogue string on the page: pseudo text is always bracketed.
    expect(text).not.toMatch(/\[[^\]]*[À-ɏḀ-ỿ][^\]]*\]/);
  });
});
