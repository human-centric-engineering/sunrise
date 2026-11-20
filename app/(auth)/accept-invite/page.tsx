import type { Metadata } from 'next';
import { useTranslations } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AcceptInviteForm } from '@/components/forms/accept-invite-form';
import { BRAND } from '@/lib/brand';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.acceptInvite.meta');
  return {
    title: t('title'),
    description: t('description', { brand: BRAND.name }),
  };
}

/**
 * Accept Invitation Page
 *
 * A new invitee sets a password (or uses OAuth) to create their account; an
 * address that already has an account signs in and accepts instead (#1199).
 * Either can decline. Reads token and email from URL parameters.
 *
 * Note: AcceptInviteForm uses useSearchParams() which requires Suspense boundary
 */
export default function AcceptInvitePage() {
  const t = useTranslations('auth');
  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl font-bold">{t('acceptInvite.title')}</CardTitle>
        <CardDescription>{t('acceptInvite.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <Suspense fallback={<div>{t('shared.loading')}</div>}>
          <AcceptInviteForm />
        </Suspense>
      </CardContent>
    </Card>
  );
}
