'use client';

/**
 * Each declared list: whether it is taking joins, how many people are in each
 * state, and where the confirmed ones came from (§125 t-976). Opening or
 * closing a list records who and when, and closing stops new joins only.
 */

import { useEffect, useState } from 'react';
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

export interface WaitlistListsPanelProps {
  lists: WaitlistListCountsView[];
}

function ListCard({ list }: { list: WaitlistListCountsView }) {
  // The counts come from the props, which the page re-reads after a change in
  // the table. The open state is the card's own while a toggle it sent is in
  // flight — a counts re-read that started before the toggle committed must
  // not undo what the admin just did — and follows the props otherwise.
  const [state, setState] = useState({ open: list.open, closedSince: list.closedSince });
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!saving) setState({ open: list.open, closedSince: list.closedSince });
    // `saving` is left out on purpose: when a toggle finishes, the card keeps
    // the answer it got rather than snapping back to older props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.open, list.closedSince]);
  // Closed by the config alone: no close date, so retention has no window to count.
  const unrecorded = !state.open && state.closedSince === null;
  // One failure per button, each shown beside the button that was pressed.
  const toggleSave = useSaveFailure({
    fallback: `Could not ${state.open ? 'close' : 'open'} the list. Try again.`,
    fields: NO_SERVER_FIELDS,
  });
  const recordSave = useSaveFailure({
    fallback: 'Could not record the close. Try again.',
    fields: NO_SERVER_FIELDS,
  });

  const send = async (open: boolean, save: typeof toggleSave) => {
    toggleSave.clear();
    recordSave.clear();
    setSaving(true);
    try {
      const result = await apiClient.patch<{ key: string; open: boolean; changedAt: string }>(
        API.ADMIN.waitlistList(list.key),
        { body: { open } }
      );
      setState({ open: result.open, closedSince: result.open ? null : result.changedAt });
    } catch (error) {
      save.report(error);
    } finally {
      setSaving(false);
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
          <Badge variant={state.open ? 'default' : 'secondary'}>
            {state.open ? 'Taking joins' : 'Closed'}
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
                onClick={() => void send(false, recordSave)}
                disabled={saving}
              >
                Mark closed
              </Button>
            </>
          )}
          <SaveError failure={toggleSave.failure} />
          <Button
            variant="outline"
            size="sm"
            onClick={() => void send(!state.open, toggleSave)}
            disabled={saving}
          >
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
            {state.open ? 'Close list' : 'Open list'}
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

export function WaitlistListsPanel({ lists }: WaitlistListsPanelProps) {
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
          <ListCard key={list.key} list={list} />
        ))}
      </div>
    </section>
  );
}
