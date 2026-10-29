'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { authClient } from '@/lib/auth/client';
import { useFormAnalytics } from '@/lib/analytics/events';
import { useTimeout } from '@/lib/hooks/use-timeout';
import { useSaveFailure } from '@/lib/hooks/use-save-failure';
import {
  resetPasswordRequestSchema,
  resetPasswordSchema,
  type ResetPasswordRequestInput,
  type ResetPasswordInput,
} from '@/lib/validations/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { FormError, SaveError } from '@/components/forms/form-error';
import { PasswordStrength } from '@/components/forms/password-strength';
import { Mail } from 'lucide-react';
import Link from 'next/link';

/**
 * Reset Password Form Component
 *
 * Handles two states based on URL query parameters:
 * 1. Request Reset (no token): User enters email to receive reset link
 * 2. Complete Reset (token in URL): User enters new password to complete reset
 *
 * The component automatically detects which state to show based on token presence.
 */
export function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  // Conditional rendering based on token presence
  if (!token) {
    return <RequestResetForm />;
  }

  return <CompleteResetForm token={token} />;
}

/**
 * Map URL error codes to user-friendly messages
 * These errors come from better-auth when a reset link is invalid/expired
 */
function getUrlErrorMessage(errorCode: string | null): string | null {
  if (!errorCode) return null;

  const errorMessages: Record<string, string> = {
    INVALID_TOKEN:
      'Your password reset link has expired or is invalid. Please request a new one below.',
    EXPIRED: 'Your password reset link has expired. Please request a new one below.',
    USED: 'This password reset link has already been used. Please request a new one if needed.',
  };

  return (
    errorMessages[errorCode] ||
    'There was an issue with your reset link. Please request a new one below.'
  );
}

/**
 * Request Reset Form (State 1 - No Token)
 *
 * Allows user to request a password reset email.
 * Shows generic success message for security (doesn't reveal if email exists).
 * Displays contextual message when user arrives from an expired/invalid link.
 */
function RequestResetForm() {
  const searchParams = useSearchParams();
  const urlError = searchParams.get('error');
  const urlErrorMessage = getUrlErrorMessage(urlError);
  const { trackFormSubmitted } = useFormAnalytics();

  const [isLoading, setIsLoading] = useState(false);
  const save = useSaveFailure({ fallback: 'Failed to send reset email. Please try again.' });
  const [success, setSuccess] = useState(false);
  const [submittedEmail, setSubmittedEmail] = useState('');

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ResetPasswordRequestInput>({
    resolver: zodResolver(resetPasswordRequestSchema),
    mode: 'onTouched',
    defaultValues: { email: '' },
  });

  const onSubmit = async (data: ResetPasswordRequestInput) => {
    try {
      setIsLoading(true);

      // Call better-auth password reset request endpoint directly
      const response = await fetch('/api/auth/request-password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: data.email,
          redirectTo: '/reset-password',
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to send reset email');
      }

      // Track password reset request
      void trackFormSubmitted('password-reset');

      setSubmittedEmail(data.email);
      setSuccess(true);
      setIsLoading(false);
    } catch (err) {
      save.report(err);
      setIsLoading(false);
    }
  };

  // Success state - show confirmation message
  if (success) {
    return (
      <div className="space-y-4">
        <div className="flex justify-center">
          <div className="bg-primary/10 text-primary rounded-full p-3">
            <Mail className="h-6 w-6" />
          </div>
        </div>

        <div className="rounded-md bg-green-50 p-4 text-sm text-green-900 dark:bg-green-900/10 dark:text-green-400">
          <p className="font-medium">Check your email</p>
          <p className="mt-1">
            If an account exists with <strong>{submittedEmail}</strong>, we&apos;ve sent password
            reset instructions.
          </p>
        </div>

        <div className="bg-muted rounded-md p-4 text-sm">
          <p className="mb-2">Didn&apos;t receive the email?</p>
          <ul className="text-muted-foreground list-inside list-disc space-y-1 text-xs">
            <li>Check your spam folder</li>
            <li>Make sure you entered the correct email</li>
            <li>Wait a few minutes and try again</li>
            <li>If you signed up using a social login, try signing in with that instead</li>
          </ul>
        </div>

        <Button variant="outline" onClick={() => setSuccess(false)} className="w-full">
          Try another email
        </Button>

        <div className="text-center text-sm">
          <Link href="/login" className="text-primary font-medium hover:underline">
            Back to login
          </Link>
        </div>
      </div>
    );
  }

  // Form state - show email input
  return (
    <form
      noValidate
      onSubmit={save.submit(handleSubmit(onSubmit, save.invalid))}
      className="space-y-4"
    >
      {/* Show contextual message for URL errors (expired/invalid links) */}
      {urlErrorMessage && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/10 dark:text-amber-400">
          <p className="font-medium">Reset link expired</p>
          <p className="mt-1">{urlErrorMessage}</p>
        </div>
      )}

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

      <SaveError failure={save.failure} />

      <Button type="submit" className="w-full" disabled={isLoading}>
        {isLoading ? 'Sending...' : 'Send reset link'}
      </Button>

      <div className="text-center text-sm">
        <Link href="/login" className="text-primary font-medium hover:underline">
          Back to login
        </Link>
      </div>
    </form>
  );
}

/**
 * Complete Reset Form (State 2 - With Token)
 *
 * Allows user to set a new password using the token from the reset email.
 * Includes password strength meter and show/hide toggles.
 */
function CompleteResetForm({ token }: { token: string }) {
  const router = useRouter();
  const schedule = useTimeout();
  const [isLoading, setIsLoading] = useState(false);
  const save = useSaveFailure({ fallback: 'An unexpected error occurred. Please try again.' });
  const [success, setSuccess] = useState(false);
  const [linkRefused, setLinkRefused] = useState(false);
  const linkExpired = linkRefused && !!save.failure;

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<ResetPasswordInput>({
    resolver: zodResolver(resetPasswordSchema),
    mode: 'onTouched',
    defaultValues: {
      token: token,
      password: '',
      confirmPassword: '',
    },
  });

  const password = watch('password'); // For strength meter

  const onSubmit = async (data: ResetPasswordInput) => {
    try {
      setIsLoading(true);

      await authClient.resetPassword(
        {
          newPassword: data.password,
          token: data.token,
        },
        {
          onRequest: () => {
            // Request started
          },
          onSuccess: () => {
            setSuccess(true);
            setIsLoading(false);

            // Redirect to login after 1.5 seconds
            schedule(() => {
              router.push('/login');
              router.refresh();
            }, 1500);
          },
          onError: (ctx) => {
            // better-auth refuses an expired, used or unknown token alike, as
            // INVALID_TOKEN ("Invalid token"): match the code, not the wording.
            const refused = ctx.error.code === 'INVALID_TOKEN';
            setLinkRefused(refused);
            save.show(
              refused
                ? 'This reset link is invalid or has expired. Please request a new one.'
                : ctx.error.message || 'Failed to reset password'
            );

            setIsLoading(false);
          },
        }
      );
    } catch (err) {
      save.report(err);
      setIsLoading(false);
    }
  };

  // Success state - show confirmation message
  if (success) {
    return (
      <div className="space-y-4">
        <div className="rounded-md bg-green-50 p-4 text-sm text-green-900 dark:bg-green-900/10 dark:text-green-400">
          <p className="font-medium">Password reset successfully!</p>
          <p className="mt-1 text-xs">Redirecting to login...</p>
        </div>
      </div>
    );
  }

  // Form state - show password reset form
  return (
    <form
      noValidate
      onSubmit={save.submit(handleSubmit(onSubmit, save.invalid))}
      className="space-y-4"
    >
      <input type="hidden" {...register('token')} />

      {/* Password Field */}
      <div className="space-y-2">
        <Label htmlFor="password">New Password</Label>
        <PasswordInput
          id="password"
          placeholder="••••••••"
          autoComplete="new-password"
          disabled={isLoading}
          {...register('password')}
        />
        <FormError message={errors.password?.message} />
        <PasswordStrength password={password} />
        <p className="text-muted-foreground text-xs">
          Must be at least 8 characters with uppercase, lowercase, number, and special character
        </p>
      </div>

      {/* Confirm Password Field */}
      <div className="space-y-2">
        <Label htmlFor="confirmPassword">Confirm Password</Label>
        <PasswordInput
          id="confirmPassword"
          placeholder="••••••••"
          autoComplete="new-password"
          disabled={isLoading}
          {...register('confirmPassword')}
        />
        <FormError message={errors.confirmPassword?.message} />
      </div>

      <SaveError failure={save.failure} />
      {linkExpired && (
        <Button asChild variant="outline" className="w-full">
          <Link href="/reset-password">Request new reset link</Link>
        </Button>
      )}

      <Button type="submit" className="w-full" disabled={isLoading}>
        {isLoading ? 'Resetting password...' : 'Reset password'}
      </Button>

      <div className="text-center text-sm">
        <Link href="/login" className="text-primary font-medium hover:underline">
          Back to login
        </Link>
      </div>
    </form>
  );
}
