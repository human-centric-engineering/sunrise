import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { WaitlistLinkAction } from '@/components/waitlist/waitlist-link-action';
import { BRAND } from '@/lib/brand';
import { getWaitlistConfig } from '@/lib/waitlist/config';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('waitlist.confirm');
  return {
    title: t('metaTitle'),
    // The link carries a token: keep it out of search results and out of the
    // Referer header of anything the page loads or links to.
    robots: { index: false, follow: false },
    referrer: 'no-referrer',
  };
}

/**
 * Waitlist — confirm page (§125 t-977). The confirmation email links here.
 *
 * Shows a button and does nothing until it is pressed: mail scanners open
 * links before people do (see `<WaitlistLinkAction>`). 404 when the app has
 * no waitlist.
 */
export default async function WaitlistConfirmPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!getWaitlistConfig()) notFound();
  const params = await searchParams;
  const entry = typeof params.entry === 'string' ? params.entry : '';
  const token = typeof params.token === 'string' ? params.token : '';
  const t = await getTranslations('waitlist.confirm');

  return (
    <div className="container mx-auto px-4 py-16 md:py-24">
      <Card className="mx-auto max-w-md">
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl font-bold">{t('title')}</CardTitle>
          <CardDescription>{t('description', { brand: BRAND.name })}</CardDescription>
        </CardHeader>
        <CardContent>
          <WaitlistLinkAction
            action="confirm"
            entry={entry}
            token={token}
            copy={{
              buttonLabel: t('button'),
              doneMessage: t('done'),
              failureMessage: t('failure'),
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
