import type { Metadata } from 'next';
import { getFormatter, getTranslations } from 'next-intl/server';
import { BRAND } from '@/lib/brand';

/** When this placeholder was last revised: a calendar date, so it is read in UTC. */
const LAST_UPDATED = new Date('2026-01-19T00:00:00Z');
const CONTACT_EMAIL = 'privacy@example.com';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('legal.privacy.meta');
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

/** The policy's sections in order, with the keys of the list items each one has. */
const SECTIONS = [
  { key: 'introduction', items: [] },
  {
    key: 'informationWeCollect',
    items: [
      'informationWeCollect.items.account',
      'informationWeCollect.items.usage',
      'informationWeCollect.items.cookies',
      'informationWeCollect.items.thirdParty',
    ],
  },
  {
    key: 'howWeUse',
    items: [
      'howWeUse.items.services',
      'howWeUse.items.communicating',
      'howWeUse.items.security',
      'howWeUse.items.legal',
    ],
  },
  { key: 'sharing', items: [] },
  {
    key: 'rights',
    items: [
      'rights.items.access',
      'rights.items.correction',
      'rights.items.marketing',
      'rights.items.consent',
    ],
  },
] as const;

/**
 * Privacy Policy Page
 *
 * Placeholder privacy policy page.
 * Replace with your actual privacy policy content (`legal.privacy` in the catalogue).
 *
 * Phase 3.5: Landing Page & Marketing
 */
export default async function PrivacyPolicyPage() {
  const t = await getTranslations('legal');
  const ts = await getTranslations('legal.privacy.sections');
  const format = await getFormatter();

  return (
    <div className="container mx-auto px-4 py-16 md:py-24">
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-8 text-4xl font-bold tracking-tight">{t('privacy.title')}</h1>

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
