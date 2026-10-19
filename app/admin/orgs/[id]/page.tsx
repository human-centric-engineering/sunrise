import type { Metadata } from 'next';
import Link from 'next/link';

import {
  OrgProvidersForm,
  type OrgProviderOption,
  type OrgProviderPolicyView,
} from '@/components/admin/orgs/org-providers-form';
import { OrgUsageSummary } from '@/components/admin/orgs/org-usage-summary';
import { Badge } from '@/components/ui/badge';
import { API } from '@/lib/api/endpoints';
import { loadServerData, requireServerData } from '@/lib/api/server-load';
import { logger } from '@/lib/logging';
import type { OrgUsageReport } from '@/lib/orchestration/llm/cost-reports';
import { parsePaginationMeta } from '@/lib/validations/common';

export const metadata: Metadata = {
  title: 'Organisation',
  description: 'One organisation, and the providers it may use.',
};

interface OrgDetail {
  id: string;
  slug: string;
  name: string;
  status: string;
  members: { id: string }[];
}

/** The loaded value, or `null` when the load failed (`loadServerData` logs it). */
async function loadOrNull<T>(path: string): Promise<T | null> {
  const result = await loadServerData<T>(path);
  return result.ok ? result.data : null;
}

/**
 * The org. A missing org renders the not-found page; any other failure throws
 * to the admin error boundary: a database blip is not "this organisation does
 * not exist".
 */
async function getOrg(id: string): Promise<OrgDetail> {
  const { data } = await requireServerData<OrgDetail>(API.ADMIN.orgById(id), { notFound: true });
  return data;
}

/**
 * This org's usage this month, from the per-org usage endpoint narrowed to
 * it. `'refused'` when the endpoint refuses the caller: at `multi` only the
 * install org may see what an org has spent, so the 403 is an expected answer
 * and is not logged. `null` when it could not be loaded, which is.
 */
async function getOrgUsage(id: string): Promise<OrgUsageReport | 'refused' | null> {
  const result = await loadServerData<OrgUsageReport>(
    `${API.ADMIN.ORCHESTRATION.COSTS_ORGS}?orgId=${encodeURIComponent(id)}`,
    { expected: [403] }
  );
  if (result.ok) return result.data;
  return result.failure.kind === 'failed' && result.failure.status === 403 ? 'refused' : null;
}

/** The most providers the list endpoint returns per page. */
const PROVIDER_PAGE = 100;

/**
 * Every provider, across pages: a provider the form does not list can be
 * neither granted nor revoked, so one page is not enough. `null` if any page
 * fails, so the form is not offered over a partial list.
 */
async function getAllProviders(): Promise<OrgProviderOption[] | null> {
  const all: OrgProviderOption[] = [];
  for (let page = 1; ; page++) {
    const result = await loadServerData<OrgProviderOption[]>(
      `${API.ADMIN.ORCHESTRATION.PROVIDERS}?page=${page}&limit=${PROVIDER_PAGE}`
    );
    if (!result.ok) return null;
    for (const provider of result.data) {
      // Offset pages over a live table: a provider created between two
      // requests shifts a row onto the next page as well.
      if (!all.some((seen) => seen.id === provider.id)) all.push(provider);
    }
    // Without the page count there is no telling whether this is all of it.
    const meta = parsePaginationMeta(result.meta);
    if (!meta) {
      logger.error('org page: provider list has no pagination meta', undefined, { page });
      return null;
    }
    if (page >= meta.totalPages || result.data.length === 0) return all;
  }
}

/**
 * Admin — one organisation (§120 t-745).
 *
 * Server shell: the org (`GET /api/v1/admin/orgs/[id]`), its provider policy
 * (`GET …/providers`), the provider list and its usage this month against
 * its cap (`GET /api/v1/admin/orchestration/costs/orgs?orgId=`), in parallel. Only the approved
 * providers are editable here; rename, suspend and members stay API-only. A
 * missing org is a 404, and any other failure to load it goes to the error
 * boundary. A policy or provider fetch that fails says so in place of the
 * form, rather than offering a partial set to save over the real one.
 */
export default async function OrgPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [org, policy, providers, usage] = await Promise.all([
    getOrg(id),
    loadOrNull<OrgProviderPolicyView>(API.ADMIN.orgProviders(id)),
    getAllProviders(),
    getOrgUsage(id),
  ]);

  return (
    <div className="space-y-6">
      <nav className="text-muted-foreground text-xs">
        <Link href="/admin/orgs" className="hover:underline">
          Organisations
        </Link>
        {' / '}
        <span>{org.name}</span>
      </nav>

      <header>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          {org.name}
          <Badge
            variant={org.status === 'ACTIVE' ? 'outline' : 'destructive'}
            className="px-1.5 py-0 text-[10px]"
          >
            {org.status.toLowerCase()}
          </Badge>
        </h1>
        <p className="text-muted-foreground text-sm">
          <span className="font-mono">{org.slug}</span> · {org.members.length} member
          {org.members.length === 1 ? '' : 's'}
        </p>
      </header>

      <section className="space-y-3 rounded-md border p-4">
        <h2 className="text-lg font-medium">AI usage this month</h2>
        {usage === 'refused' ? (
          <p className="text-muted-foreground text-sm">
            Usage can only be viewed from the install organisation.
          </p>
        ) : usage && usage.orgs[0] ? (
          <OrgUsageSummary period={usage.period} row={usage.orgs[0]} />
        ) : (
          <p className="text-destructive text-sm">
            This month&apos;s usage could not be loaded. Reload the page to try again.
          </p>
        )}
      </section>

      <section className="space-y-3 rounded-md border p-4">
        <h2 className="text-lg font-medium">Approved providers</h2>
        {policy && providers ? (
          <OrgProvidersForm orgId={org.id} policy={policy} providers={providers} />
        ) : (
          <p className="text-destructive text-sm">
            The approved providers could not be loaded. Reload the page to try again.
          </p>
        )}
      </section>
    </div>
  );
}
