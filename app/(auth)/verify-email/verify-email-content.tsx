'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Mail } from 'lucide-react';
import { SaveError } from '@/components/forms/form-error';
import { useSaveFailure } from '@/lib/hooks/use-save-failure';

/**
 * Email Verification Pending Content
 *
 * Shown after email/password signup when email verification is required.
 * Displays a "check your email" message and allows users to resend the
 * verification email if they didn't receive it.
 *
 * URL Parameters:
 * - email: The user's email address (optional, for display purposes)
 *
 * Features:
 * - Clear user feedback about verification requirement
 * - Email address display (if provided via URL parameter)
 * - Resend verification email functionality
 * - Loading and success states for resend action
 * - Error handling for failed resend attempts
 */
function VerifyEmailContent() {
  const t = useTranslations('auth');
  const searchParams = useSearchParams();
  const email = searchParams.get('email');
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);
  const save = useSaveFailure({
    fallback: t('shared.resendVerificationFailed'),
  });

  async function handleResend() {
    if (!email) {
      save.show(t('verifyEmail.emailRequired'));
      return;
    }

    setResending(true);
    save.clear();

    try {
      // Call better-auth resend verification endpoint
      const response = await fetch('/api/auth/send-verification-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      if (!response.ok) {
        throw new Error('Failed to resend verification email');
      }

      setResent(true);
    } catch (err) {
      // Nothing the server says here is worth more than the fallback.
      save.report(err);
    } finally {
      setResending(false);
    }
  }

  return (
    <Card className="mx-auto w-full max-w-md">
      <CardHeader className="space-y-1 text-center">
        <div className="mb-4 flex justify-center">
          <div className="bg-primary/10 text-primary rounded-full p-3">
            <Mail className="h-6 w-6" />
          </div>
        </div>
        <CardTitle className="text-2xl font-bold">{t('verifyEmail.title')}</CardTitle>
        <CardDescription>
          {email
            ? t.rich('verifyEmail.sentTo', {
                email,
                strong: (chunks) => <strong>{chunks}</strong>,
              })
            : t('verifyEmail.sentToYou')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="bg-muted rounded-md p-4 text-sm">
          <p className="mb-2">{t('verifyEmail.clickLink')}</p>
          <p className="text-muted-foreground text-xs">{t('verifyEmail.expiry')}</p>
        </div>

        {/* Resend Button */}
        {email && (
          <div className="space-y-2">
            <Button
              onClick={() => void handleResend()}
              disabled={resending || resent}
              variant="outline"
              className="w-full"
            >
              {resent
                ? t('verifyEmail.resent')
                : resending
                  ? t('shared.sending')
                  : t('verifyEmail.resend')}
            </Button>

            {/* Success Message */}
            {resent && (
              <p className="text-center text-sm text-green-600 dark:text-green-400">
                {t('verifyEmail.resentSuccess')}
              </p>
            )}

            <SaveError failure={save.failure} />
          </div>
        )}

        {/* Login Link */}
        <div className="pt-4 text-center text-sm">
          {t.rich('verifyEmail.alreadyVerified', {
            muted: (chunks) => <span className="text-muted-foreground">{chunks}</span>,
            link: (chunks) => (
              <a href="/login" className="text-primary font-medium hover:underline">
                {chunks}
              </a>
            ),
          })}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Verify Email Content with Suspense Boundary
 *
 * Wraps VerifyEmailContent in a Suspense boundary as required by Next.js 16
 * when using useSearchParams() in a Client Component.
 */
export function VerifyEmailClientContent() {
  const t = useTranslations('auth.shared');
  return (
    <Suspense
      fallback={
        <Card className="mx-auto w-full max-w-md">
          <CardHeader className="space-y-1 text-center">
            <CardTitle className="text-2xl font-bold">{t('loading')}</CardTitle>
          </CardHeader>
        </Card>
      }
    >
      <VerifyEmailContent />
    </Suspense>
  );
}
