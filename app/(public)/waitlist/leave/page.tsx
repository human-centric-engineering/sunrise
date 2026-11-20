import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { WaitlistLinkAction } from '@/components/waitlist/waitlist-link-action';
import { BRAND } from '@/lib/brand';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('waitlist.leave');
  return {
    title: t('metaTitle'),
    robots: { index: false, follow: false },
    referrer: 'no-referrer',
  };
}

/**
 * Waitlist — leave page (§125 t-977). Every waitlist email links here.
 *
 * Shows a button and erases nothing until it is pressed (see
 * `<WaitlistLinkAction>`). Served whatever the waitlist config says: no
 * switch may stop someone leaving the list.
 */
export default async function WaitlistLeavePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const token = typeof params.token === 'string' ? params.token : '';
  const t = await getTranslations('waitlist.leave');

  return (
    <div className="container mx-auto px-4 py-16 md:py-24">
      <Card className="mx-auto max-w-md">
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl font-bold">{t('title')}</CardTitle>
          <CardDescription>{t('description', { brand: BRAND.name })}</CardDescription>
        </CardHeader>
        <CardContent>
          <WaitlistLinkAction
            action="leave"
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
