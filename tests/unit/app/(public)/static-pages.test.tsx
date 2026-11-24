// @vitest-environment happy-dom

/**
 * About, contact, privacy and terms pages (§138 t-1073).
 *
 * Each page reads its text and its metadata from the catalogue. The
 * expectations are taken from `en.json` itself, so they hold whatever the
 * placeholder copy says, and fail if a page stops reading a key.
 *
 * FORK NOTE (#1317): a page you have taken over with the CUSTOMIZATION.md §6
 * thin shim, or deleted, is skipped here, because its copy is yours. That
 * holds once `lib/app/reserved-tiers.ts` declares the tier you fill, which a
 * §6 shim's `components/app` already requires. Each page is imported only
 * once it is known to be the platform's, so a shim's different exports cannot
 * fail type-check or the import. You should not need to edit this file; see
 * `tests/helpers/marketing-pages.ts`.
 */

import { existsSync } from 'node:fs';
import type { Metadata } from 'next';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import en from '@/lib/i18n/messages/en.json';
import { BRAND } from '@/lib/brand';
import {
  isPlatformMarketingPage,
  marketingPageFile,
  type MarketingPage,
} from '@/tests/helpers/marketing-pages';

interface PageModule {
  default: () => Promise<ReactElement>;
  generateMetadata: () => Promise<Metadata>;
}

function isPageModule(mod: unknown): mod is PageModule {
  if (typeof mod !== 'object' || mod === null) return false;
  return (
    'default' in mod &&
    typeof mod.default === 'function' &&
    'generateMetadata' in mod &&
    typeof mod.generateMetadata === 'function'
  );
}

/**
 * Import a platform marketing page by route segment. The specifier is built at
 * runtime on purpose: a literal one is resolved by type-check, which is what
 * broke on a fork's shim (TS2614) or deleted page (TS2307).
 */
async function loadPage(page: MarketingPage): Promise<PageModule> {
  const file = `app/(public)/${page}/page.tsx`;
  if (!existsSync(marketingPageFile(page))) {
    throw new Error(
      `${file} is missing. Sunrise ships it, so upstream this is a defect. A fork that ` +
        'has deleted it declares its fork tier in lib/app/reserved-tiers.ts ' +
        '(see tests/helpers/marketing-pages.ts).'
    );
  }
  const mod: unknown = await import(`@/app/(public)/${page}/page.tsx`);
  if (!isPageModule(mod)) {
    throw new Error(
      `${file} must export a default page component and an async generateMetadata ` +
        '(not a static `metadata`), which is what this test renders and calls.'
    );
  }
  return mod;
}

const takenOver = (page: MarketingPage) => !isPlatformMarketingPage(page);

// The form has its own tests; here it only has to be on the page.
vi.mock('@/components/forms/contact-form', () => ({
  ContactForm: () => <form aria-label="contact form" />,
}));

const brand = (s: string) => s.replace('{brand}', BRAND.name);

describe.skipIf(takenOver('privacy'))('privacy page', () => {
  it('renders every section from the catalogue', async () => {
    const { default: PrivacyPage } = await loadPage('privacy');
    render(await PrivacyPage());

    expect(
      screen.getByRole('heading', { level: 1, name: en.legal.privacy.title })
    ).toBeInTheDocument();
    for (const section of Object.values(en.legal.privacy.sections)) {
      expect(screen.getByRole('heading', { level: 2, name: section.title })).toBeInTheDocument();
    }
    expect(screen.getByText(en.legal.privacy.sections.howWeUse.items.security)).toBeInTheDocument();
  });

  it('dates the policy with the named long format, in UTC', async () => {
    const { default: PrivacyPage } = await loadPage('privacy');
    render(await PrivacyPage());

    expect(screen.getByText('Last updated: January 19, 2026')).toBeInTheDocument();
  });

  it('links the contact address inside the translated sentence', async () => {
    const { default: PrivacyPage } = await loadPage('privacy');
    render(await PrivacyPage());

    const link = screen.getByRole('link', { name: 'privacy@example.com' });
    expect(link).toHaveAttribute('href', 'mailto:privacy@example.com');
    expect(link.closest('p')).toHaveTextContent(/^If you have questions about this Privacy Policy/);
  });

  it('builds its metadata from the catalogue', async () => {
    const meta = await (await loadPage('privacy')).generateMetadata();

    expect(meta.title).toBe(en.legal.privacy.meta.title);
    expect(meta.description).toBe(brand(en.legal.privacy.meta.description));
    expect(meta.openGraph).toMatchObject({ title: brand(en.legal.privacy.meta.socialTitle) });
  });
});

describe.skipIf(takenOver('terms'))('terms page', () => {
  it('renders every section from the catalogue', async () => {
    const { default: TermsPage } = await loadPage('terms');
    render(await TermsPage());

    expect(
      screen.getByRole('heading', { level: 1, name: en.legal.terms.title })
    ).toBeInTheDocument();
    for (const section of Object.values(en.legal.terms.sections)) {
      expect(screen.getByRole('heading', { level: 2, name: section.title })).toBeInTheDocument();
    }
  });

  it('builds its metadata from the catalogue', async () => {
    const meta = await (await loadPage('terms')).generateMetadata();

    expect(meta.title).toBe(en.legal.terms.meta.title);
    expect(meta.description).toBe(brand(en.legal.terms.meta.description));
  });
});

describe.skipIf(takenOver('about'))('about page', () => {
  it('renders its headings from the catalogue', async () => {
    const { default: AboutPage } = await loadPage('about');
    render(await AboutPage());

    expect(
      screen.getByRole('heading', { name: en.marketing.about.mission.title })
    ).toBeInTheDocument();
  });

  it('builds its metadata from the catalogue', async () => {
    const meta = await (await loadPage('about')).generateMetadata();

    expect(meta.title).toBe(en.marketing.about.meta.title);
  });
});

describe.skipIf(takenOver('contact'))('contact page', () => {
  it('renders its heading and the form', async () => {
    const { default: ContactPage } = await loadPage('contact');
    render(await ContactPage());

    expect(
      screen.getByRole('heading', { level: 1, name: en.marketing.contact.title })
    ).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'contact form' })).toBeInTheDocument();
  });

  it('builds its metadata from the catalogue', async () => {
    const meta = await (await loadPage('contact')).generateMetadata();

    expect(meta.title).toBe(en.marketing.contact.meta.title);
  });
});
