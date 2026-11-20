import type { Metadata } from 'next';
import { useTranslations } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { Suspense } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SignupForm } from '@/components/forms/signup-form';
import { BRAND } from '@/lib/brand';

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
 * Note: SignupForm uses useSearchParams() which requires Suspense boundary
 */
export default function SignupPage() {
  const t = useTranslations('auth');
  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl font-bold">{t('signup.title')}</CardTitle>
        <CardDescription>{t('signup.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Suspense fallback={<div>{t('shared.loading')}</div>}>
          <SignupForm />
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
