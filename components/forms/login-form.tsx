'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { authClient } from '@/lib/auth/client';
import { signInSchema, type SignInInput } from '@/lib/validations/auth';
import { useAnalytics, EVENTS } from '@/lib/analytics';
import { Button } from '@/components/ui/button';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { FormError } from './form-error';
import { OAuthButtons } from './oauth-buttons';

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
  const callbackUrl = searchParams.get('callbackUrl') || '/dashboard';
  const { track, identify } = useAnalytics();

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attemptedEmail, setAttemptedEmail] = useState<string | null>(null);
  const [isSendingVerification, setIsSendingVerification] = useState(false);
  const [verificationSent, setVerificationSent] = useState(false);
  const [verificationError, setVerificationError] = useState<string | null>(null);

  // Check for OAuth errors in URL params (read directly, don't store in state)
  const oauthError = searchParams.get('error');
  const oauthErrorDescription = searchParams.get('error_description');
  const displayError =
    error ||
    (oauthError ? oauthErrorDescription || 'OAuth authentication failed. Please try again.' : null);

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
    setVerificationError(null);

    try {
      const response = await fetch('/api/auth/send-verification-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: attemptedEmail }),
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(data.message ?? 'Failed to send verification email');
      }

      setVerificationSent(true);
    } catch (err) {
      setVerificationError(
        err instanceof Error ? err.message : 'Failed to send verification email. Please try again.'
      );
    } finally {
      setIsSendingVerification(false);
    }
  };

  const onSubmit = async (data: SignInInput) => {
    try {
      setIsLoading(true);
      setError(null);
      setAttemptedEmail(data.email);
      // Reset verification states for new login attempt
      setVerificationSent(false);
      setVerificationError(null);

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
            setError(ctx.error.message || 'Invalid email or password');
            setIsLoading(false);
          },
        }
      );
    } catch {
      setError('An unexpected error occurred. Please try again.');
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* OAuth Buttons */}
      <OAuthButtons callbackUrl={callbackUrl} />

      {/* Email/Password Form */}
      <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="space-y-4">
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

        {/* Error Message */}
        {displayError && (
          <div className="space-y-3">
            <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">
              {displayError}
            </div>
            {/* Show send verification email button for unverified email errors */}
            {displayError.toLowerCase().includes('email not verified') && attemptedEmail && (
              <>
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
                    {verificationError && (
                      <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">
                        {verificationError}
                      </div>
                    )}
                  </>
                )}
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
