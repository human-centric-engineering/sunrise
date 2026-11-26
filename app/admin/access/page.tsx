import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { AccessExplainerView } from '@/components/admin/access-explainer/access-explainer-view';
import { API } from '@/lib/api/endpoints';
import { loadServerData } from '@/lib/api/server-load';
import { requestActingOrg } from '@/lib/auth/admin-page-viewer';
import { logger } from '@/lib/logging';
import { isMultiTenant } from '@/lib/tenancy/context';
import {
  accessExplainerResponseSchema,
  type AccessExplainerResponse,
} from '@/lib/validations/access-explainer';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.access.page');
  return { title: t('metaTitle'), description: t('metaDescription') };
}

/**
 * Admin — roles and access (§143 t-1091).
 *
 * Open to every viewer the console admits (`EVERY_VIEWER_ADMIN_PAGES`): a
 * platform admin, an org's OWNER/ADMIN and a holder of any of the app's named
 * tiers. A shell over `GET /api/v1/admin/access`, which narrows its answer to
 * the caller, so each viewer sees their own slice and this page decides
 * nothing. A response that cannot be loaded, or does not match the schema,
 * says so in the page's place; `loadServerData` logs a failed load.
 */
async function getExplainer(): Promise<AccessExplainerResponse | null> {
  const result = await loadServerData<unknown>(API.ADMIN.ACCESS);
  if (!result.ok) return null;
  const parsed = accessExplainerResponseSchema.safeParse(result.data);
  if (!parsed.success) {
    logger.error('access explainer: the response did not match its schema', {
      issues: parsed.error.issues.slice(0, 5),
    });
    return null;
  }
  return parsed.data;
}

export default async function AccessExplainerPage() {
  const [explainer, org] = await Promise.all([
    getExplainer(),
    // The org is named in the viewer's panel at `multi` only; a failed
    // lookup leaves the name out rather than the page.
    isMultiTenant()
      ? requestActingOrg().catch((error: unknown) => {
          logger.error('access page: could not read the acting org', error);
          return null;
        })
      : Promise.resolve(null),
  ]);
  const t = await getTranslations('admin.access.page');

  return (
    <div className="max-w-5xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('intro')}</p>
      </header>
      {explainer ? (
        <AccessExplainerView
          explainer={explainer}
          orgName={explainer.audience === 'platform' ? null : (org?.name ?? null)}
        />
      ) : (
        <p role="alert" className="text-destructive text-sm">
          {t('loadFailed')}
        </p>
      )}
    </div>
  );
}
