'use client';

/**
 * The admin waitlist page's client half (§125 t-976): the lists with their
 * counts, and the people. It owns the lists' state — the panel draws what it
 * is given — so there is one copy to keep right. A remove, restore or erase in
 * the table, and a list's open or close, re-read the counts, and only the
 * latest read lands. A failed re-read keeps the last counts and says they may
 * be out of date, rather than showing none.
 */

import { useCallback, useRef, useState } from 'react';

import {
  WaitlistEntriesTable,
  type WaitlistPage,
} from '@/components/admin/waitlist/waitlist-entries-table';
import {
  WaitlistListsPanel,
  type WaitlistListCountsView,
  type WaitlistListStateChange,
} from '@/components/admin/waitlist/waitlist-lists-panel';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
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
  const [stale, setStale] = useState(false);
  const latest = useRef(0);

  const refreshCounts = useCallback(async () => {
    const seq = ++latest.current;
    try {
      const data = await apiClient.get<{ lists: WaitlistListCountsView[] }>(
        API.ADMIN.WAITLIST_COUNTS
      );
      if (seq !== latest.current) return;
      if (!Array.isArray(data?.lists)) {
        setStale(true);
        return;
      }
      // Only the latest read lands (the seq check above).
      setLists(data.lists);
      setStale(false);
    } catch (err) {
      if (seq !== latest.current) return;
      logger.error('waitlist counts refresh failed', err);
      setStale(true);
    }
  }, []);

  // A toggle's answer is the newest word on that list: record it, and re-read
  // the counts behind it. Starting the re-read drops any read already in
  // flight (its seq is no longer the latest), which may predate the toggle
  // and say the opposite.
  const onListChange = useCallback(
    (key: string, change: WaitlistListStateChange) => {
      setLists((current) =>
        current ? current.map((l) => (l.key === key ? { ...l, ...change } : l)) : current
      );
      void refreshCounts();
    },
    [refreshCounts]
  );

  return (
    <>
      {lists ? (
        <>
          <WaitlistListsPanel lists={lists} onListChange={onListChange} />
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
