'use client';

/**
 * The button on the pages a waitlist email links to (§125 t-977): confirm the
 * address, or leave the list.
 *
 * The link opens this page and nothing more; the press posts the token. Mail
 * scanners open every link in a message before the person does, so a link
 * that acted on its own would confirm, or erase, on the scanner's visit.
 *
 * A failed press shows the server's message beside the button
 * (`<SaveError>`): "expired or already used" for a confirm link that cannot
 * work, whatever the reason.
 */

import { useState } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { useSaveFailure } from '@/lib/hooks/use-save-failure';
import { Button } from '@/components/ui/button';
import { SaveError } from '@/components/forms/form-error';

export interface WaitlistLinkActionCopy {
  buttonLabel: string;
  doneMessage: string;
  failureMessage: string;
}

export type WaitlistLinkActionProps =
  | { action: 'confirm'; entry: string; token: string; copy: WaitlistLinkActionCopy }
  | { action: 'leave'; token: string; copy: WaitlistLinkActionCopy };

export function WaitlistLinkAction(props: WaitlistLinkActionProps) {
  const { copy } = props;
  const [isLoading, setIsLoading] = useState(false);
  const [isDone, setIsDone] = useState(false);
  const save = useSaveFailure({ fallback: copy.failureMessage });

  const onPress = save.submit(async () => {
    try {
      setIsLoading(true);
      if (props.action === 'confirm') {
        await apiClient.post(API.PUBLIC.WAITLIST_CONFIRM, {
          body: { entry: props.entry, token: props.token },
        });
      } else {
        await apiClient.post(API.PUBLIC.WAITLIST_LEAVE, { body: { token: props.token } });
      }
      setIsDone(true);
    } catch (err) {
      save.report(err);
    } finally {
      setIsLoading(false);
    }
  });

  if (isDone) {
    return (
      <p className="flex items-center gap-2" role="status">
        <CheckCircle2 className="h-5 w-5 text-green-600" aria-hidden="true" />
        {copy.doneMessage}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <Button type="button" onClick={onPress} disabled={isLoading}>
        {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
        {copy.buttonLabel}
      </Button>
      <SaveError failure={save.failure} />
    </div>
  );
}
