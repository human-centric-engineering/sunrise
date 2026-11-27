'use client';

/**
 * Takes up the plan an org's signup chose (§139 t-1096), on the billing page.
 *
 * A signup that chose a paid plan goes on to this page
 * (`/admin/billing?signup=plan`) once the person is signed in: the email form,
 * the Google button's callback, or the verification link's. This asks
 * `POST /api/v1/orgs/[id]/billing/signup-plan` once: a paid plan answers a
 * checkout, and the browser goes there. Anything else reloads the page with
 * what happened in the query (`?signup=applied`, `dropped`, `failed`), which
 * the page says; nothing to do reloads it with no query. While the plan still
 * waits, the reloaded page offers it again (`<SignupPlanNotice>`).
 *
 * Rendered by the page only for the org's OWNER; the route refuses anyone
 * else whatever this renders.
 */

import { useEffect, useRef, useState } from 'react';
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

/** How often, and how many times, the page asks again while the org is set up. */
export const SETUP_POLL_MS = 2_000;
export const SETUP_POLL_TRIES = 30;

export interface SignupPlanTakeUpProps {
  orgId: string;
  /**
   * The org's setup is finished, so the checkout may start. Until it is, the
   * page says so and is asked again every {@link SETUP_POLL_MS}, up to
   * {@link SETUP_POLL_TRIES} times; the org-created hooks it waits on run
   * after the response that sent the founder here.
   */
  ready: boolean;
}

export function SignupPlanTakeUp({ orgId, ready }: SignupPlanTakeUpProps) {
  const t = useTranslations('admin.billing.signupPlan');
  const router = useRouter();
  // Once per page load: the route takes the plan up once, and a second ask
  // (React running the effect twice in development) would answer `none`.
  const asked = useRef(false);
  const [tries, setTries] = useState(0);

  // Not ready: ask the server again, until it is or the tries run out.
  useEffect(() => {
    if (ready || tries >= SETUP_POLL_TRIES) return;
    const timer = window.setTimeout(() => {
      setTries((n) => n + 1);
      router.refresh();
    }, SETUP_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [ready, tries, router]);

  // Restored by Back from the back-forward cache, the page is as it was when
  // it left ("Taking you…"): load the billing page afresh instead.
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) billingNavigation.reload(ORG_BILLING_PAGE_PATH);
    };
    window.addEventListener('pageshow', restored);
    return () => window.removeEventListener('pageshow', restored);
  }, []);

  useEffect(() => {
    if (!ready || asked.current) return;
    asked.current = true;
    void (async () => {
      let shown: string;
      try {
        const answer = answerSchema.parse(
          await apiClient.post<unknown>(API.ORGS.billingSignupPlan(orgId))
        );
        if (answer.outcome === 'checkout') {
          // Back from the provider's page comes to the billing page, which
          // offers the plan again, not to this page, which would start
          // another checkout.
          window.history.replaceState(null, '', ORG_BILLING_PAGE_PATH);
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
  }, [orgId, ready, router]);

  return (
    <p role="status" className="rounded-md border px-4 py-3 text-sm">
      {ready ? t('opening') : tries >= SETUP_POLL_TRIES ? t('stillSettingUp') : t('settingUp')}
    </p>
  );
}
