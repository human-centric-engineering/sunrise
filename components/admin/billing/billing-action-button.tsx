'use client';

/**
 * A button on the billing page that sends the owner to the payment
 * provider's own pages (§139 t-1095): a checkout for one plan, or the
 * customer portal. It asks the route for the URL, then the browser goes
 * there. A refusal shows beside the button (`<SaveError>`), in the route's
 * words: "already subscribed", "price not set up", and so on.
 *
 * Shown to the org's OWNER only, by the page; the routes refuse anyone else
 * whatever this renders.
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { z } from 'zod';

import { SaveError } from '@/components/forms/form-error';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { NO_SERVER_FIELDS, useSaveFailure } from '@/lib/hooks/use-save-failure';

/** The routes' answer: a page on the provider's site, over http(s) only. */
const redirectSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
});

/** Where the browser goes. A seam for tests, which cannot navigate. */
export const billingNavigation = {
  go(url: string): void {
    window.location.assign(url);
  },
};

export type BillingActionButtonProps =
  | { orgId: string; kind: 'checkout'; planKey: string; label: string }
  | { orgId: string; kind: 'portal'; label: string };

export function BillingActionButton(props: BillingActionButtonProps) {
  const t = useTranslations('admin.billing.actions');
  const [pending, setPending] = useState(false);
  // Left pending as the page goes away; Back from the provider's page can
  // restore it from the back-forward cache as it was, so clear it then.
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) setPending(false);
    };
    window.addEventListener('pageshow', restored);
    return () => window.removeEventListener('pageshow', restored);
  }, []);
  const save = useSaveFailure({
    fallback: props.kind === 'checkout' ? t('checkoutFailed') : t('portalFailed'),
    fields: NO_SERVER_FIELDS,
  });

  const go = async () => {
    save.clear();
    setPending(true);
    try {
      const answer =
        props.kind === 'checkout'
          ? await apiClient.post<unknown>(API.ORGS.billingCheckout(props.orgId), {
              body: { planKey: props.planKey },
            })
          : await apiClient.post<unknown>(API.ORGS.billingPortal(props.orgId));
      const { url } = redirectSchema.parse(answer);
      billingNavigation.go(url);
      // Left pending: the page is going away.
    } catch (err) {
      save.report(err);
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col items-start gap-2">
      <Button type="button" onClick={() => void go()} disabled={pending}>
        {pending ? t('opening') : props.label}
      </Button>
      <SaveError failure={save.failure} />
    </div>
  );
}
