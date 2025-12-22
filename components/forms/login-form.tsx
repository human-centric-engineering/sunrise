'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { authClient } from '@/lib/auth/client';
import { signInSchema, type SignInInput } from '@/lib/validations/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const onSubmit = async (data: SignInInput) => {
    try {
      setIsLoading(true);
      setError(null);

      await authClient.signIn.email(
        {
          email: data.email,
          password: data.password,
        },
        {
          onRequest: () => {
            // Request started
          },
          onSuccess: () => {
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
          <Input
            id="password"
            type="password"
            placeholder="••••••••"
            autoComplete="current-password"
            disabled={isLoading}
            {...register('password')}
          />
          <FormError message={errors.password?.message} />
        </div>

        {/* Error Message */}
        {displayError && (
          <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">
            {displayError}
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
