'use client';

/**
 * Takes up the plan an org's signup chose (§139 t-1096), on the billing page.
 *
 * The proxy sends the founder here (`/admin/billing?signup=plan`) on their
 * first visit to the landing route while their org has a signup plan
 * waiting. This asks `POST /api/v1/orgs/[id]/billing/signup-plan` once: a paid
 * plan answers a checkout, and the browser goes there. Anything else reloads
 * the page with what happened in the query (`?signup=applied`, `dropped`,
 * `failed`), which the page says; nothing waiting (already taken up, in
 * another tab say) reloads it with no query, saying nothing.
 *
 * Rendered by the page only for the org's OWNER; the route refuses anyone
 * else whatever this renders.
 */

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { z } from 'zod';

import { billingNavigation } from '@/components/admin/billing/billing-action-button';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { ORG_BILLING_PAGE_PATH, SIGNUP_PLAN_QUERY } from '@/lib/billing/routes';

/** The route's answer. A checkout's URL is over http(s) only. */
const answerSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('checkout'), url: z.url({ protocol: /^https?$/ }) }),
  z.object({ outcome: z.literal('applied') }),
  z.object({ outcome: z.literal('dropped') }),
  z.object({ outcome: z.literal('none') }),
]);

export function SignupPlanTakeUp({ orgId }: { orgId: string }) {
  const t = useTranslations('admin.billing.signupPlan');
  const router = useRouter();
  // Once per page load: the route takes the plan up once, and a second ask
  // (React running the effect twice in development) would answer `none`.
  const asked = useRef(false);

  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    void (async () => {
      let shown: string;
      try {
        const answer = answerSchema.parse(
          await apiClient.post<unknown>(API.ORGS.billingSignupPlan(orgId))
        );
        if (answer.outcome === 'checkout') {
          billingNavigation.go(answer.url);
          return;
        }
        shown = answer.outcome;
      } catch {
        shown = 'failed';
      }
      // The page says what happened (`?signup=applied`), and a reload does
      // not ask again.
      router.replace(
        shown === 'none'
          ? ORG_BILLING_PAGE_PATH
          : `${ORG_BILLING_PAGE_PATH}?${SIGNUP_PLAN_QUERY.key}=${shown}`
      );
    })();
  }, [orgId, router]);

  return (
    <p role="status" className="rounded-md border px-4 py-3 text-sm">
      {t('opening')}
    </p>
  );
}
