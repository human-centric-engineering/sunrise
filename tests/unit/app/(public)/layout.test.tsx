// @vitest-environment happy-dom

/**
 * Public layout — when it offers the visitor's language switch (§138 t-1073).
 *
 * The switch shows only with more than one language and only to a visitor who
 * has not signed in: a signed-in user's own choice outranks the cookie it sets.
 * The switch's own behaviour is in tests/unit/components/layouts/language-switch.test.tsx.
 *
 * @see app/(public)/layout.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

const { mockRequestPrincipal, mockLocaleOptions, mockWarn } = vi.hoisted(() => ({
  mockRequestPrincipal: vi.fn(),
  mockLocaleOptions: vi.fn(),
  mockWarn: vi.fn(),
}));

vi.mock('@/lib/auth/admin-page-viewer', () => ({ requestPrincipal: mockRequestPrincipal }));
vi.mock('@/lib/i18n/locale-options', () => ({ localeOptions: mockLocaleOptions }));
vi.mock('@/lib/logging', () => ({
  logger: { warn: mockWarn, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// The shell around the switch reads the database and the session; stub it.
vi.mock('@/components/maintenance-wrapper', () => ({
  MaintenanceWrapper: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/layouts/app-header', () => ({ AppHeader: () => null }));
vi.mock('@/components/layouts/public-nav', () => ({ PublicNav: () => null }));
vi.mock('@/components/layouts/public-footer', () => ({
  PublicFooter: ({ languageSwitch }: { languageSwitch?: ReactNode }) => (
    <footer>{languageSwitch}</footer>
  ),
}));
vi.mock('@/components/layouts/language-switch', () => ({
  LanguageSwitch: ({
    options,
    current,
  }: {
    options: { tag: string; name: string }[];
    current: string;
  }) => (
    <div data-testid="language-switch" data-current={current}>
      {options.map((o) => o.name).join(',')}
    </div>
  ),
}));

import PublicLayout from '@/app/(public)/layout';

const TWO = [
  { tag: 'en', name: 'English' },
  { tag: 'fr', name: 'Français' },
];

async function renderLayout() {
  render(await PublicLayout({ children: <p>page</p> }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLocaleOptions.mockReturnValue(TWO);
  mockRequestPrincipal.mockResolvedValue(null);
});

describe('PublicLayout language switch', () => {
  it('offers a visitor the languages, with the one the page is in', async () => {
    await renderLayout();

    const sw = screen.getByTestId('language-switch');
    expect(sw).toHaveTextContent('English,Français');
    // The global next-intl/server mock resolves every request to `en`.
    expect(sw).toHaveAttribute('data-current', 'en');
    expect(screen.getByText('page')).toBeInTheDocument();
  });

  it('is not offered to a signed-in user', async () => {
    mockRequestPrincipal.mockResolvedValue({ principal: { userId: 'u1' }, scope: {} });

    await renderLayout();

    expect(screen.queryByTestId('language-switch')).not.toBeInTheDocument();
  });

  it('is not offered when there is only one language, and the session is not read', async () => {
    mockLocaleOptions.mockReturnValue([{ tag: 'en', name: 'English' }]);

    await renderLayout();

    expect(screen.queryByTestId('language-switch')).not.toBeInTheDocument();
    expect(mockRequestPrincipal).not.toHaveBeenCalled();
  });

  it('still offers it, and logs, when the session cannot be read', async () => {
    mockRequestPrincipal.mockRejectedValue(new Error('db down'));

    await renderLayout();

    expect(screen.getByTestId('language-switch')).toBeInTheDocument();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('could not read the session'),
      expect.objectContaining({ error: 'db down' })
    );
  });
});
