import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { BillingSummary, type OrgBillingView } from '@/components/admin/billing/billing-summary';
import { API } from '@/lib/api/endpoints';
import { loadServerData } from '@/lib/api/server-load';
import { requestActingOrg } from '@/lib/auth/admin-page-viewer';
import { billingEnabled } from '@/lib/billing/config';
import { ORG_BILLING_PAGE_PATH } from '@/lib/billing/upgrade-url';
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
 * checkout (`?checkout=success|cancelled`) or the portal.
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

  const [org, query] = await Promise.all([requestActingOrg(), searchParams]);
  const t = await getTranslations('admin.billing');
  const result =
    org && org.id !== INSTALL_ORG_ID
      ? await loadServerData<OrgBillingView>(API.ORGS.billing(org.id))
      : null;
  const returned = query.checkout;

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

      {!org ? (
        <p className="text-muted-foreground text-sm">{t('noOrg')}</p>
      ) : org.id === INSTALL_ORG_ID ? (
        <p className="text-muted-foreground text-sm">{t('installOrg')}</p>
      ) : result?.ok ? (
        <BillingSummary billing={result.data} />
      ) : (
        <p role="alert" className="text-destructive text-sm">
          {t('loadFailed')}
        </p>
      )}
    </div>
  );
}
