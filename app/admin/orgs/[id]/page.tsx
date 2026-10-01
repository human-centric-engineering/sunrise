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
 * Admin — one organisation (§120 t-745).
 *
 * Server shell: the org (`GET /api/v1/admin/orgs/[id]`), its provider policy
 * (`GET …/providers`) and the provider list, in parallel. Only the approved
 * providers are editable here; rename, suspend and members stay API-only. A
 * missing org is a 404; a policy or provider fetch that fails says so in
 * place of the form, rather than offering an empty set to save over the real
 * one.
 */
export default async function OrgPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [org, policy, providers] = await Promise.all([
    fetchData<OrgDetail>(API.ADMIN.orgById(id), 'org'),
    fetchData<OrgProviderPolicyView>(API.ADMIN.orgProviders(id), 'provider policy'),
    fetchData<OrgProviderOption[]>(
      `${API.ADMIN.ORCHESTRATION.PROVIDERS}?page=1&limit=100`,
      'providers'
    ),
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
