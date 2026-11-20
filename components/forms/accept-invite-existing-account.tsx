'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { authClient } from '@/lib/auth/client';
import { AUTH_LANDING_ROUTE } from '@/lib/auth-landing/route';
import { useSaveFailure } from '@/lib/hooks/use-save-failure';
import { useTimeout } from '@/lib/hooks/use-timeout';
import { Button } from '@/components/ui/button';
import { SaveError } from '@/components/forms/form-error';
import {
  DeclineInvitationButton,
  InvitationDeclined,
} from '@/components/forms/decline-invitation-button';

interface AcceptInviteExistingAccountProps {
  token: string;
  email: string;
  /** The org the invitation joins, when it names one. */
  orgName: string | null;
  /**
   * Whether the account's address is verified. Accepting needs it; an
   * unverified one is told to verify on sign-in first. Default true.
   */
  accountVerified?: boolean;
}

/**
 * The accept page for an address that already has an account (#1199).
 *
 * There is no password to set: the invitee signs in as the invited address
 * and accepts, and `POST /api/v1/invitations/accept` writes the membership.
 * Three states, from the session: signed out (sign in, then come back here),
 * signed in as someone else (say so, and offer to sign out), and signed in as
 * the invited address (accept or decline). The server makes the same checks;
 * this only shows the right step first.
 */
export function AcceptInviteExistingAccount({
  token,
  email,
  orgName,
  accountVerified = true,
}: AcceptInviteExistingAccountProps) {
  const t = useTranslations('auth');
  const router = useRouter();
  const schedule = useTimeout();
  const { data: session, isPending } = authClient.useSession();
  const [isAccepting, setIsAccepting] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [declined, setDeclined] = useState(false);
  const save = useSaveFailure({ fallback: t('shared.acceptFailed') });
  const [isSendingVerification, setIsSendingVerification] = useState(false);
  const [verificationSent, setVerificationSent] = useState(false);
  const verification = useSaveFailure({
    fallback: t('shared.sendVerificationFailed'),
  });

  // The org, for the catalogue's `select`: an invitation that names none says
  // "the organisation" in the sentence's own language.
  const org = { named: orgName ? 'yes' : 'no', org: orgName ?? '' };
  const returnTo = `/accept-invite?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;

  const accept = async () => {
    save.clear();
    setIsAccepting(true);
    try {
      const result = await apiClient.post<{ membership: { orgId: string; role: string } }>(
        API.INVITATIONS.ACCEPT,
        { body: { token, email } }
      );
      // Start working in the org just joined. If the switch fails the
      // membership still stands; they can switch from the org menu.
      try {
        await apiClient.post(API.ORGS.SWITCH, { body: { orgId: result.membership.orgId } });
      } catch {
        // Accepted either way.
      }
      setAccepted(true);
      // Full page load: the session's org changed, and pages rendered for the
      // previous org must not be served from the Router Cache.
      schedule(() => {
        window.location.href = AUTH_LANDING_ROUTE;
      }, 1500);
    } catch (err) {
      setIsAccepting(false);
      save.report(err);
    }
  };

  // Signed in but unverified: sign-in need not have offered a verification
  // email (an install may not require one to sign in), so offer it here.
  const sendVerification = async () => {
    verification.clear();
    setIsSendingVerification(true);
    try {
      await apiClient.post(API.AUTH.SEND_VERIFICATION_EMAIL, { body: { email } });
      setVerificationSent(true);
    } catch (err) {
      verification.report(err);
    } finally {
      setIsSendingVerification(false);
    }
  };

  const signOut = async () => {
    setIsSigningOut(true);
    try {
      await authClient.signOut({
        fetchOptions: {
          onSuccess: () => {
            // Back to this page, signed out, so the next step is signing in.
            window.location.href = returnTo;
          },
          onError: () => setIsSigningOut(false),
        },
      });
    } catch {
      setIsSigningOut(false);
    }
  };

  if (isPending) {
    return (
      <div className="space-y-4">
        <div className="bg-muted h-10 w-full animate-pulse rounded-md" />
        <p className="text-muted-foreground text-center text-sm">
          {t('acceptInvite.existing.checking')}
        </p>
      </div>
    );
  }

  if (declined) return <InvitationDeclined />;

  if (accepted) {
    return (
      <div className="rounded-md bg-green-50 p-4 text-sm text-green-900 dark:bg-green-900/10 dark:text-green-400">
        <p className="font-medium">{t('acceptInvite.existing.joined', org)}</p>
        <p className="mt-1 text-xs">{t('acceptInvite.existing.redirecting')}</p>
      </div>
    );
  }

  const signedInAs = session?.user.email ?? null;
  const isInvitedAccount =
    signedInAs !== null && signedInAs.toLowerCase() === email.trim().toLowerCase();

  return (
    <div className="space-y-4">
      <p className="text-sm">
        {t.rich('acceptInvite.existing.invited', {
          ...org,
          email,
          strong: (chunks) => <strong>{chunks}</strong>,
        })}
      </p>

      {signedInAs === null && (
        <>
          <p className="text-muted-foreground text-sm">
            {accountVerified
              ? t('acceptInvite.existing.signInToAccept', { email })
              : t('acceptInvite.existing.signInUnverified', { email })}
          </p>
          <Button
            className="w-full"
            onClick={() => router.push(`/login?callbackUrl=${encodeURIComponent(returnTo)}`)}
          >
            {t('acceptInvite.existing.signInButton')}
          </Button>
        </>
      )}

      {signedInAs !== null && !isInvitedAccount && (
        <>
          <div className="rounded-md bg-amber-50 p-4 text-sm text-amber-900 dark:bg-amber-900/10 dark:text-amber-400">
            {t.rich('acceptInvite.existing.wrongAccount', {
              current: signedInAs,
              email,
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
          </div>
          <Button className="w-full" onClick={() => void signOut()} disabled={isSigningOut}>
            {isSigningOut ? t('shared.signingOut') : t('shared.signOut')}
          </Button>
        </>
      )}

      {isInvitedAccount && !accountVerified && (
        <>
          <p className="text-muted-foreground text-sm">{t('acceptInvite.existing.unverified')}</p>
          {verificationSent ? (
            <p className="text-sm" role="status">
              {t('acceptInvite.existing.verificationSent', { email })}
            </p>
          ) : (
            <>
              <SaveError failure={verification.failure} />
              <Button
                className="w-full"
                onClick={() => void sendVerification()}
                disabled={isSendingVerification}
              >
                {isSendingVerification ? t('shared.sending') : t('shared.sendVerificationEmail')}
              </Button>
            </>
          )}
        </>
      )}

      {isInvitedAccount && accountVerified && (
        <>
          <SaveError failure={save.failure} />
          <Button className="w-full" onClick={() => void accept()} disabled={isAccepting}>
            {isAccepting
              ? t('acceptInvite.existing.accepting')
              : t('acceptInvite.existing.join', org)}
          </Button>
        </>
      )}

      <DeclineInvitationButton token={token} email={email} onDeclined={() => setDeclined(true)} />
    </div>
  );
}
