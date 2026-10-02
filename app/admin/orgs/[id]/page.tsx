import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  OrgProvidersForm,
  type OrgProviderOption,
  type OrgProviderPolicyView,
} from '@/components/admin/orgs/org-providers-form';
import { Badge } from '@/components/ui/badge';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
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

async function fetchData<T>(path: string, what: string): Promise<T | null> {
  try {
    const res = await serverFetch(path);
    if (!res.ok) return null;
    const body = await parseApiResponse<T>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error(`org page: ${what} fetch failed`, err, { path });
    return null;
  }
}

/**
 * The org, or `null` when there is no such org. Any other failure throws to
 * the admin error boundary: a database blip is not "this organisation does
 * not exist".
 */
async function getOrg(id: string): Promise<OrgDetail | null> {
  const res = await serverFetch(API.ADMIN.orgById(id));
  // 400 is an id that cannot name an org (it fails the id schema).
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error(`Organisation could not be loaded (HTTP ${res.status})`);
  const body = await parseApiResponse<OrgDetail>(res);
  if (!body.success) throw new Error('Organisation could not be loaded');
  return body.data;
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
    try {
      const res = await serverFetch(
        `${API.ADMIN.ORCHESTRATION.PROVIDERS}?page=${page}&limit=${PROVIDER_PAGE}`
      );
      if (!res.ok) return null;
      const body = await parseApiResponse<OrgProviderOption[]>(res);
      if (!body.success) return null;
      for (const provider of body.data) {
        // Offset pages over a live table: a provider created between two
        // requests shifts a row onto the next page as well.
        if (!all.some((seen) => seen.id === provider.id)) all.push(provider);
      }
      // Without the page count there is no telling whether this is all of it.
      const meta = parsePaginationMeta(body.meta);
      if (!meta) return null;
      if (page >= meta.totalPages || body.data.length === 0) return all;
    } catch (err) {
      logger.error('org page: providers fetch failed', err, { page });
      return null;
    }
  }
}

/**
 * Admin — one organisation (§120 t-745).
 *
 * Server shell: the org (`GET /api/v1/admin/orgs/[id]`), its provider policy
 * (`GET …/providers`) and the provider list, in parallel. Only the approved
 * providers are editable here; rename, suspend and members stay API-only. A
 * missing org is a 404, and any other failure to load it goes to the error
 * boundary. A policy or provider fetch that fails says so in place of the
 * form, rather than offering a partial set to save over the real one.
 */
export default async function OrgPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [org, policy, providers] = await Promise.all([
    getOrg(id),
    fetchData<OrgProviderPolicyView>(API.ADMIN.orgProviders(id), 'provider policy'),
    getAllProviders(),
  ]);

  if (!org) notFound();

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
