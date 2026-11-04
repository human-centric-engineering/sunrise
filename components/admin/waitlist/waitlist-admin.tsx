'use client';

/**
 * The admin waitlist page's client half (§125 t-976): the lists with their
 * counts, and the people. A remove, restore or erase in the table re-reads the
 * counts, so the numbers an admin plans an invite wave from follow what they
 * just did. A failed re-read keeps the last counts and says they may be out
 * of date, rather than showing none.
 */

import { useCallback, useRef, useState } from 'react';

import {
  WaitlistEntriesTable,
  type WaitlistPage,
} from '@/components/admin/waitlist/waitlist-entries-table';
import {
  WaitlistListsPanel,
  type WaitlistListCountsView,
} from '@/components/admin/waitlist/waitlist-lists-panel';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import { logger } from '@/lib/logging';
import type { WaitlistFieldShape } from '@/lib/validations/waitlist';

export interface WaitlistAdminProps {
  /** Each list's counts as the server rendered them; null if that read failed. */
  lists: WaitlistListCountsView[] | null;
  fields: readonly WaitlistFieldShape[];
  initial: WaitlistPage | null;
  exportMaxRows: number;
}

export function WaitlistAdmin({
  lists: initialLists,
  fields,
  initial,
  exportMaxRows,
}: WaitlistAdminProps) {
  const [lists, setLists] = useState(initialLists);
  // Bumped on each fresh read, so each list card starts from the new counts.
  const [version, setVersion] = useState(0);
  const [stale, setStale] = useState(false);
  const latest = useRef(0);

  const refreshCounts = useCallback(async () => {
    const seq = ++latest.current;
    try {
      const res = await fetch(API.ADMIN.WAITLIST_COUNTS);
      const body = res.ok ? await parseApiResponse<{ lists: WaitlistListCountsView[] }>(res) : null;
      if (seq !== latest.current) return;
      if (!body?.success || !Array.isArray(body.data?.lists)) {
        setStale(true);
        return;
      }
      setLists(body.data.lists);
      setVersion((v) => v + 1);
      setStale(false);
    } catch (err) {
      if (seq !== latest.current) return;
      logger.error('waitlist counts refresh failed', err);
      setStale(true);
    }
  }, []);

  return (
    <>
      {lists ? (
        <>
          <WaitlistListsPanel key={version} lists={lists} />
          {stale && (
            <p role="status" className="text-muted-foreground text-sm">
              The counts could not be refreshed and may be out of date.
            </p>
          )}
        </>
      ) : (
        <p role="alert" className="text-destructive text-sm">
          The waitlist&apos;s lists could not be loaded.
        </p>
      )}

      <WaitlistEntriesTable
        lists={lists?.map((l) => l.key) ?? []}
        fields={fields}
        initial={initial}
        exportMaxRows={exportMaxRows}
        onChanged={() => void refreshCounts()}
      />
    </>
  );
}
