// @vitest-environment happy-dom

/**
 * About, contact, privacy and terms pages (§138 t-1073).
 *
 * Each page reads its text and its metadata from the catalogue. The
 * expectations are taken from `en.json` itself, so they hold whatever the
 * placeholder copy says, and fail if a page stops reading a key.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import en from '@/lib/i18n/messages/en.json';
import { BRAND } from '@/lib/brand';
import AboutPage, { generateMetadata as aboutMetadata } from '@/app/(public)/about/page';
import ContactPage, { generateMetadata as contactMetadata } from '@/app/(public)/contact/page';
import PrivacyPage, { generateMetadata as privacyMetadata } from '@/app/(public)/privacy/page';
import TermsPage, { generateMetadata as termsMetadata } from '@/app/(public)/terms/page';

// The form has its own tests; here it only has to be on the page.
vi.mock('@/components/forms/contact-form', () => ({
  ContactForm: () => <form aria-label="contact form" />,
}));

const brand = (s: string) => s.replace('{brand}', BRAND.name);

describe('privacy page', () => {
  it('renders every section from the catalogue', async () => {
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
    render(await PrivacyPage());

    expect(screen.getByText('Last updated: January 19, 2026')).toBeInTheDocument();
  });

  it('links the contact address inside the translated sentence', async () => {
    render(await PrivacyPage());

    const link = screen.getByRole('link', { name: 'privacy@example.com' });
    expect(link).toHaveAttribute('href', 'mailto:privacy@example.com');
    expect(link.closest('p')).toHaveTextContent(/^If you have questions about this Privacy Policy/);
  });

  it('builds its metadata from the catalogue', async () => {
    const meta = await privacyMetadata();

    expect(meta.title).toBe(en.legal.privacy.meta.title);
    expect(meta.description).toBe(brand(en.legal.privacy.meta.description));
    expect(meta.openGraph).toMatchObject({ title: brand(en.legal.privacy.meta.socialTitle) });
  });
});

describe('terms page', () => {
  it('renders every section from the catalogue', async () => {
    render(await TermsPage());

    expect(
      screen.getByRole('heading', { level: 1, name: en.legal.terms.title })
    ).toBeInTheDocument();
    for (const section of Object.values(en.legal.terms.sections)) {
      expect(screen.getByRole('heading', { level: 2, name: section.title })).toBeInTheDocument();
    }
  });

  it('builds its metadata from the catalogue', async () => {
    const meta = await termsMetadata();

    expect(meta.title).toBe(en.legal.terms.meta.title);
    expect(meta.description).toBe(brand(en.legal.terms.meta.description));
  });
});

describe('about page', () => {
  it('renders its headings from the catalogue', async () => {
    render(await AboutPage());

    expect(
      screen.getByRole('heading', { name: en.marketing.about.mission.title })
    ).toBeInTheDocument();
  });

  it('builds its metadata from the catalogue', async () => {
    const meta = await aboutMetadata();

    expect(meta.title).toBe(en.marketing.about.meta.title);
  });
});

describe('contact page', () => {
  it('renders its heading and the form', async () => {
    render(await ContactPage());

    expect(
      screen.getByRole('heading', { level: 1, name: en.marketing.contact.title })
    ).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'contact form' })).toBeInTheDocument();
  });

  it('builds its metadata from the catalogue', async () => {
    const meta = await contactMetadata();

    expect(meta.title).toBe(en.marketing.contact.meta.title);
  });
});
