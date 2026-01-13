'use client';

import { Suspense, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';

/**
 * Email Verification Callback Page
 *
 * Handles the redirect from better-auth's email verification endpoint.
 * Better-auth redirects here after processing the verification token:
 * - On success: no error param, redirect to dashboard
 * - On failure: ?error=invalid_token, show error with resend option
 *
 * This provides a better UX than redirecting to login with no explanation
 * when a verification link has expired.
 */
function VerifyEmailCallbackContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const error = searchParams.get('error');

  const [email, setEmail] = useState('');
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);

  // If no error, verification succeeded - redirect to dashboard
  useEffect(() => {
    if (!error) {
      router.replace('/dashboard');
    }
  }, [error, router]);

  // If no error, show loading while redirecting
  if (!error) {
    return (
      <Card className="mx-auto w-full max-w-md">
        <CardHeader className="space-y-1 text-center">
          <div className="mb-4 flex justify-center">
            <div className="rounded-full bg-green-100 p-3 text-green-600 dark:bg-green-900/20 dark:text-green-400">
              <CheckCircle2 className="h-6 w-6" />
            </div>
          </div>
          <CardTitle className="text-2xl font-bold">Email Verified!</CardTitle>
          <CardDescription>Redirecting to dashboard...</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  async function handleResend() {
    if (!email) {
      setResendError('Please enter your email address');
      return;
    }

    setResending(true);
    setResendError(null);

    try {
      const response = await fetch('/api/auth/send-verification-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(data.message ?? 'Failed to resend verification email');
      }

      setResent(true);
    } catch (err) {
      setResendError(
        err instanceof Error
          ? err.message
          : 'Failed to resend verification email. Please try again.'
      );
    } finally {
      setResending(false);
    }
  }

  // Show error state with resend option
  return (
    <Card className="mx-auto w-full max-w-md">
      <CardHeader className="space-y-1 text-center">
        <div className="mb-4 flex justify-center">
          <div className="rounded-full bg-amber-100 p-3 text-amber-600 dark:bg-amber-900/20 dark:text-amber-400">
            <AlertCircle className="h-6 w-6" />
          </div>
        </div>
        <CardTitle className="text-2xl font-bold">Verification Link Expired</CardTitle>
        <CardDescription>
          This verification link has expired or is invalid. Please request a new one.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!resent ? (
          <>
            <div className="space-y-2">
              <Label htmlFor="email">Email Address</Label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={resending}
              />
            </div>

            <Button
              onClick={() => void handleResend()}
              disabled={resending || !email}
              className="w-full"
            >
              {resending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Sending...
                </>
              ) : (
                'Resend Verification Email'
              )}
            </Button>

            {resendError && (
              <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">
                {resendError}
              </div>
            )}
          </>
        ) : (
          <div className="space-y-4">
            <div className="rounded-md bg-green-50 p-4 text-sm text-green-800 dark:bg-green-900/20 dark:text-green-400">
              <p className="font-medium">Verification email sent!</p>
              <p className="mt-1">
                Check your inbox for a new verification link. The link will expire in 24 hours.
              </p>
            </div>
          </div>
        )}

        {/* Back to Login Link */}
        <div className="pt-2 text-center text-sm">
          <a href="/login" className="text-primary font-medium hover:underline">
            Back to login
          </a>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Verify Email Callback Page (with Suspense Boundary)
 *
 * Wraps content in Suspense as required by Next.js when using useSearchParams().
 */
export default function VerifyEmailCallbackPage() {
  return (
    <Suspense
      fallback={
        <Card className="mx-auto w-full max-w-md">
          <CardHeader className="space-y-1 text-center">
            <div className="mb-4 flex justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
            </div>
            <CardTitle className="text-2xl font-bold">Verifying...</CardTitle>
          </CardHeader>
        </Card>
      }
    >
      <VerifyEmailCallbackContent />
    </Suspense>
  );
}
