'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useEffect } from 'react';
import { acceptInvitationSchema, type AcceptInvitationInput } from '@/lib/validations/user';
import { apiClient, APIClientError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { FormError } from '@/components/forms/form-error';
import { PasswordStrength } from '@/components/forms/password-strength';
import { OAuthButtons } from '@/components/forms/oauth-buttons';

/**
 * Invitation validation status
 */
type InvitationStatus = 'loading' | 'valid' | 'expired' | 'invalid';

/**
 * Parse OAuth error from URL parameter into user-friendly message
 *
 * OAuth errors come URL-encoded with underscores replacing spaces.
 * We detect specific error patterns and return friendly messages.
 */
function parseOAuthError(error: string): string {
  // Decode and normalize the error message
  const decoded = decodeURIComponent(error).replace(/_/g, ' ');

  // Check for email mismatch error (our custom error from before hook)
  if (decoded.includes('invitation was sent to')) {
    // Extract the email from the message
    const emailMatch = decoded.match(/sent to ([^\s.]+)/);
    const invitedEmail = emailMatch ? emailMatch[1] : 'a different email';
    return `This invitation was sent to ${invitedEmail}. Please use an account with that email address, or set a password instead.`;
  }

  // Generic OAuth error fallback
  return 'Unable to sign in. Please try again or set a password instead.';
}

/**
 * Accept Invitation Form Component
 *
 * Allows invited users to set their password and activate their account.
 * Reads token and email from URL parameters, validates invitation,
 * and redirects to login after successful acceptance.
 *
 * Features:
 * - OAuth/social login support (Google) for invitation acceptance
 * - Token and email from URL search params
 * - Password setting with strength meter (alternative to OAuth)
 * - Password confirmation with show/hide toggle
 * - Form validation with Zod schema
 * - Loading states during submission
 * - Error handling (validation, API, network errors)
 * - Success message before redirect
 * - Redirect to dashboard on success (OAuth auto-logs in)
 * - Redirect to login with invited flag on success (password flow)
 * - Expired/invalid invitation handling with clear user messaging
 */
export function AcceptInviteForm() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Read token, email, and error from URL
  const token = searchParams.get('token') || '';
  const emailFromUrl = searchParams.get('email') || '';
  const oauthError = searchParams.get('error');

  const [invitationStatus, setInvitationStatus] = useState<InvitationStatus>('loading');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(
    // Parse OAuth error from URL if present
    oauthError ? parseOAuthError(oauthError) : null
  );

  // Build error callback URL to return here with token/email preserved
  const errorCallbackUrl = `/accept-invite?token=${encodeURIComponent(token)}&email=${encodeURIComponent(emailFromUrl)}`;
  const [success, setSuccess] = useState(false);
  const [invitationName, setInvitationName] = useState<string>('');

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

  // Fetch invitation metadata on mount
  useEffect(() => {
    async function fetchInvitation() {
      if (!token || !emailFromUrl) {
        setInvitationStatus('invalid');
        setError('Invalid invitation link');
        return;
      }

      try {
        setInvitationStatus('loading');
        // Fetch invitation metadata
        const response = await apiClient.get<{ name: string; role: string }>(
          `/api/v1/invitations/metadata?token=${encodeURIComponent(token)}&email=${encodeURIComponent(emailFromUrl)}`
        );

        // Store invitation name and mark as valid
        setInvitationName(response.name);
        setInvitationStatus('valid');
        // Don't clear error if it came from OAuth redirect (preserve URL error)
        if (!oauthError) {
          setError(null);
        }
      } catch (err) {
        if (err instanceof APIClientError) {
          // Check error code for specific handling
          if (err.code === 'INVITATION_EXPIRED') {
            setInvitationStatus('expired');
            setError(
              'This invitation has expired. Please contact your administrator for a new invitation.'
            );
          } else if (err.code === 'NOT_FOUND') {
            setInvitationStatus('invalid');
            setError('Invitation not found. Please check your email for the correct link.');
          } else {
            setInvitationStatus('invalid');
            setError(err.message || 'Failed to load invitation details');
          }
        } else {
          setInvitationStatus('invalid');
          setError('Failed to load invitation details');
        }
      }
    }

    void fetchInvitation();
  }, [token, emailFromUrl]);

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
      await apiClient.post('/api/auth/accept-invite', {
        body: {
          token: data.token,
          email: data.email,
          password: data.password,
          confirmPassword: data.confirmPassword,
        },
      });

      // Show success message
      setSuccess(true);

      // Session is created automatically by backend - redirect to dashboard
      // better-auth client picks up the session cookie automatically
      setTimeout(() => {
        router.push('/dashboard');
        router.refresh(); // Force server component re-render to pick up session
      }, 1500);
    } catch (err) {
      setIsLoading(false);

      if (err instanceof APIClientError) {
        setError(err.message || 'Failed to accept invitation. Please try again.');
      } else {
        setError('An unexpected error occurred. Please try again.');
      }
    }
  };

  // Loading state - show skeleton
  if (invitationStatus === 'loading') {
    return (
      <div className="space-y-4">
        <div className="bg-muted h-10 w-full animate-pulse rounded-md" />
        <div className="bg-muted h-10 w-full animate-pulse rounded-md" />
        <div className="bg-muted h-10 w-full animate-pulse rounded-md" />
        <div className="bg-muted h-10 w-full animate-pulse rounded-md" />
        <p className="text-muted-foreground text-center text-sm">Loading invitation...</p>
      </div>
    );
  }

  // Expired invitation - show amber message, hide form
  if (invitationStatus === 'expired') {
    return (
      <div className="space-y-4">
        <div className="rounded-md bg-amber-50 p-4 text-sm text-amber-900 dark:bg-amber-900/10 dark:text-amber-400">
          <p className="font-medium">Invitation Expired</p>
          <p className="mt-2">
            This invitation link has expired. Please contact your administrator to request a new
            invitation.
          </p>
        </div>
        <div className="text-center text-sm">
          <a href="/login" className="text-primary font-medium hover:underline">
            Back to login
          </a>
        </div>
      </div>
    );
  }

  // Invalid invitation - show error message, hide form
  if (invitationStatus === 'invalid') {
    return (
      <div className="space-y-4">
        <div className="bg-destructive/10 text-destructive rounded-md p-4 text-sm">
          <p className="font-medium">Invalid Invitation</p>
          <p className="mt-2">
            {error ||
              'This invitation link is invalid. Please check your email for the correct invitation link.'}
          </p>
        </div>
        <div className="text-center text-sm">
          <a href="/login" className="text-primary font-medium hover:underline">
            Back to login
          </a>
        </div>
      </div>
    );
  }

  // Valid invitation - show the form
  return (
    <>
      {success ? (
        <div className="space-y-4">
          <div className="rounded-md bg-green-50 p-4 text-sm text-green-900 dark:bg-green-900/10 dark:text-green-400">
            <p className="font-medium">Account activated successfully!</p>
            <p className="mt-1 text-xs">Redirecting to dashboard...</p>
          </div>
        </div>
      ) : (
        <>
          {/* OAuth Buttons Section */}
          <OAuthButtons
            mode="invitation"
            callbackUrl="/dashboard"
            errorCallbackUrl={errorCallbackUrl}
            invitationToken={token}
            invitationEmail={emailFromUrl}
          />

          {/* Password Form Section */}
          <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="space-y-4">
            {/* Hidden Token Field */}
            <input type="hidden" {...register('token')} />

            {/* Name Field (Disabled, Pre-filled from invitation) */}
            {invitationName && (
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  type="text"
                  value={invitationName}
                  disabled={true}
                  className="bg-muted"
                />
              </div>
            )}

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

            {/* Password Field */}
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
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
                Must be at least 8 characters with uppercase, lowercase, number, and special
                character
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

            {/* Error Message */}
            {error && (
              <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">
                {error}
              </div>
            )}

            {/* Submit Button */}
            <Button type="submit" className="w-full" disabled={isLoading || success}>
              {isLoading ? 'Activating account...' : 'Activate Account'}
            </Button>
          </form>
        </>
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
    </>
  );
}
