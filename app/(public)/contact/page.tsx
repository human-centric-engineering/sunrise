import type { Metadata } from 'next';
import Link from 'next/link';
import { Mail, Clock } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ContactForm } from '@/components/forms/contact-form';
import { BRAND } from '@/lib/brand';
import { getTranslations } from 'next-intl/server';

const CONTACT_EMAIL = 'hello@example.com';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('marketing.contact.meta');
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
      card: 'summary_large_image',
      title: socialTitle,
      description,
    },
  };
}

/**
 * Contact Page
 *
 * Two-column layout with contact form and additional contact information.
 *
 * Phase 3.5: Landing Page & Marketing
 */
export default async function ContactPage() {
  const t = await getTranslations('marketing.contact');

  return (
    <div className="container mx-auto px-4 py-16 md:py-24">
      <div className="mx-auto max-w-5xl">
        {/* Page Header */}
        <div className="mb-12 text-center">
          <h1 className="mb-4 text-4xl font-bold tracking-tight">{t('title')}</h1>
          <p className="text-muted-foreground mx-auto max-w-2xl text-lg">{t('intro')}</p>
        </div>

        {/* Two-column layout */}
        <div className="grid gap-8 lg:grid-cols-5">
          {/* Contact Form - takes 3 columns */}
          <div className="lg:col-span-3">
            <Card>
              <CardHeader>
                <CardTitle>{t('formCard.title')}</CardTitle>
                <CardDescription>{t('formCard.description')}</CardDescription>
              </CardHeader>
              <CardContent>
                <ContactForm />
              </CardContent>
            </Card>
          </div>

          {/* Contact Info - takes 2 columns */}
          <div className="space-y-6 lg:col-span-2">
            {/* Email */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center gap-3">
                  <div className="bg-primary/10 text-primary flex h-10 w-10 items-center justify-center rounded-lg">
                    <Mail className="h-5 w-5" />
                  </div>
                  <div>
                    <CardTitle className="text-base">{t('email.title')}</CardTitle>
                    <CardDescription>{t('email.description')}</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <a href={`mailto:${CONTACT_EMAIL}`} className="text-primary hover:underline">
                  {CONTACT_EMAIL}
                </a>
              </CardContent>
            </Card>

            {/* Response Time */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center gap-3">
                  <div className="bg-primary/10 text-primary flex h-10 w-10 items-center justify-center rounded-lg">
                    <Clock className="h-5 w-5" />
                  </div>
                  <div>
                    <CardTitle className="text-base">{t('responseTime.title')}</CardTitle>
                    <CardDescription>{t('responseTime.description')}</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <p className="text-muted-foreground text-sm">{t('responseTime.body')}</p>
              </CardContent>
            </Card>

            {/* GitHub */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center gap-3">
                  <div className="bg-primary/10 text-primary flex h-10 w-10 items-center justify-center rounded-lg">
                    {/* GitHub mark — lucide v1 removed brand icons, so inline the SVG */}
                    <svg
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      aria-hidden="true"
                      className="h-5 w-5"
                    >
                      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.605-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.91 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222 0 1.606-.014 2.898-.014 3.293 0 .322.216.694.825.576C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
                    </svg>
                  </div>
                  <div>
                    <CardTitle className="text-base">{t('github.title')}</CardTitle>
                    <CardDescription>{t('github.description')}</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <p className="text-muted-foreground mb-2 text-sm">{t('github.body')}</p>
                <a
                  href="https://github.com/human-centric-engineering/sunrise/issues"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary text-sm hover:underline"
                >
                  {t('github.link')}
                </a>
              </CardContent>
            </Card>

            {/* Support Options */}
            <Card className="border-primary/50 bg-primary/5">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">{t('support.title')}</CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <p className="text-muted-foreground mb-3 text-sm">{t('support.body')}</p>
                <Link href="/#pricing" className="text-primary text-sm font-medium hover:underline">
                  {t('support.link')}
                </Link>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
