'use client';

/**
 * Each declared list: whether it is taking joins, how many people are in each
 * state, and where the confirmed ones came from (§125 t-976). Opening or
 * closing a list records who and when, and closing stops new joins only.
 */

import { useState } from 'react';
import { Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { SaveError } from '@/components/forms/form-error';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { NO_SERVER_FIELDS, useSaveFailure } from '@/lib/hooks/use-save-failure';

/** One list as `GET /api/v1/admin/waitlist/counts` returns it. */
export interface WaitlistListCountsView {
  key: string;
  open: boolean;
  /** When an admin closed it (ISO), or null: open, or closed only by the config. */
  closedSince: string | null;
  confirmed: number;
  unconfirmed: number;
  flagged: number;
  removed: number;
  invited: number;
  joined: number;
  bySource: Array<{ source: string; count: number }>;
}

/** A list's open state as a toggle's answer gives it. */
export interface WaitlistListStateChange {
  open: boolean;
  closedSince: string | null;
}

export interface WaitlistListsPanelProps {
  lists: WaitlistListCountsView[];
  /**
   * A toggle succeeded: the page records its answer in `lists` and re-reads
   * the counts. The panel holds no copy of the lists' state; it draws what
   * it is given, so a counts re-read can never disagree with what it shows.
   */
  onListChange: (key: string, change: WaitlistListStateChange) => void;
}

type Pending = 'toggle' | 'record' | null;

function ListCard({
  list,
  onListChange,
}: {
  list: WaitlistListCountsView;
  onListChange: WaitlistListsPanelProps['onListChange'];
}) {
  const [pending, setPending] = useState<Pending>(null);
  // Closed by the config alone: no close date, so retention has no window to count.
  const unrecorded = !list.open && list.closedSince === null;
  // One failure per button, each shown beside the button that was pressed.
  const toggleSave = useSaveFailure({
    fallback: `Could not ${list.open ? 'close' : 'open'} the list. Try again.`,
    fields: NO_SERVER_FIELDS,
  });
  const recordSave = useSaveFailure({
    fallback: 'Could not record the close. Try again.',
    fields: NO_SERVER_FIELDS,
  });

  const send = async (open: boolean, which: Exclude<Pending, null>) => {
    toggleSave.clear();
    recordSave.clear();
    setPending(which);
    try {
      const result = await apiClient.patch<{ key: string; open: boolean; changedAt: string }>(
        API.ADMIN.waitlistList(list.key),
        { body: { open } }
      );
      onListChange(list.key, {
        open: result.open,
        closedSince: result.open ? null : result.changedAt,
      });
    } catch (error) {
      (which === 'record' ? recordSave : toggleSave).report(error);
    } finally {
      setPending(null);
    }
  };

  const states: Array<[label: string, count: number]> = [
    ['Confirmed', list.confirmed],
    ['Unconfirmed', list.unconfirmed],
    ['Flagged', list.flagged],
    ['Invited', list.invited],
    ['Signed up', list.joined],
    ['Removed', list.removed],
  ];

  return (
    <div className="space-y-3 rounded-md border p-4" data-testid={`waitlist-list-${list.key}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h3 className="font-medium">{list.key}</h3>
          <Badge variant={list.open ? 'default' : 'secondary'}>
            {list.open ? 'Taking joins' : 'Closed'}
          </Badge>
          <FieldHelp title="Opening and closing a list">
            Closing a list stops new joins and nothing else: people can still confirm, leave and be
            invited, and you can still export and erase. Each change records who made it. A list
            starts open unless the app declares it closed.
          </FieldHelp>
        </div>
        <div className="flex items-center gap-2">
          {unrecorded && (
            <>
              <SaveError failure={recordSave.failure} />
              <Button
                variant="outline"
                size="sm"
                onClick={() => void send(false, 'record')}
                disabled={pending !== null}
              >
                {pending === 'record' && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                )}
                Mark closed
              </Button>
            </>
          )}
          <SaveError failure={toggleSave.failure} />
          <Button
            variant="outline"
            size="sm"
            onClick={() => void send(!list.open, 'toggle')}
            disabled={pending !== null}
          >
            {pending === 'toggle' && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
            {list.open ? 'Close list' : 'Open list'}
          </Button>
        </div>
      </div>
      {unrecorded && (
        <p className="text-muted-foreground text-sm">
          Closed by the app&apos;s settings, with no close date recorded, so its entries are kept
          until one is. Mark closed records today: confirmed entries are then deleted the app&apos;s
          retention window after it.
        </p>
      )}
      <dl className="grid grid-cols-3 gap-2 text-sm sm:grid-cols-6">
        {states.map(([label, count]) => (
          <div key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-medium tabular-nums">{count}</dd>
          </div>
        ))}
      </dl>
      {list.bySource.length > 0 && (
        <p className="text-muted-foreground text-sm">
          Confirmed by source: {list.bySource.map((s) => `${s.source} ${s.count}`).join(' · ')}
        </p>
      )}
    </div>
  );
}

export function WaitlistListsPanel({ lists, onListChange }: WaitlistListsPanelProps) {
  return (
    <section className="space-y-3" aria-labelledby="waitlist-lists-heading">
      <div className="flex items-center gap-1">
        <h2 id="waitlist-lists-heading" className="text-lg font-semibold">
          Lists
        </h2>
        <FieldHelp title="What the counts mean">
          Confirmed people have clicked the link in their confirmation email and are the ones an
          invite draws from. Unconfirmed and flagged entries are counted on their own and never
          inside Confirmed. Flagged entries were marked by the app&apos;s screening check.
        </FieldHelp>
      </div>
      <div className="space-y-3">
        {lists.map((list) => (
          <ListCard key={list.key} list={list} onListChange={onListChange} />
        ))}
      </div>
    </section>
  );
}
