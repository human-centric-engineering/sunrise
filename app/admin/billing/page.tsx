import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { BillingSummary, type OrgBillingView } from '@/components/admin/billing/billing-summary';
import { SignupPlanNotice } from '@/components/admin/billing/signup-plan-notice';
import { SignupPlanTakeUp } from '@/components/admin/billing/signup-plan-take-up';
import { API } from '@/lib/api/endpoints';
import { AUTH_LANDING_ROUTE } from '@/lib/auth-landing/route';
import { loadServerData } from '@/lib/api/server-load';
import { requestActingOrg } from '@/lib/auth/admin-page-viewer';
import { billingEnabled } from '@/lib/billing/config';
import { ORG_BILLING_PAGE_PATH, SIGNUP_PLAN_QUERY } from '@/lib/billing/routes';
import { logger } from '@/lib/logging';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.billing');
  return { title: t('metaTitle'), description: t('metaDescription') };
}

/**
 * Admin — Billing for the org being administered (§139 t-1095).
 *
 * Org-tier: the org's OWNER and ADMIN open it for the org they act in, and a
 * platform admin for the org they are in. A thin shell over
 * `GET /api/v1/orgs/[id]/billing`, which says what the viewer may do: the
 * OWNER gets the checkout and portal buttons, everyone else the same page
 * read-only. It is where the provider sends the owner back to after a
 * checkout (`?checkout=success|cancelled`) or the portal, and where a signup
 * that chose a paid plan goes on to (`?signup=plan`, §139 t-1096), which
 * starts its checkout. While that plan waits, the page offers it to the owner
 * (`signupPlan` in the read), until a subscription starts or they choose
 * another.
 *
 * With billing off the page does not exist, as its routes answer
 * `billing_off`, and its sidebar item is hidden. Billing that cannot be
 * loaded says so in its place, never as "no plan"; `loadServerData` logs the
 * failure (#518).
 */
export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!billingEnabled()) notFound();

  // A failed lookup says billing could not be loaded, in the page's place.
  const [acting, query] = await Promise.all([
    requestActingOrg().catch((error: unknown) => {
      logger.error('billing page: could not read the acting org', error);
      return 'failed' as const;
    }),
    searchParams,
  ]);
  const orgReadFailed = acting === 'failed';
  const org = orgReadFailed ? null : acting;
  const t = await getTranslations('admin.billing');
  const result =
    org && org.id !== INSTALL_ORG_ID
      ? await loadServerData<OrgBillingView>(API.ORGS.billing(org.id))
      : null;
  const returned = query.checkout;
  // Sent here to take up the plan the signup chose (§139 t-1096), or back
  // from doing so with what happened.
  const signup = query[SIGNUP_PLAN_QUERY.key];
  // Sent here by a signup with nothing for this viewer to start (one whose
  // plan the server dropped, an existing account signing in from a pricing
  // link, an ADMIN): on to the landing route, as the signup would have gone.
  // A failed read stays, to say so.
  if (
    signup === SIGNUP_PLAN_QUERY.value &&
    !orgReadFailed &&
    (result === null || (result.ok && !(result.data.mayChange && result.data.signupPlan)))
  ) {
    redirect(AUTH_LANDING_ROUTE);
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">
          {org ? t('titleFor', { org: org.name }) : t('title')}
        </h1>
        <p className="text-muted-foreground text-sm">{t('intro')}</p>
      </header>

      {returned === 'success' && (
        <p role="status" className="rounded-md border px-4 py-3 text-sm">
          {t('checkoutSuccess')}{' '}
          {/* Not a plain reload: that keeps `?checkout=success` and this note. */}
          <Link href={ORG_BILLING_PAGE_PATH} className="underline">
            {t('checkoutRefresh')}
          </Link>
        </p>
      )}
      {returned === 'cancelled' && (
        <p role="status" className="rounded-md border px-4 py-3 text-sm">
          {t('checkoutCancelled')}
        </p>
      )}

      {/* The signup's continuation: start the paid plan's checkout at once. */}
      {signup === SIGNUP_PLAN_QUERY.value &&
        result?.ok &&
        result.data.mayChange &&
        result.data.signupPlan && (
          <SignupPlanTakeUp orgId={result.data.orgId} ready={result.data.signupPlan.ready} />
        )}
      {/* Still waiting (checkout left or failed): offered until settled. */}
      {/* Not just back from paying: the webhook settling it may lag the return. */}
      {signup !== SIGNUP_PLAN_QUERY.value &&
        returned !== 'success' &&
        result?.ok &&
        result.data.mayChange &&
        result.data.signupPlan && (
          <SignupPlanNotice
            orgId={result.data.orgId}
            planLabel={result.data.signupPlan.label}
            ready={result.data.signupPlan.ready}
          />
        )}
      {(signup === 'applied' || signup === 'dropped' || signup === 'failed') && (
        <p
          role={signup === 'failed' ? 'alert' : 'status'}
          className="rounded-md border px-4 py-3 text-sm"
        >
          {t(`signupPlan.${signup}`)}
        </p>
      )}

      {orgReadFailed ? (
        <p role="alert" className="text-destructive text-sm">
          {t('loadFailed')}
        </p>
      ) : !org ? (
        <p className="text-muted-foreground text-sm">{t('noOrg')}</p>
      ) : org.id === INSTALL_ORG_ID ? (
        <p className="text-muted-foreground text-sm">{t('installOrg')}</p>
      ) : result?.ok ? (
        <BillingSummary billing={result.data} />
      ) : result && result.failure.kind === 'failed' && result.failure.status === 403 ? (
        // Refused, not failed: reloading would not help.
        <p className="text-muted-foreground text-sm">{t('noAccess')}</p>
      ) : (
        <p role="alert" className="text-destructive text-sm">
          {t('loadFailed')}
        </p>
      )}
    </div>
  );
}
