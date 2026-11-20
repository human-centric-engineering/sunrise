import type { Metadata } from 'next';
import { getFormatter, getTranslations } from 'next-intl/server';
import { BRAND } from '@/lib/brand';

/** When this placeholder was last revised: a calendar date, so it is read in UTC. */
const LAST_UPDATED = new Date('2026-01-19T00:00:00Z');
const CONTACT_EMAIL = 'legal@example.com';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('legal.terms.meta');
  const description = t('description', { brand: BRAND.name });
  const socialTitle = t('socialTitle', { brand: BRAND.name });
  return {
    title: t('title'),
    description,
    openGraph: {
      title: socialTitle,
      description,
    },
    twitter: {
      card: 'summary',
      title: socialTitle,
      description,
    },
  };
}

/** The terms' sections in order, with the keys of the list items each one has. */
const SECTIONS = [
  { key: 'agreement', items: [] },
  {
    key: 'useOfService',
    items: [
      'useOfService.items.eligibility',
      'useOfService.items.registration',
      'useOfService.items.prohibited',
      'useOfService.items.userContent',
    ],
  },
  { key: 'intellectualProperty', items: [] },
  {
    key: 'payment',
    items: [
      'payment.items.billing',
      'payment.items.refunds',
      'payment.items.subscriptions',
      'payment.items.priceChanges',
    ],
  },
  { key: 'liability', items: [] },
  { key: 'termination', items: [] },
  { key: 'changes', items: [] },
] as const;

/**
 * Terms of Service Page
 *
 * Placeholder terms of service page.
 * Replace with your actual terms of service content (`legal.terms` in the catalogue).
 *
 * Phase 3.5: Landing Page & Marketing
 */
export default async function TermsOfServicePage() {
  const t = await getTranslations('legal');
  const ts = await getTranslations('legal.terms.sections');
  const format = await getFormatter();

  return (
    <div className="container mx-auto px-4 py-16 md:py-24">
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-8 text-4xl font-bold tracking-tight">{t('terms.title')}</h1>

        <div className="prose prose-neutral dark:prose-invert max-w-none">
          <p className="text-muted-foreground lead">
            {t('lastUpdated', { date: format.dateTime(LAST_UPDATED, 'long', { timeZone: 'UTC' }) })}
          </p>

          {SECTIONS.map(({ key, items }) => (
            <section key={key} className="mt-8">
              <h2>{ts(`${key}.title`)}</h2>
              <p>{ts(`${key}.body`)}</p>
              {items.length > 0 && (
                <ul>
                  {items.map((item) => (
                    <li key={item}>{ts(item)}</li>
                  ))}
                </ul>
              )}
            </section>
          ))}

          <section className="mt-8">
            <h2>{ts('contact.title')}</h2>
            <p>
              {ts.rich('contact.body', {
                email: CONTACT_EMAIL,
                link: (chunks) => (
                  <a href={`mailto:${CONTACT_EMAIL}`} className="text-primary hover:underline">
                    {chunks}
                  </a>
                ),
              })}
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
