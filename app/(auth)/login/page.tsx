import type { Metadata } from 'next';
import { useTranslations } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { Suspense } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LoginForm } from '@/components/forms/login-form';
import { WaitlistLoginNotice } from '@/components/waitlist/waitlist-login-notice';
import { BRAND } from '@/lib/brand';
import { isInviteOnly } from '@/lib/auth/signup-mode';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.login.meta');
  return {
    title: t('title'),
    description: t('description', { brand: BRAND.name }),
  };
}

/**
 * Login Page
 *
 * Allows users to sign in with email and password.
 * Protected by proxy - authenticated users are redirected to /dashboard
 */
export default function LoginPage() {
  const t = useTranslations('auth');
  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl font-bold">{t('login.title')}</CardTitle>
        <CardDescription>{t('login.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Suspense fallback={<div>{t('shared.loading')}</div>}>
          <LoginForm />
        </Suspense>

        {/* Sign Up Link — omitted under SIGNUP_MODE=invite_only, where /signup
            redirects straight back here and self-signup cannot succeed. */}
        {!isInviteOnly() && (
          <div className="text-center text-sm">
            {t.rich('login.signUpPrompt', {
              muted: (chunks) => <span className="text-muted-foreground">{chunks}</span>,
              link: (chunks) => (
                <Link href="/signup" className="text-primary font-medium hover:underline">
                  {chunks}
                </Link>
              ),
            })}
          </div>
        )}
        {/* Under invite_only, the way in is the waitlist, when the app has one. */}
        {isInviteOnly() && <WaitlistLoginNotice />}

        {/* Password Reset Link */}
        <div className="text-center text-sm">
          <Link
            href="/reset-password"
            className="text-muted-foreground hover:text-primary hover:underline"
          >
            {t('login.forgotPassword')}
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
