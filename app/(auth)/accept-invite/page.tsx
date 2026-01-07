'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useEffect } from 'react';
import { acceptInvitationSchema, type AcceptInvitationInput } from '@/lib/validations/user';
import { apiClient, APIClientError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FormError } from '@/components/forms/form-error';
import { PasswordStrength } from '@/components/forms/password-strength';
import { Eye, EyeOff } from 'lucide-react';

/**
 * Accept Invitation Page
 *
 * Allows invited users to set their password and activate their account.
 * Reads token and email from URL parameters, validates invitation,
 * and redirects to login after successful acceptance.
 *
 * Features:
 * - Token and email from URL search params
 * - Password setting with strength meter
 * - Password confirmation with show/hide toggle
 * - Form validation with Zod schema
 * - Loading states during submission
 * - Error handling (validation, API, network errors)
 * - Success message before redirect
 * - Redirect to login with invited flag on success
 */
export default function AcceptInvitePage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Read token and email from URL
  const token = searchParams.get('token') || '';
  const emailFromUrl = searchParams.get('email') || '';

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<AcceptInvitationInput>({
    resolver: zodResolver(acceptInvitationSchema),
    mode: 'onTouched',
    defaultValues: {
      token: token,
      email: emailFromUrl,
      password: '',
      confirmPassword: '',
    },
  });

  // Watch password field for strength meter
  const password = watch('password');

  // Update token and email when URL params change
  useEffect(() => {
    if (token) {
      setValue('token', token);
    }
    if (emailFromUrl) {
      setValue('email', emailFromUrl);
    }
  }, [token, emailFromUrl, setValue]);

  const onSubmit = async (data: AcceptInvitationInput) => {
    try {
      setIsLoading(true);
      setError(null);

      // Submit to accept-invite endpoint
      await apiClient.post('/api/auth/accept-invitation', {
        body: {
          token: data.token,
          email: data.email,
          password: data.password,
          confirmPassword: data.confirmPassword,
        },
      });

      // Show success message
      setSuccess(true);

      // Redirect to login after short delay
      setTimeout(() => {
        router.push('/login?invited=true');
      }, 2000);
    } catch (err) {
      setIsLoading(false);

      if (err instanceof APIClientError) {
        setError(err.message || 'Failed to accept invitation. Please try again.');
      } else {
        setError('An unexpected error occurred. Please try again.');
      }
    }
  };

  // Show error if no token in URL
  if (!token) {
    return (
      <Card>
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl font-bold">Invalid Invitation</CardTitle>
          <CardDescription>The invitation link is invalid or has expired</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">
            No invitation token found. Please check your email for the correct invitation link.
          </div>
          <div className="mt-4 text-center text-sm">
            <a href="/login" className="text-primary font-medium hover:underline">
              Back to login
            </a>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl font-bold">Accept Invitation</CardTitle>
        <CardDescription>Set your password to activate your account</CardDescription>
      </CardHeader>
      <CardContent>
        {success ? (
          <div className="space-y-4">
            <div className="rounded-md bg-green-50 p-4 text-sm text-green-900 dark:bg-green-900/10 dark:text-green-400">
              <p className="font-medium">Account activated successfully!</p>
              <p className="mt-1 text-xs">Redirecting to login...</p>
            </div>
          </div>
        ) : (
          <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="space-y-4">
            {/* Hidden Token Field */}
            <input type="hidden" {...register('token')} />

            {/* Email Field (Disabled, Pre-filled) */}
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                autoComplete="email"
                disabled={true}
                {...register('email')}
                className="bg-muted"
              />
              <FormError message={errors.email?.message} />
            </div>

            {/* Password Field with Show/Hide Toggle */}
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="••••••••"
                  autoComplete="new-password"
                  disabled={isLoading}
                  {...register('password')}
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <FormError message={errors.password?.message} />
              <PasswordStrength password={password} />
              <p className="text-muted-foreground text-xs">
                Must be at least 8 characters with uppercase, lowercase, number, and special
                character
              </p>
            </div>

            {/* Confirm Password Field with Show/Hide Toggle */}
            <div className="space-y-2">
              <Label htmlFor="confirmPassword">Confirm Password</Label>
              <div className="relative">
                <Input
                  id="confirmPassword"
                  type={showConfirmPassword ? 'text' : 'password'}
                  placeholder="••••••••"
                  autoComplete="new-password"
                  disabled={isLoading}
                  {...register('confirmPassword')}
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
                  aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
                >
                  {showConfirmPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
              <FormError message={errors.confirmPassword?.message} />
            </div>

            {/* Error Message */}
            {error && (
              <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">
                {error}
              </div>
            )}

            {/* Submit Button */}
            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading ? 'Activating account...' : 'Activate Account'}
            </Button>
          </form>
        )}

        {/* Login Link */}
        {!success && (
          <div className="mt-4 text-center text-sm">
            <span className="text-muted-foreground">Already have an account? </span>
            <a href="/login" className="text-primary font-medium hover:underline">
              Sign in
            </a>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
