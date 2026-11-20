'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useEffect, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { createAcceptInvitationSchema, type AcceptInvitationInput } from '@/lib/validations/user';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { authClient } from '@/lib/auth/client';
import { useAnalytics } from '@/lib/analytics';
import { useFormAnalytics } from '@/lib/analytics/events';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { FormError, SaveError } from '@/components/forms/form-error';
import { NoScriptNotice } from '@/components/forms/no-script-notice';
import { PasswordStrength } from '@/components/forms/password-strength';
import { OAuthButtons } from '@/components/forms/oauth-buttons';
import { AUTH_LANDING_ROUTE } from '@/lib/auth-landing/route';
import { useTimeout } from '@/lib/hooks/use-timeout';
import { useSaveFailure } from '@/lib/hooks/use-save-failure';
import { AcceptInviteExistingAccount } from '@/components/forms/accept-invite-existing-account';
import {
  DeclineInvitationButton,
  InvitationDeclined,
} from '@/components/forms/decline-invitation-button';

/** Server path → the field that shows it: every field here renders its message. */
// No `email`: its input is read-only (the invitation's address), so a message
// about it goes by the button, where it can be read, not under a field no one
// can fix.
const SERVER_FIELDS: Partial<Record<string, keyof AcceptInvitationInput>> = {
  password: 'password',
  confirmPassword: 'confirmPassword',
};

/**
 * Invitation validation status
 */
type InvitationStatus = 'loading' | 'valid' | 'expired' | 'invalid';

/**
 * Why the invitation can't be used, or the OAuth sign-in that failed: a
 * catalogue message (looked up as the page renders, so it follows the
 * viewer's language), or the server's own text.
 */
type LoadError =
  | {
      key:
        | 'oauthWrongEmailUnknown'
        | 'oauthFailed'
        | 'invalidLink'
        | 'accountExists'
        | 'expired'
        | 'notFound'
        | 'loadFailed';
    }
  | { key: 'oauthWrongEmail'; email: string }
  | { text: string };

/**
 * Parse OAuth error from URL parameter into user-friendly message
 *
 * OAuth errors come URL-encoded with underscores replacing spaces.
 * We detect specific error patterns and return friendly messages.
 */
function parseOAuthError(error: string): LoadError {
  // Decode and normalize the error message
  const decoded = decodeURIComponent(error).replace(/_/g, ' ');

  // Check for email mismatch error (our custom error from before hook)
  if (decoded.includes('invitation was sent to')) {
    // Matched before underscores become spaces, so an address keeps its own
    // ("john_doe@acme.com"). It runs to the full stop that ends the sentence,
    // so the dots inside it ("jane.doe@acme.com") stay part of it too.
    const emailMatch = decodeURIComponent(error).match(/sent[ _]to[ _](\S+?)\.(?:[\s_]|$)/);
    return emailMatch
      ? { key: 'oauthWrongEmail', email: emailMatch[1] }
      : { key: 'oauthWrongEmailUnknown' };
  }

  // Generic OAuth error fallback
  return { key: 'oauthFailed' };
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
  const schedule = useTimeout();
  const t = useTranslations('auth');
  const tv = useTranslations('validation');
  const acceptInvitationSchema = useMemo(() => createAcceptInvitationSchema(tv), [tv]);

  // Read token, email, and error from URL
  const token = searchParams.get('token') || '';
  const emailFromUrl = searchParams.get('email') || '';
  const oauthError = searchParams.get('error');

  const [invitationStatus, setInvitationStatus] = useState<InvitationStatus>('loading');
  const [isLoading, setIsLoading] = useState(false);
  // Why the invitation can't be used, or the OAuth sign-in that failed: what
  // the page found as it loaded. A failed activation is `save` below.
  const [loadError, setLoadError] = useState<LoadError | null>(
    // Parse OAuth error from URL if present
    oauthError ? parseOAuthError(oauthError) : null
  );
  const { identify } = useAnalytics();
  const { trackFormSubmitted } = useFormAnalytics();

  // Build error callback URL to return here with token/email preserved
  const errorCallbackUrl = `/accept-invite?token=${encodeURIComponent(token)}&email=${encodeURIComponent(emailFromUrl)}`;
  const [success, setSuccess] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [invitationName, setInvitationName] = useState<string>('');
  // The address already has an account: it signs in and accepts, with no
  // password to set (#1199).
  const [existingAccount, setExistingAccount] = useState<{
    orgName: string | null;
    verified: boolean;
  } | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    setError,
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

  const save = useSaveFailure({
    fallback: t('shared.acceptFailed'),
    fields: SERVER_FIELDS,
    setError,
    errors,
  });

  // Watch password field for strength meter
  const password = watch('password');

  // Fetch invitation metadata on mount
  useEffect(() => {
    async function fetchInvitation() {
      if (!token || !emailFromUrl) {
        setInvitationStatus('invalid');
        setLoadError({ key: 'invalidLink' });
        return;
      }

      try {
        setInvitationStatus('loading');
        // Fetch invitation metadata
        const response = await apiClient.get<{
          name: string;
          role: string;
          orgName?: string | null;
          accountExists?: boolean;
          accountVerified?: boolean;
          newAccountOnly?: boolean;
        }>(
          `${API.INVITATIONS.METADATA}?token=${encodeURIComponent(token)}&email=${encodeURIComponent(emailFromUrl)}`
        );

        // An invitation that only creates an account, for an address that
        // already has one: nothing on this page can redeem it (#1199).
        if (response.accountExists && response.newAccountOnly) {
          setInvitationStatus('invalid');
          setLoadError({ key: 'accountExists' });
          return;
        }

        // Store invitation name and mark as valid
        setInvitationName(response.name);
        setExistingAccount(
          response.accountExists
            ? { orgName: response.orgName ?? null, verified: response.accountVerified ?? true }
            : null
        );
        setInvitationStatus('valid');
        // Don't clear error if it came from OAuth redirect (preserve URL error)
        if (!oauthError) {
          setLoadError(null);
        }
      } catch (err) {
        if (err instanceof APIClientError) {
          // Check error code for specific handling
          if (err.code === 'INVITATION_EXPIRED') {
            setInvitationStatus('expired');
            setLoadError({ key: 'expired' });
          } else if (err.code === 'NOT_FOUND') {
            setInvitationStatus('invalid');
            setLoadError({ key: 'notFound' });
          } else {
            setInvitationStatus('invalid');
            setLoadError(err.message ? { text: err.message } : { key: 'loadFailed' });
          }
        } else {
          setInvitationStatus('invalid');
          setLoadError({ key: 'loadFailed' });
        }
      }
    }

    void fetchInvitation();
  }, [token, emailFromUrl, oauthError]);

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

      // Submit to accept-invite endpoint (creates user, verifies email, sets role)
      await apiClient.post('/api/auth/accept-invite', {
        body: {
          token: data.token,
          email: data.email,
          password: data.password,
          confirmPassword: data.confirmPassword,
        },
      });

      // Sign in via better-auth client to update client-side session state.
      // The API endpoint already created a server session, but the better-auth
      // nanostore (used by useSession) doesn't know about it. Signing in via
      // the client ensures the nanostore is updated so UserButton reflects
      // the authenticated state immediately without a hard refresh.
      const signInResult = await authClient.signIn.email({
        email: data.email,
        password: data.password,
      });

      if (signInResult.data?.user?.id) {
        await identify(signInResult.data.user.id);
      }

      // Track invite acceptance
      void trackFormSubmitted('invite');

      // Show success message
      setSuccess(true);

      // Redirect to dashboard
      schedule(() => {
        router.push(AUTH_LANDING_ROUTE);
      }, 1500);
    } catch (err) {
      setIsLoading(false);
      save.report(err);
    }
  };

  const loadErrorMessage = !loadError
    ? null
    : 'text' in loadError
      ? loadError.text
      : loadError.key === 'oauthWrongEmail'
        ? t('acceptInvite.form.oauthWrongEmail', { email: loadError.email })
        : t(`acceptInvite.form.${loadError.key}`);

  // Loading state - show skeleton
  if (invitationStatus === 'loading') {
    return (
      <div className="space-y-4">
        {/* The form only appears once the invitation has loaded, so never without JavaScript. */}
        <NoScriptNotice />
        <div className="bg-muted h-10 w-full animate-pulse rounded-md" />
        <div className="bg-muted h-10 w-full animate-pulse rounded-md" />
        <div className="bg-muted h-10 w-full animate-pulse rounded-md" />
        <div className="bg-muted h-10 w-full animate-pulse rounded-md" />
        <p className="text-muted-foreground text-center text-sm">
          {t('acceptInvite.form.loading')}
        </p>
      </div>
    );
  }

  // Expired invitation - show amber message, hide form
  if (invitationStatus === 'expired') {
    return (
      <div className="space-y-4">
        <div className="rounded-md bg-amber-50 p-4 text-sm text-amber-900 dark:bg-amber-900/10 dark:text-amber-400">
          <p className="font-medium">{t('acceptInvite.form.expiredTitle')}</p>
          <p className="mt-2">{t('acceptInvite.form.expiredBody')}</p>
        </div>
        <div className="text-center text-sm">
          <a href="/login" className="text-primary font-medium hover:underline">
            {t('shared.backToLogin')}
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
          <p className="font-medium">{t('acceptInvite.form.invalidTitle')}</p>
          <p className="mt-2">{loadErrorMessage || t('acceptInvite.form.invalidBody')}</p>
        </div>
        <div className="text-center text-sm">
          <a href="/login" className="text-primary font-medium hover:underline">
            {t('shared.backToLogin')}
          </a>
        </div>
      </div>
    );
  }

  // Declined from the form below: nothing on it can succeed any more.
  if (declined) return <InvitationDeclined />;

  // Valid invitation for an address that already has an account: sign in
  // and accept, rather than set a password.
  if (existingAccount) {
    return (
      <AcceptInviteExistingAccount
        token={token}
        email={emailFromUrl}
        orgName={existingAccount.orgName}
        accountVerified={existingAccount.verified}
      />
    );
  }

  // Valid invitation - show the form
  return (
    <>
      {success ? (
        <div className="space-y-4">
          <div className="rounded-md bg-green-50 p-4 text-sm text-green-900 dark:bg-green-900/10 dark:text-green-400">
            <p className="font-medium">{t('acceptInvite.form.activated')}</p>
            <p className="mt-1 text-xs">{t('acceptInvite.form.redirecting')}</p>
          </div>
        </div>
      ) : (
        <>
          {/* OAuth Buttons Section */}
          <OAuthButtons
            mode="invitation"
            callbackUrl={AUTH_LANDING_ROUTE}
            errorCallbackUrl={errorCallbackUrl}
            invitationToken={token}
            invitationEmail={emailFromUrl}
          />

          {/* Password Form Section */}
          <form
            method="post"
            noValidate
            onSubmit={(e) => {
              // A new attempt answers an earlier OAuth failure, blocked or not:
              // a blocked save's summary clears itself as fields are fixed
              // (t-1013), and the old OAuth error must not come back then.
              setLoadError(null);
              save.submit(handleSubmit(onSubmit, save.invalid))(e);
            }}
            className="space-y-4"
          >
            {/* Hidden Token Field */}
            <input type="hidden" {...register('token')} />

            {/* Name Field (Disabled, Pre-filled from invitation) */}
            {invitationName && (
              <div className="space-y-2">
                <Label htmlFor="name">{t('fields.name')}</Label>
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
              <Label htmlFor="email">{t('fields.email')}</Label>
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
              <Label htmlFor="password">{t('fields.password')}</Label>
              <PasswordInput
                id="password"
                placeholder="••••••••"
                autoComplete="new-password"
                disabled={isLoading}
                {...register('password')}
              />
              <FormError message={errors.password?.message} />
              <PasswordStrength password={password} />
              <p className="text-muted-foreground text-xs">{t('fields.passwordHint')}</p>
            </div>

            {/* Confirm Password Field */}
            <div className="space-y-2">
              <Label htmlFor="confirmPassword">{t('fields.confirmPassword')}</Label>
              <PasswordInput
                id="confirmPassword"
                placeholder="••••••••"
                autoComplete="new-password"
                disabled={isLoading}
                {...register('confirmPassword')}
              />
              <FormError message={errors.confirmPassword?.message} />
            </div>

            {/* A failed activation, beside Activate Account */}
            <SaveError failure={save.failure} />
            {!save.failure && loadErrorMessage && <FormError message={loadErrorMessage} />}

            {/* Submit Button */}
            <Button type="submit" className="w-full" disabled={isLoading || success}>
              {isLoading ? t('acceptInvite.form.activating') : t('acceptInvite.form.submit')}
            </Button>
          </form>
        </>
      )}

      {/* Login Link */}
      {!success && (
        <div className="mt-4 text-center text-sm">
          {t.rich('shared.signInPrompt', {
            muted: (chunks) => <span className="text-muted-foreground">{chunks}</span>,
            link: (chunks) => (
              <a href="/login" className="text-primary font-medium hover:underline">
                {chunks}
              </a>
            ),
          })}
        </div>
      )}

      {!success && (
        <div className="mt-2">
          <DeclineInvitationButton
            token={token}
            email={emailFromUrl}
            onDeclined={() => setDeclined(true)}
          />
        </div>
      )}
    </>
  );
}
