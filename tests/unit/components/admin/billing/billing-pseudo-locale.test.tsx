// @vitest-environment happy-dom

/**
 * The billing page's content under the pseudo-locale (§139 t-1095).
 *
 * Every catalogue string comes out accented and bracketed (`Billing` →
 * `[ßîļļîñĝ]`), so English that survives is English that never reached the
 * catalogue, and a raw `admin.billing.…` key is one the catalogue lacks.
 * Rendered for an OWNER with every section and button showing, and for an
 * ADMIN read-only. The app's own words (plan and meter labels) are the
 * app's, used as given.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('next-intl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next-intl')>();
  const { messagesFor } = await import('@/lib/i18n/catalogue');
  const { I18N_FORMATS } = await import('@/lib/i18n/format');
  const messages = messagesFor('en-XA');
  return {
    ...actual,
    useTranslations: (namespace?: string) =>
      actual.createTranslator({
        locale: 'en-XA',
        messages,
        namespace: namespace as never,
        formats: I18N_FORMATS,
        timeZone: 'UTC',
      }),
    useFormatter: () =>
      actual.createFormatter({ locale: 'en-XA', formats: I18N_FORMATS, timeZone: 'UTC' }),
    useLocale: () => 'en-XA',
  };
});

import { BillingSummary, type OrgBillingView } from '@/components/admin/billing/billing-summary';

const BASE: OrgBillingView = {
  orgId: 'cmorg000000000000000other',
  plan: { key: 'pro', label: 'PLANLABEL', description: '' },
  subscription: {
    status: 'PAST_DUE',
    providerManaged: false,
    elsewhere: false,
    assignedByHand: false,
    cancelAtPeriodEnd: true,
    periodStart: '2026-11-01T00:00:00.000Z',
    periodEnd: '2026-12-01T00:00:00.000Z',
  },
  usage: [
    {
      key: 'seats',
      label: 'METERLABEL',
      description: '',
      period: 'month',
      limit: null,
      used: null,
      countFailed: true,
    },
  ],
  plans: [
    { key: 'pro', label: 'PLANLABEL', description: '', current: true },
    { key: 'team', label: 'OTHERPLAN', description: '', current: false },
  ],
  mayChange: true,
  portalAvailable: true,
  customerElsewhere: false,
  installOrg: false,
  signupPlan: null,
};

/** The rendered text with the app's own labels taken out. */
function platformText(container: HTMLElement): string {
  return (container.textContent ?? '').replace(/PLANLABEL|OTHERPLAN|METERLABEL/g, '');
}

describe('the billing page under the pseudo-locale', () => {
  it.each([
    ['an OWNER', BASE],
    ['an ADMIN', { ...BASE, mayChange: false }],
  ])('renders for %s with no raw key and no English left', (_who, billing) => {
    const { container } = render(<BillingSummary billing={billing} />);
    const text = platformText(container);

    expect(text).not.toMatch(/admin\.billing\./);
    // Words from each section, in English, would mean a string the catalogue never saw.
    for (const english of ['Your plan', 'Usage', 'Plans', 'Manage billing', 'Payment overdue']) {
      expect(text).not.toContain(english);
    }
    expect(text).toMatch(/\[/);
  });
});
