import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { Suspense } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SignupForm } from '@/components/forms/signup-form';
import { BRAND } from '@/lib/brand';
import { SIGNUP_PLAN_PARAM, signupPlanOffer } from '@/lib/billing/signup-plan';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.signup.meta');
  return {
    title: t('title'),
    description: t('description', { brand: BRAND.name }),
  };
}

/**
 * Signup Page
 *
 * Allows new users to create an account with email and password.
 * Protected by proxy - authenticated users are redirected to /dashboard
 *
 * A pricing page may link here with a plan (`/signup?plan=pro`, §139
 * t-1096). When billing is on and the key names a registered plan, the page
 * says which plan they are signing up for and the form carries the key
 * through the signup; anything else is dropped here and shows nothing. The
 * user-create hook checks it again, since a request can carry anything.
 *
 * Note: SignupForm uses useSearchParams() which requires Suspense boundary
 */
export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations('auth');
  const offer = signupPlanOffer((await searchParams)[SIGNUP_PLAN_PARAM]);
  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl font-bold">{t('signup.title')}</CardTitle>
        <CardDescription>{t('signup.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {offer && (
          <p role="status" className="rounded-md border px-4 py-3 text-sm">
            {t(offer.paid ? 'signup.plan.paid' : 'signup.plan.free', { plan: offer.label })}
          </p>
        )}
        <Suspense fallback={<div>{t('shared.loading')}</div>}>
          <SignupForm signupPlan={offer?.key ?? null} />
        </Suspense>

        {/* Login Link */}
        <div className="text-center text-sm">
          {t.rich('shared.signInPrompt', {
            muted: (chunks) => <span className="text-muted-foreground">{chunks}</span>,
            link: (chunks) => (
              <Link href="/login" className="text-primary font-medium hover:underline">
                {chunks}
              </Link>
            ),
          })}
        </div>
      </CardContent>
    </Card>
  );
}
