// @vitest-environment happy-dom

/**
 * The access explainer under the pseudo-locale (§143 t-1091).
 *
 * Every catalogue string comes out accented and bracketed (`Roles` →
 * `[Ŕöļéš]`), so English that survives is English that never reached the
 * catalogue, and a raw `admin.access.…` key is one the catalogue lacks. The
 * explainer is built for each viewer with the pseudo catalogue, as the route
 * builds it in the viewer's language, and rendered with it.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

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
    useLocale: () => 'en-XA',
  };
});
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { createTranslator } from 'next-intl';
import { AccessExplainerView } from '@/components/admin/access-explainer/access-explainer-view';
import { AccessExplainerLink } from '@/components/admin/access-explainer/access-explainer-link';
import { LockedAdminPage } from '@/components/admin/locked-admin-page';
import { buildAccessExplainer, type AccessTranslator } from '@/lib/auth/access-explainer';
import type { AdminReach } from '@/lib/auth/admin-tier';
import { messagesFor } from '@/lib/i18n/catalogue';
import { pseudoLocalizeMessage } from '@/lib/i18n/pseudo';
import { accessExplainerResponseSchema } from '@/lib/validations/access-explainer';

const pseudo = (english: string) => pseudoLocalizeMessage(english);

function pseudoTranslator(): AccessTranslator {
  const t = createTranslator({ locale: 'en-XA', messages: messagesFor('en-XA'), timeZone: 'UTC' });
  return Object.assign((key: string) => t(key as never), {
    has: (key: string) => t.has(key as never),
  });
}

function explainerFor(reach: AdminReach, orgRole: string | null) {
  const built = buildAccessExplainer(
    { reach, orgRole, switchesOn: [], locked: [], supportEntry: false, multiTenant: true },
    pseudoTranslator()
  );
  return accessExplainerResponseSchema.parse(JSON.parse(JSON.stringify(built)));
}

describe('the access explainer under the pseudo-locale', () => {
  const VIEWERS: [string, AdminReach, string | null][] = [
    ['a platform admin', 'platform', null],
    ['an org admin', { tiers: ['org'], landing: null }, 'ADMIN'],
  ];
  it.each(VIEWERS)(
    'renders for %s with no raw key and its own words translated',
    (_l, reach, orgRole) => {
      const { container } = render(
        <AccessExplainerView explainer={explainerFor(reach, orgRole)} orgName="Acme" />
      );

      expect(container.textContent).not.toMatch(/admin\.access\./);
      expect(
        screen.getByRole('heading', { level: 2, name: pseudo('Platform roles') })
      ).toBeInTheDocument();
      expect(screen.queryByText('Platform roles')).not.toBeInTheDocument();
    }
  );

  it('translates the link the dashboards and the locked page carry', () => {
    const { container } = render(
      <>
        <AccessExplainerLink />
        <LockedAdminPage
          locked={{ requires: 'x', label: 'X', message: 'Not on your plan.', upgradeUrl: null }}
        />
      </>
    );

    expect(container.textContent).not.toMatch(/admin\.access\./);
    expect(screen.getAllByRole('link', { name: pseudo('See roles and access') })).toHaveLength(2);
  });
});
