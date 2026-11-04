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

function ListCard({ initial }: { initial: WaitlistListCountsView }) {
  const [list, setList] = useState(initial);
  const [saving, setSaving] = useState(false);
  const save = useSaveFailure({
    fallback: `Could not ${list.open ? 'close' : 'open'} the list. Try again.`,
    fields: NO_SERVER_FIELDS,
  });

  const toggle = async () => {
    save.clear();
    setSaving(true);
    try {
      const state = await apiClient.patch<{ key: string; open: boolean }>(
        API.ADMIN.waitlistList(list.key),
        { body: { open: !list.open } }
      );
      setList((current) => ({ ...current, open: state.open }));
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
          <SaveError failure={save.failure} />
          <Button variant="outline" size="sm" onClick={() => void toggle()} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
            {list.open ? 'Close list' : 'Open list'}
          </Button>
        </div>
      </div>
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
          <ListCard key={list.key} initial={list} />
        ))}
      </div>
    </section>
  );
}
