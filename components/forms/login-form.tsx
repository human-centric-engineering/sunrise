'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { authClient } from '@/lib/auth/client';
import { signInSchema, type SignInInput } from '@/lib/validations/auth';
import { useAnalytics, EVENTS } from '@/lib/analytics';
import { isRecord } from '@/lib/utils';
import { safeCallbackUrl } from '@/lib/security';
import { Button } from '@/components/ui/button';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { FormError, SaveError } from '@/components/forms/form-error';
import { OAuthButtons } from '@/components/forms/oauth-buttons';
import { AUTH_LANDING_ROUTE } from '@/lib/auth-landing/route';
import { useSaveFailure } from '@/lib/hooks/use-save-failure';

/**
 * Login Form Component
 *
 * Handles user authentication with email/password and OAuth providers.
 * Uses react-hook-form with Zod validation and better-auth for authentication.
 *
 * Features:
 * - OAuth authentication (Google)
 * - Email/password authentication
 * - Form validation with Zod schema
 * - Loading states during submission
 * - Error handling and display (including OAuth errors from URL)
 * - Callback URL preservation for post-login redirect
 */
export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = safeCallbackUrl(searchParams.get('callbackUrl'), AUTH_LANDING_ROUTE);
  const { track, identify } = useAnalytics();

  const [isLoading, setIsLoading] = useState(false);
  const save = useSaveFailure({ fallback: 'An unexpected error occurred. Please try again.' });
  const [attemptedEmail, setAttemptedEmail] = useState<string | null>(null);
  const [notVerified, setNotVerified] = useState(false);
  const [isSendingVerification, setIsSendingVerification] = useState(false);
  const [verificationSent, setVerificationSent] = useState(false);
  const verification = useSaveFailure({
    fallback: 'Failed to send verification email. Please try again.',
  });

  // An OAuth sign-in that failed comes back in the URL: it is shown where a
  // failed sign-in is, until the form's own sign-in fails instead.
  const oauthError = searchParams.get('error');
  const oauthErrorDescription = searchParams.get('error_description');
  const oauthMessage = oauthError
    ? oauthErrorDescription || 'OAuth authentication failed. Please try again.'
    : null;
  // From better-auth's code, not its wording: a fork may reword the message.
  const unverified = notVerified && !!attemptedEmail && !!save.failure;

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SignInInput>({
    resolver: zodResolver(signInSchema),
    mode: 'onTouched',
    defaultValues: {
      email: '',
      password: '',
    },
  });

  // Handle sending verification email directly from login form
  const handleSendVerification = async () => {
    if (!attemptedEmail) return;

    setIsSendingVerification(true);
    verification.clear();

    try {
      const response = await fetch('/api/auth/send-verification-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: attemptedEmail }),
      });

      if (!response.ok) {
        const raw: unknown = await response.json().catch(() => ({}));
        verification.show(
          isRecord(raw) && typeof raw.message === 'string'
            ? raw.message
            : 'Failed to send verification email'
        );
        return;
      }

      setVerificationSent(true);
    } catch (err) {
      // A network failure: the browser's own text says nothing useful.
      verification.report(err);
    } finally {
      setIsSendingVerification(false);
    }
  };

  const onSubmit = async (data: SignInInput) => {
    try {
      setIsLoading(true);
      setAttemptedEmail(data.email);
      setNotVerified(false);
      // Reset verification states for new login attempt
      setVerificationSent(false);
      verification.clear();

      await authClient.signIn.email(
        {
          email: data.email,
          password: data.password,
        },
        {
          onRequest: () => {
            // Request started
          },
          onSuccess: async () => {
            // Get session to identify user before tracking
            const { data: session } = await authClient.getSession();
            if (session?.user?.id) {
              await identify(session.user.id);
            }
            await track(EVENTS.USER_LOGGED_IN, { method: 'email' });
            // Redirect to callback URL or dashboard
            router.push(callbackUrl);
            router.refresh();
          },
          onError: (ctx) => {
            if (ctx.response?.status === 429) {
              save.show(
                'Too many sign-in attempts. Please wait a few minutes before trying again.'
              );
            } else {
              setNotVerified(ctx.error.code === 'EMAIL_NOT_VERIFIED');
              save.show(ctx.error.message || 'Invalid email or password');
            }
            setIsLoading(false);
          },
        }
      );
    } catch (err) {
      save.report(err);
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* OAuth Buttons */}
      <OAuthButtons callbackUrl={callbackUrl} />

      {/* Email/Password Form */}
      <form
        noValidate
        onSubmit={save.submit(handleSubmit(onSubmit, save.invalid))}
        className="space-y-4"
      >
        {/* Email Field */}
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            placeholder="you@example.com"
            autoComplete="email"
            disabled={isLoading}
            {...register('email')}
          />
          <FormError message={errors.email?.message} />
        </div>

        {/* Password Field */}
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <PasswordInput
            id="password"
            placeholder="••••••••"
            autoComplete="current-password"
            disabled={isLoading}
            {...register('password')}
          />
          <FormError message={errors.password?.message} />
        </div>

        {/* A failed sign-in, beside Sign In */}
        <SaveError failure={save.failure} />
        {!save.failure && oauthMessage && <FormError message={oauthMessage} />}
        {/* Show send verification email button for unverified email errors */}
        {unverified && (
          <div className="space-y-3">
            {verificationSent ? (
              <div className="flex items-center gap-2 rounded-md bg-green-50 p-3 text-sm text-green-800 dark:bg-green-900/20 dark:text-green-400">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>Verification email sent! Check your inbox.</span>
              </div>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  disabled={isSendingVerification}
                  onClick={() => void handleSendVerification()}
                >
                  {isSendingVerification ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Sending...
                    </>
                  ) : (
                    'Send verification email'
                  )}
                </Button>
                <SaveError failure={verification.failure} />
              </>
            )}
          </div>
        )}

        {/* Submit Button */}
        <Button type="submit" className="w-full" disabled={isLoading}>
          {isLoading ? 'Signing in...' : 'Sign In'}
        </Button>
      </form>
    </div>
  );
}
