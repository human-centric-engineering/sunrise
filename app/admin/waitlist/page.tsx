import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import {
  WaitlistEntriesTable,
  type WaitlistEntryRow,
} from '@/components/admin/waitlist/waitlist-entries-table';
import {
  WaitlistListsPanel,
  type WaitlistListCountsView,
} from '@/components/admin/waitlist/waitlist-lists-panel';
import { API } from '@/lib/api/endpoints';
import { loadServerData } from '@/lib/api/server-load';
import { parsePaginationMeta } from '@/lib/validations/common';
import { WAITLIST_EXPORT_MAX_ROWS, type WaitlistFieldShape } from '@/lib/validations/waitlist';
import { isWaitlistEnabled } from '@/lib/waitlist/config';

export const metadata: Metadata = {
  title: 'Waitlist',
  description: 'The people waiting to be let in, and whether each list is taking joins.',
};

/**
 * Admin — the org's waitlist (§125 t-976).
 *
 * Org-tier: an org OWNER/ADMIN sees their org's list; a platform admin sees
 * the list of the org they are in. A thin shell over the admin waitlist API:
 * the counts and the first page are server-rendered through it, and the
 * table pages, filters and acts through it too. A read that fails says so in
 * its place, never as an empty list. With the app's waitlist config empty
 * the page does not exist, as its routes answer 404.
 */
export default async function WaitlistAdminPage() {
  if (!isWaitlistEnabled()) notFound();

  const [counts, firstPage] = await Promise.all([
    loadServerData<{ lists: WaitlistListCountsView[]; fields: WaitlistFieldShape[] }>(
      API.ADMIN.WAITLIST_COUNTS
    ),
    loadServerData<WaitlistEntryRow[]>(
      `${API.ADMIN.WAITLIST}?page=1&limit=25&sortBy=createdAt&sortOrder=desc`
    ),
  ]);

  const lists = counts.ok && Array.isArray(counts.data?.lists) ? counts.data.lists : null;
  const fields = counts.ok && Array.isArray(counts.data?.fields) ? counts.data.fields : [];
  const meta = firstPage.ok ? parsePaginationMeta(firstPage.meta) : null;
  const initial =
    firstPage.ok && Array.isArray(firstPage.data) && meta
      ? { entries: firstPage.data, total: meta.total }
      : null;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Waitlist</h1>
        <p className="text-muted-foreground text-sm">
          The people waiting to be let in. Only confirmed entries are shown and counted unless you
          ask for the others.
        </p>
      </header>

      {lists ? (
        <WaitlistListsPanel lists={lists} />
      ) : (
        <p role="alert" className="text-destructive text-sm">
          The waitlist&apos;s lists could not be loaded.
        </p>
      )}

      <WaitlistEntriesTable
        lists={lists?.map((l) => l.key) ?? []}
        fields={fields}
        initial={initial}
        exportMaxRows={WAITLIST_EXPORT_MAX_ROWS}
      />
    </div>
  );
}
