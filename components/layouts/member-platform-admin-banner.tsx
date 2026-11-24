'use client';

/**
 * Member platform admin banner (t-1032)
 *
 * Shown, in the admin console and the account area, to a platform admin
 * acting in a customer org as a member there. Outside the install org they
 * are presented as their org role alone (`lib/auth/support-principal.ts`), so
 * platform-only pages refuse them, and as an org MEMBER the console is closed
 * to them entirely. This says where they are and as what, and switches them
 * back to the install org, where the platform role is theirs again.
 *
 * The switch route does not enter the current org, and it reads the
 * session's own platform role, so it works from here. A full page load
 * follows, because the admin layout re-checks who is viewing only on one.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Building2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import type { MemberPlatformAdminView } from '@/lib/auth/admin-page-viewer';

export function MemberPlatformAdminBanner({ view }: { view: MemberPlatformAdminView }) {
  const t = useTranslations('layout.memberPlatformAdmin');
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const orgName = view.orgName ?? t('thisOrg');
  const installOrgName = view.installOrgName ?? t('installOrg');

  async function switchToInstallOrg() {
    setSwitching(true);
    setError(null);
    try {
      await apiClient.post(API.ORGS.SWITCH, { body: { orgId: INSTALL_ORG_ID } });
      window.location.assign('/admin');
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : t('failed'));
      setSwitching(false);
    }
  }

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 border-b border-sky-300 bg-sky-50 px-6 py-2 text-sm text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100"
    >
      <Building2 className="h-4 w-4 shrink-0" aria-hidden="true" />
      <p className="flex-1">
        {t.rich('message', {
          org: orgName,
          role: view.orgRole,
          installOrg: installOrgName,
          strong: (chunks) => <strong>{chunks}</strong>,
        })}
      </p>
      {error && <p className="text-xs">{error}</p>}
      {view.viaResolver ? (
        // This address picks the org, so switching cannot leave it.
        <p className="text-xs">{t('viaResolver', { installOrg: installOrgName })}</p>
      ) : (
        <Button
          size="sm"
          variant="outline"
          onClick={() => void switchToInstallOrg()}
          disabled={switching}
        >
          {switching ? t('switching') : t('switch', { installOrg: installOrgName })}
        </Button>
      )}
    </div>
  );
}
