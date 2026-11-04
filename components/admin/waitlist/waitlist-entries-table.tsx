'use client';

/**
 * The org's waitlist entries (§125 t-976): search, filter, sort, page, take
 * someone off the list or put them back, erase them, and export.
 *
 * Over `GET /api/v1/admin/waitlist`: one request per page, filter or sort,
 * never one per row. Three things Lelanea's first table got wrong, each held
 * by a test:
 *   • **Stale responses are dropped.** Only the latest request may write the
 *     rows, so a slow answer to an old search never replaces a newer one.
 *   • **A failed load never reads as empty.** It says it failed, and the
 *     table says "Nothing to show", not "No one has joined".
 *   • **Sorting is stable.** The server breaks ties by `id`.
 *
 * Restoring a removed entry asks first: a removed address that re-joined
 * shows "Re-submitted ×N", and restoring undoes someone's removal.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Download, Loader2 } from 'lucide-react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ClientDate } from '@/components/ui/client-date';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SaveError } from '@/components/forms/form-error';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import { useCommittedDialog } from '@/lib/hooks/use-committed-dialog';
import { NO_SERVER_FIELDS, useSaveFailure } from '@/lib/hooks/use-save-failure';
import { logger } from '@/lib/logging';
import { isRecord } from '@/lib/utils';
import { parsePaginationMeta } from '@/lib/validations/common';
import type { WaitlistFieldShape } from '@/lib/validations/waitlist';

/** One entry as the list endpoint returns it (dates as strings). */
export interface WaitlistEntryRow {
  id: string;
  email: string;
  name: string | null;
  list: string;
  details: unknown;
  source: string;
  utmSource: string | null;
  referrerHost: string | null;
  flaggedReason: string | null;
  confirmedAt: string | null;
  removedAt: string | null;
  rejoinRequests: number;
  invitedAt: string | null;
  joinedAt: string | null;
  createdAt: string;
}

export interface WaitlistPage {
  entries: WaitlistEntryRow[];
  total: number;
}

type SortField = 'createdAt' | 'email' | 'confirmedAt';

export interface WaitlistEntriesTableProps {
  lists: readonly string[];
  fields: readonly WaitlistFieldShape[];
  /** The first page, as the server rendered it (default filters, newest first); null if that read failed. */
  initial: WaitlistPage | null;
  /** The most rows one export carries (`WAITLIST_EXPORT_MAX_ROWS`). */
  exportMaxRows: number;
}

const ALL = '__all__';
const LIMIT = 25;
const LOAD_FAILED = 'The waitlist could not be loaded. Please try again.';

interface Filters {
  q: string;
  list: string;
  includeUnconfirmed: boolean;
  includeRemoved: boolean;
  includeJoined: boolean;
  flaggedOnly: boolean;
}

const DEFAULT_FILTERS: Filters = {
  q: '',
  list: ALL,
  includeUnconfirmed: false,
  includeRemoved: false,
  includeJoined: false,
  flaggedOnly: false,
};

/** The filters as query parameters, shared by the list and the export. */
export function filterParams(filters: Filters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.q.trim()) params.set('q', filters.q.trim());
  if (filters.list !== ALL) params.set('list', filters.list);
  if (filters.includeUnconfirmed) params.set('includeUnconfirmed', 'true');
  if (filters.includeRemoved) params.set('includeRemoved', 'true');
  if (filters.includeJoined) params.set('includeJoined', 'true');
  if (filters.flaggedOnly) params.set('flaggedOnly', 'true');
  return params;
}

/** The answers, as `label: value` for each declared field that has one. */
function answers(entry: WaitlistEntryRow, fields: readonly WaitlistFieldShape[]): string[] {
  const details = isRecord(entry.details) ? entry.details : {};
  return fields.flatMap((f) => {
    const value = details[f.key];
    if (typeof value !== 'string' || value === '') return [];
    const shown = f.options?.find((o) => o.value === value)?.label ?? value;
    return [`${f.label}: ${shown}`];
  });
}

function StateBadges({ entry }: { entry: WaitlistEntryRow }) {
  return (
    <div className="flex flex-wrap gap-1">
      {!entry.confirmedAt && <Badge variant="outline">Unconfirmed</Badge>}
      {entry.flaggedReason && <Badge variant="destructive">Flagged: {entry.flaggedReason}</Badge>}
      {entry.removedAt && <Badge variant="secondary">Removed</Badge>}
      {entry.removedAt && entry.rejoinRequests > 0 && (
        <Badge variant="outline">Re-submitted ×{entry.rejoinRequests}</Badge>
      )}
      {entry.invitedAt && !entry.joinedAt && <Badge variant="outline">Invited</Badge>}
      {entry.joinedAt && <Badge>Signed up</Badge>}
    </div>
  );
}

export function WaitlistEntriesTable({
  lists,
  fields,
  initial,
  exportMaxRows,
}: WaitlistEntriesTableProps) {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [searchText, setSearchText] = useState('');
  const [sortBy, setSortBy] = useState<SortField>('createdAt');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [entries, setEntries] = useState<WaitlistEntryRow[]>(initial?.entries ?? []);
  const [total, setTotal] = useState(initial?.total ?? 0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(initial ? null : LOAD_FAILED);
  const latestRequest = useRef(0);
  // The server rendered the default first page; fetch only once something changes.
  const skipFirstLoad = useRef(initial !== null);

  const [busyId, setBusyId] = useState<string | null>(null);
  const rowSave = useSaveFailure({
    fallback: 'Could not update the entry. Try again.',
    fields: NO_SERVER_FIELDS,
  });

  const [restoreTarget, setRestoreTarget] = useState<WaitlistEntryRow | null>(null);
  const [restoring, setRestoring] = useState(false);
  const restoreSave = useSaveFailure({
    fallback: 'Could not restore the entry. Try again.',
    fields: NO_SERVER_FIELDS,
  });

  const [eraseTarget, setEraseTarget] = useState<WaitlistEntryRow | null>(null);
  const [erasing, setErasing] = useState(false);
  const eraseSave = useSaveFailure({
    fallback: 'Could not erase the entry. Try again.',
    fields: NO_SERVER_FIELDS,
  });

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const load = useCallback(async () => {
    // Only the latest request may write the rows: an older one resolving late
    // would show one search's results under another's.
    const seq = ++latestRequest.current;
    const isCurrent = () => seq === latestRequest.current;
    const fail = (message: string) => {
      setError(message);
      setEntries([]);
      setTotal(0);
    };
    setLoading(true);
    setError(null);
    try {
      const params = filterParams(filters);
      params.set('page', String(page));
      params.set('limit', String(LIMIT));
      params.set('sortBy', sortBy);
      params.set('sortOrder', sortOrder);
      const res = await fetch(`${API.ADMIN.WAITLIST}?${params}`);
      if (!isCurrent()) return;
      if (!res.ok) {
        fail(LOAD_FAILED);
        return;
      }
      const body = await parseApiResponse<WaitlistEntryRow[]>(res);
      if (!isCurrent()) return;
      const meta = body.success ? parsePaginationMeta(body.meta) : null;
      if (!body.success || !Array.isArray(body.data) || !meta) {
        fail(LOAD_FAILED);
        return;
      }
      setEntries(body.data);
      setTotal(meta.total);
    } catch (err) {
      if (!isCurrent()) return;
      logger.error('waitlist entries fetch failed', err);
      fail(LOAD_FAILED);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [filters, page, sortBy, sortOrder]);

  useEffect(() => {
    if (skipFirstLoad.current) {
      skipFirstLoad.current = false;
      return;
    }
    void load();
  }, [load]);

  // Search waits for a pause in typing, so each keystroke is not a request.
  useEffect(() => {
    if (searchText === filters.q) return;
    const timer = setTimeout(() => {
      setFilters((f) => ({ ...f, q: searchText }));
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchText, filters.q]);

  const setFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
  };

  const sortOn = (field: SortField) => {
    if (sortBy === field) setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'));
    else {
      setSortBy(field);
      setSortOrder(field === 'email' ? 'asc' : 'desc');
    }
    setPage(1);
  };

  const setRemoved = async (entry: WaitlistEntryRow, removed: boolean): Promise<boolean> => {
    await apiClient.patch(API.ADMIN.waitlistEntry(entry.id), { body: { removed } });
    await load();
    return true;
  };

  const remove = async (entry: WaitlistEntryRow) => {
    rowSave.clear();
    setBusyId(entry.id);
    try {
      await setRemoved(entry, true);
    } catch (err) {
      rowSave.report(err);
    } finally {
      setBusyId(null);
    }
  };

  const handleRestore = async () => {
    if (!restoreTarget) return;
    restoreSave.clear();
    setRestoring(true);
    try {
      await setRemoved(restoreTarget, false);
      setRestoreTarget(null);
    } catch (err) {
      restoreSave.report(err);
    } finally {
      setRestoring(false);
    }
  };

  const handleErase = async () => {
    if (!eraseTarget) return;
    eraseSave.clear();
    setErasing(true);
    try {
      await apiClient.delete(API.ADMIN.waitlistEntry(eraseTarget.id));
      setEraseTarget(null);
      await load();
    } catch (err) {
      eraseSave.report(err);
    } finally {
      setErasing(false);
    }
  };

  const restoreDialog = useCommittedDialog({
    open: restoreTarget !== null,
    pending: restoring,
    onClose: () => setRestoreTarget(null),
    clear: restoreSave.clear,
  });
  const eraseDialog = useCommittedDialog({
    open: eraseTarget !== null,
    pending: erasing,
    onClose: () => setEraseTarget(null),
    clear: eraseSave.clear,
  });

  const exportCsv = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const res = await fetch(`${API.ADMIN.WAITLIST_EXPORT}?${filterParams(filters)}`);
      if (!res.ok) {
        setExportError(
          res.status === 429
            ? 'Too many exports just now. Try again in a minute.'
            : 'The export failed. Please try again.'
        );
        return;
      }
      const disposition = res.headers.get('Content-Disposition') ?? '';
      const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'waitlist.csv';
      const url = URL.createObjectURL(await res.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      logger.error('waitlist export failed', err);
      setExportError('The export failed. Please try again.');
    } finally {
      setExporting(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / LIMIT));
  const sortIcon = (field: SortField) =>
    sortBy !== field ? null : sortOrder === 'asc' ? (
      <ArrowUp className="ml-1 inline h-3 w-3" aria-hidden />
    ) : (
      <ArrowDown className="ml-1 inline h-3 w-3" aria-hidden />
    );
  const toggles: Array<[key: keyof Filters, label: string, help: string]> = [
    [
      'includeUnconfirmed',
      'Show unconfirmed',
      'People who have not clicked the link in their confirmation email. Anyone can type any address into the form, so these are hidden by default and never invited.',
    ],
    [
      'includeRemoved',
      'Show removed',
      'People taken off the list. Their row is kept so a re-join stays removed; erase them to delete it.',
    ],
    [
      'includeJoined',
      'Show signed up',
      'People who have created an account from their invitation.',
    ],
    [
      'flaggedOnly',
      'Flagged only',
      'Only entries the app’s screening check flagged for review — a throwaway domain, say. A flag is a reason to look, not proof of abuse.',
    ],
  ];

  return (
    <section className="space-y-3" aria-labelledby="waitlist-entries-heading">
      <h2 id="waitlist-entries-heading" className="text-lg font-semibold">
        People
      </h2>

      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1">
          <Label htmlFor="waitlist-search" className="flex items-center gap-1">
            Search
            <FieldHelp title="Search">
              Matches the address, the name, or any of the form&apos;s answers. The address is
              matched as you type it; answers are matched exactly as written.
            </FieldHelp>
          </Label>
          <Input
            id="waitlist-search"
            className="w-64"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="Address, name or answer"
          />
        </div>
        {lists.length > 1 && (
          <div className="space-y-1">
            <Label htmlFor="waitlist-list-filter" className="flex items-center gap-1">
              List
              <FieldHelp title="List">Show one list, or every list the app declares.</FieldHelp>
            </Label>
            <Select value={filters.list} onValueChange={(v) => setFilter('list', v)}>
              <SelectTrigger id="waitlist-list-filter" className="w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All lists</SelectItem>
                {lists.map((key) => (
                  <SelectItem key={key} value={key}>
                    {key}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {toggles.map(([key, label, help]) => (
          <div key={key} className="flex items-center gap-2 pb-2">
            <Checkbox
              id={`waitlist-${key}`}
              checked={filters[key] === true}
              onCheckedChange={(checked) => setFilter(key, checked === true)}
            />
            <Label htmlFor={`waitlist-${key}`} className="flex items-center gap-1">
              {label}
              <FieldHelp title={label}>{help}</FieldHelp>
            </Label>
          </div>
        ))}
        <div className="ml-auto flex items-center gap-2 pb-1">
          <span className="text-muted-foreground text-xs">
            Up to {exportMaxRows.toLocaleString()} rows, with these filters
          </span>
          <Button variant="outline" size="sm" onClick={() => void exportCsv()} disabled={exporting}>
            {exporting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Download className="mr-2 h-4 w-4" aria-hidden />
            )}
            Export CSV
          </Button>
        </div>
      </div>

      {exportError && (
        <p role="alert" className="text-destructive text-sm">
          {exportError}
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <SaveError failure={rowSave.failure} />

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <button type="button" onClick={() => sortOn('email')}>
                  Address{sortIcon('email')}
                </button>
              </TableHead>
              <TableHead>Name</TableHead>
              {lists.length > 1 && <TableHead>List</TableHead>}
              <TableHead>Answers</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>
                <button type="button" onClick={() => sortOn('createdAt')}>
                  Joined{sortIcon('createdAt')}
                </button>
              </TableHead>
              <TableHead>
                <button type="button" onClick={() => sortOn('confirmedAt')}>
                  Confirmed{sortIcon('confirmedAt')}
                </button>
              </TableHead>
              <TableHead>State</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={lists.length > 1 ? 9 : 8}
                  className="text-muted-foreground py-8 text-center"
                >
                  {loading ? 'Loading…' : error ? 'Nothing to show.' : 'No one matches.'}
                </TableCell>
              </TableRow>
            ) : (
              entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="font-mono text-xs">{entry.email}</TableCell>
                  <TableCell>{entry.name ?? '—'}</TableCell>
                  {lists.length > 1 && <TableCell>{entry.list}</TableCell>}
                  <TableCell className="max-w-xs text-xs">
                    {answers(entry, fields).map((line) => (
                      <div key={line} className="truncate" title={line}>
                        {line}
                      </div>
                    ))}
                  </TableCell>
                  <TableCell className="text-xs">{entry.utmSource ?? entry.source}</TableCell>
                  <TableCell>
                    <ClientDate date={entry.createdAt} />
                  </TableCell>
                  <TableCell>
                    {entry.confirmedAt ? <ClientDate date={entry.confirmedAt} /> : '—'}
                  </TableCell>
                  <TableCell>
                    <StateBadges entry={entry} />
                  </TableCell>
                  <TableCell className="space-x-2 text-right whitespace-nowrap">
                    {entry.removedAt ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setRestoreTarget(entry)}
                        disabled={busyId === entry.id}
                      >
                        Restore
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void remove(entry)}
                        disabled={busyId === entry.id}
                      >
                        Remove
                      </Button>
                    )}
                    <Button variant="destructive" size="sm" onClick={() => setEraseTarget(entry)}>
                      Erase
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          {total.toLocaleString()} {total === 1 ? 'person' : 'people'}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => p - 1)}
            disabled={page <= 1 || loading}
            aria-label="Previous page"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span>
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => p + 1)}
            disabled={page >= totalPages || loading}
            aria-label="Next page"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <AlertDialog open={restoreTarget !== null} onOpenChange={restoreDialog.onOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore this person?</AlertDialogTitle>
            <AlertDialogDescription>
              They were taken off the list
              {restoreTarget && restoreTarget.rejoinRequests > 0
                ? `, and have tried to join again ${restoreTarget.rejoinRequests} time${
                    restoreTarget.rejoinRequests === 1 ? '' : 's'
                  } since`
                : ''}
              . Restoring puts them back on it, where they can be invited.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <SaveError failure={restoreSave.failure} />
          <AlertDialogFooter>
            <AlertDialogCancel {...restoreDialog.cancelProps}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              {...restoreDialog.actionProps()}
              onClick={(e) => restoreDialog.confirm(e, handleRestore)}
            >
              {restoring ? 'Restoring…' : 'Restore'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={eraseTarget !== null} onOpenChange={eraseDialog.onOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Erase this person?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes their entry and answers for good, and any invitation this organisation
              has sent them that they have not used. A receipt records that they were erased,
              without their address. Use it to honour an erasure request; to take someone off the
              list but keep the record, use Remove.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <SaveError failure={eraseSave.failure} />
          <AlertDialogFooter>
            <AlertDialogCancel {...eraseDialog.cancelProps}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              {...eraseDialog.actionProps()}
              onClick={(e) => eraseDialog.confirm(e, handleErase)}
              className="bg-red-600 hover:bg-red-700"
            >
              {erasing ? 'Erasing…' : 'Erase'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
