'use client';

/**
 * The paid plan the org's signup chose, still waiting for its checkout
 * (§139 t-1096), offered on the billing page: continue to its checkout, or
 * choose a different plan instead, which removes it. It is what an owner who
 * left the checkout page, or whose checkout failed, comes back to; a
 * subscription starting removes it.
 *
 * Continuing asks `POST /api/v1/orgs/[id]/billing/signup-plan` for the
 * checkout and goes there; choosing another asks `DELETE` on the same route
 * and refreshes the page. A failure shows beside the buttons (`<SaveError>`).
 *
 * Rendered by the page for the org's OWNER only; the route refuses anyone
 * else whatever this renders.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { z } from 'zod';

import { billingNavigation } from '@/components/admin/billing/billing-action-button';
import { SaveError } from '@/components/forms/form-error';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { NO_SERVER_FIELDS, useSaveFailure } from '@/lib/hooks/use-save-failure';

/** The route's answer to `POST`. A checkout's URL is over http(s) only. */
const takeUpSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('checkout'), url: z.url({ protocol: /^https?$/ }) }),
  z.object({ outcome: z.enum(['applied', 'dropped', 'none']) }),
]);

export interface SignupPlanNoticeProps {
  orgId: string;
  planLabel: string;
}

export function SignupPlanNotice({ orgId, planLabel }: SignupPlanNoticeProps) {
  const t = useTranslations('admin.billing.signupPlan');
  const router = useRouter();
  const [pending, setPending] = useState<'continue' | 'dismiss' | null>(null);
  // Left pending as the page goes away; Back from the provider's page can
  // restore it from the back-forward cache as it was, so clear it then.
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) setPending(null);
    };
    window.addEventListener('pageshow', restored);
    return () => window.removeEventListener('pageshow', restored);
  }, []);
  const save = useSaveFailure({ fallback: t('continueFailed'), fields: NO_SERVER_FIELDS });

  const proceed = async () => {
    save.clear();
    setPending('continue');
    try {
      const answer = takeUpSchema.parse(
        await apiClient.post<unknown>(API.ORGS.billingSignupPlan(orgId))
      );
      if (answer.outcome === 'checkout') {
        billingNavigation.go(answer.url);
        return; // Left pending: the page is going away.
      }
      router.refresh();
    } catch (err) {
      save.report(err);
    }
    setPending(null);
  };

  const dismiss = async () => {
    save.clear();
    setPending('dismiss');
    try {
      await apiClient.delete<unknown>(API.ORGS.billingSignupPlan(orgId));
      router.refresh();
    } catch (err) {
      save.report(err);
    }
    setPending(null);
  };

  return (
    <section
      aria-labelledby="signup-plan-notice"
      className="space-y-3 rounded-md border px-4 py-3 text-sm"
    >
      <p id="signup-plan-notice">{t('waiting', { plan: planLabel })}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => void proceed()} disabled={pending !== null}>
          {pending === 'continue' ? t('continuing') : t('continue', { plan: planLabel })}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => void dismiss()}
          disabled={pending !== null}
        >
          {t('dismiss')}
        </Button>
      </div>
      <SaveError failure={save.failure} />
    </section>
  );
}
