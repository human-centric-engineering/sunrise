import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import {
  OrgOptionsForm,
  type OrgOptionsView,
} from '@/components/admin/org-options/org-options-form';
import { OrgLanguageForm } from '@/components/admin/org-options/org-language-form';
import { API } from '@/lib/api/endpoints';
import { loadServerData } from '@/lib/api/server-load';
import { requestActingOrg, requestSupportSession } from '@/lib/auth/admin-page-viewer';
import { localeOptions } from '@/lib/i18n/locale-options';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.orgOptions');
  return { title: t('metaTitle'), description: t('metaDescription') };
}

/**
 * Admin — the options this organisation's own admins may set (§135 t-1054):
 * the language its members see by default (§138 t-1074), and the switches
 * the app registers `setBy: 'org'`.
 *
 * Org-tier: the org's OWNER/ADMIN open it for the org they act in. A thin
 * shell over `GET /api/v1/orgs/[id]` (the org's `settings.locale`) and
 * `GET /api/v1/orgs/[id]/entitlements`; the routes decide who may change
 * them. Anything that cannot be loaded says so in its place, never as "no
 * language" or "no options"; `loadServerData` logs the failure (#518).
 *
 * The language is read as a member reads it, so a support session (no
 * membership, and the locale route refuses support) is told why it is not
 * shown rather than offered a read that fails.
 */
async function getOptions(orgId: string): Promise<OrgOptionsView | null> {
  const result = await loadServerData<OrgOptionsView>(API.ORGS.entitlements(orgId));
  return result.ok && Array.isArray(result.data?.switches) ? result.data : null;
}

/** The org's default language: a tag, `null` for none, or `undefined` when it could not be read. */
async function getOrgLocale(orgId: string): Promise<string | null | undefined> {
  const result = await loadServerData<{ settings?: { locale?: unknown } }>(API.ORGS.byId(orgId));
  if (!result.ok) return undefined;
  const locale = result.data?.settings?.locale;
  if (locale === null || typeof locale === 'string') return locale;
  return undefined;
}

export default async function OrgOptionsPage() {
  const [org, support, t] = await Promise.all([
    requestActingOrg(),
    requestSupportSession(),
    getTranslations('admin.orgOptions'),
  ]);
  const [options, orgLocale] = org
    ? await Promise.all([
        getOptions(org.id),
        support ? Promise.resolve(undefined) : getOrgLocale(org.id),
      ])
    : [null, undefined];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">
          {org ? t('titleFor', { org: org.name }) : t('title')}
        </h1>
        <p className="text-muted-foreground text-sm">{t('intro')}</p>
      </header>

      {!org ? (
        <p className="text-muted-foreground text-sm">{t('noOrg')}</p>
      ) : (
        <>
          <section className="space-y-3" aria-labelledby="org-language-heading">
            <div>
              <h2 id="org-language-heading" className="text-lg font-semibold">
                {t('language.title')}
              </h2>
              <p className="text-muted-foreground text-sm">{t('language.description')}</p>
            </div>
            {support ? (
              <p role="note" className="rounded-md border p-3 text-sm">
                {t('language.supportReadOnly')}
              </p>
            ) : orgLocale === undefined ? (
              <p role="alert" className="text-destructive text-sm">
                {t('language.loadFailed')}
              </p>
            ) : (
              <OrgLanguageForm orgId={org.id} locale={orgLocale} options={localeOptions()} />
            )}
          </section>

          {!options ? (
            <p role="alert" className="text-destructive text-sm">
              {t('loadFailed')}
            </p>
          ) : (
            <OrgOptionsForm orgId={org.id} options={options} />
          )}
        </>
      )}
    </div>
  );
}
