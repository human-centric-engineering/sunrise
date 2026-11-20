'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { useSaveFailure } from '@/lib/hooks/use-save-failure';
import { Button } from '@/components/ui/button';
import { SaveError } from '@/components/forms/form-error';

interface DeclineInvitationButtonProps {
  token: string;
  email: string;
  /**
   * Called once the invitation is gone. The page must then stop offering the
   * steps above this button (accept, set a password, sign in), which would
   * only fail now.
   */
  onDeclined: () => void;
}

/**
 * Turn an invitation down from the accept page (#1199). The link is the whole
 * authority (`POST /api/v1/invitations/decline`), so this works signed in or
 * not, for a new account or an existing one. Asks once before deleting the
 * invitation, because a declined invitation has to be sent again to be used.
 */
export function DeclineInvitationButton({
  token,
  email,
  onDeclined,
}: DeclineInvitationButtonProps) {
  const t = useTranslations('auth.acceptInvite.decline');
  const [confirming, setConfirming] = useState(false);
  const [isDeclining, setIsDeclining] = useState(false);
  const save = useSaveFailure({ fallback: t('failed') });

  const decline = async () => {
    save.clear();
    setIsDeclining(true);
    try {
      await apiClient.post(API.INVITATIONS.DECLINE, { body: { token, email } });
      onDeclined();
    } catch (err) {
      save.report(err);
      setIsDeclining(false);
    }
  };

  if (!confirming) {
    return (
      <div className="text-center">
        <Button variant="link" size="sm" onClick={() => setConfirming(true)}>
          {t('button')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border p-3 text-sm">
      <p>{t('confirm')}</p>
      <SaveError failure={save.failure} />
      <div className="flex gap-2">
        <Button
          variant="destructive"
          size="sm"
          onClick={() => void decline()}
          disabled={isDeclining}
        >
          {isDeclining ? t('declining') : t('decline')}
        </Button>
        <Button variant="outline" size="sm" onClick={() => setConfirming(false)}>
          {t('keep')}
        </Button>
      </div>
    </div>
  );
}

/** What the accept page shows in place of everything once the invitation is declined. */
export function InvitationDeclined() {
  const t = useTranslations('auth.acceptInvite.decline');
  return (
    <p className="text-muted-foreground text-center text-sm" role="status">
      {t('declined')}
    </p>
  );
}
