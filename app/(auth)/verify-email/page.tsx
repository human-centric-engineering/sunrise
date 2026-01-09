'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Mail } from 'lucide-react';

/**
 * Email Verification Pending Page
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
  const searchParams = useSearchParams();
  const email = searchParams.get('email');
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleResend() {
    if (!email) {
      setError('Email address is required to resend verification');
      return;
    }

    setResending(true);
    setError(null);

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
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to resend verification email. Please try again.'
      );
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
        <CardTitle className="text-2xl font-bold">Check your email</CardTitle>
        <CardDescription>
          {email ? (
            <>
              We&apos;ve sent a verification link to <strong>{email}</strong>
            </>
          ) : (
            "We've sent a verification link to your email address"
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="bg-muted rounded-md p-4 text-sm">
          <p className="mb-2">
            Click the link in the email to verify your account and get started.
          </p>
          <p className="text-muted-foreground text-xs">
            The verification link will expire in 24 hours.
          </p>
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
              {resent ? 'Email sent!' : resending ? 'Sending...' : 'Resend verification email'}
            </Button>

            {/* Success Message */}
            {resent && (
              <p className="text-center text-sm text-green-600 dark:text-green-400">
                Verification email sent successfully. Check your inbox.
              </p>
            )}

            {/* Error Message */}
            {error && (
              <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">
                {error}
              </div>
            )}
          </div>
        )}

        {/* Login Link */}
        <div className="pt-4 text-center text-sm">
          <span className="text-muted-foreground">Already verified? </span>
          <a href="/login" className="text-primary font-medium hover:underline">
            Sign in
          </a>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Verify Email Page (with Suspense Boundary)
 *
 * Wraps VerifyEmailContent in a Suspense boundary as required by Next.js 16
 * when using useSearchParams() in a Client Component.
 */
export default function VerifyEmailPage() {
  return (
    <Suspense
      fallback={
        <Card className="mx-auto w-full max-w-md">
          <CardHeader className="space-y-1 text-center">
            <CardTitle className="text-2xl font-bold">Loading...</CardTitle>
          </CardHeader>
        </Card>
      }
    >
      <VerifyEmailContent />
    </Suspense>
  );
}
