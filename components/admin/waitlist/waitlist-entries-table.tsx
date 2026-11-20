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
 *
 * Inviting (t-978): a row that can be invited has Invite (Resend once it has
 * been); ticked rows go as one wave; "Invite a wave" picks the next N or a
 * random N. Only a confirmed, unflagged entry still on the list can be ticked
 * or invited — the server refuses the rest anyway, and says why.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Download, Loader2 } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';

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
import {
  postWave,
  WaitlistInviteWaveDialog,
  WaveSummary,
  type WaveResult,
} from '@/components/admin/waitlist/waitlist-invite-wave-dialog';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import { useCommittedDialog } from '@/lib/hooks/use-committed-dialog';
import { NO_SERVER_FIELDS, useSaveFailure } from '@/lib/hooks/use-save-failure';
import { logger } from '@/lib/logging';
import { isRecord } from '@/lib/utils';
import { parsePaginationMeta } from '@/lib/validations/common';
import {
  WAITLIST_ADMIN_DEFAULT_SORT,
  WAITLIST_ADMIN_PAGE_SIZE,
  WAITLIST_INVITE_WAVE_MAX,
  type WaitlistFieldShape,
} from '@/lib/validations/waitlist';
import { entryStateRefusal } from '@/lib/waitlist/invite-refusals';

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
  /** Called after a remove, restore, erase or invite succeeded, so the counts can follow. */
  onChanged?: () => void;
}

const ALL = '__all__';
const LIMIT = WAITLIST_ADMIN_PAGE_SIZE;

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

/** The answers, a `[question, answer]` pair for each declared field that has one. */
function answers(
  entry: WaitlistEntryRow,
  fields: readonly WaitlistFieldShape[]
): Array<[question: string, answer: string]> {
  const details = isRecord(entry.details) ? entry.details : {};
  return fields.flatMap((f): Array<[string, string]> => {
    const value = details[f.key];
    if (typeof value !== 'string' || value === '') return [];
    const shown = f.options?.find((o) => o.value === value)?.label ?? value;
    return [[f.label, shown]];
  });
}

/**
 * Whether the server would invite this entry, by its own state — the server's
 * rule (`entryStateRefusal()`), not a copy. What only the server can see (an
 * account or someone else's invitation for the address) is its refusal.
 */
export function canInvite(entry: WaitlistEntryRow): boolean {
  return entryStateRefusal(entry) === null;
}

/** Which line a single invite's answer calls for, by its key in `admin.waitlist.entries.notice`. */
function inviteNoticeKey(
  outcome: string,
  emailStatus: string
): 'sent' | 'resent' | 'createdNoEmail' | 'createdEmailOff' | 'renewedNoEmail' | 'renewedEmailOff' {
  const resent = outcome === 'resent';
  if (emailStatus === 'sent') return resent ? 'resent' : 'sent';
  if (emailStatus === 'disabled') return resent ? 'renewedEmailOff' : 'createdEmailOff';
  return resent ? 'renewedNoEmail' : 'createdNoEmail';
}

function StateBadges({ entry }: { entry: WaitlistEntryRow }) {
  const t = useTranslations('admin.waitlist.entries.badges');
  return (
    <div className="flex flex-wrap gap-1">
      {!entry.confirmedAt && <Badge variant="outline">{t('unconfirmed')}</Badge>}
      {entry.flaggedReason && (
        <Badge variant="destructive">{t('flagged', { reason: entry.flaggedReason })}</Badge>
      )}
      {entry.removedAt && <Badge variant="secondary">{t('removed')}</Badge>}
      {entry.removedAt && entry.rejoinRequests > 0 && (
        <Badge variant="outline">{t('resubmitted', { count: entry.rejoinRequests })}</Badge>
      )}
      {entry.invitedAt && !entry.joinedAt && <Badge variant="outline">{t('invited')}</Badge>}
      {entry.joinedAt && <Badge>{t('joined')}</Badge>}
    </div>
  );
}

export function WaitlistEntriesTable({
  lists,
  fields,
  initial,
  exportMaxRows,
  onChanged,
}: WaitlistEntriesTableProps) {
  const t = useTranslations('admin.waitlist.entries');
  const tShell = useTranslations('admin.shell');
  const format = useFormatter();
  const loadFailed = t('loadFailed');
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [searchText, setSearchText] = useState('');
  const [sortBy, setSortBy] = useState<SortField>(WAITLIST_ADMIN_DEFAULT_SORT.sortBy);
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>(WAITLIST_ADMIN_DEFAULT_SORT.sortOrder);
  const [page, setPage] = useState(1);
  const [entries, setEntries] = useState<WaitlistEntryRow[]>(initial?.entries ?? []);
  const [total, setTotal] = useState(initial?.total ?? 0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(initial ? null : loadFailed);
  const latestRequest = useRef(0);
  // The server rendered the default first page; fetch only once something changes.
  const skipFirstLoad = useRef(initial !== null);

  const [busyId, setBusyId] = useState<string | null>(null);
  const rowSave = useSaveFailure({
    fallback: t('rowFailed'),
    fields: NO_SERVER_FIELDS,
  });

  const [restoreTarget, setRestoreTarget] = useState<WaitlistEntryRow | null>(null);
  const [restoring, setRestoring] = useState(false);
  const restoreSave = useSaveFailure({
    fallback: t('restoreFailed'),
    fields: NO_SERVER_FIELDS,
  });

  const [eraseTarget, setEraseTarget] = useState<WaitlistEntryRow | null>(null);
  const [erasing, setErasing] = useState(false);
  const eraseSave = useSaveFailure({
    fallback: t('eraseFailed'),
    fields: NO_SERVER_FIELDS,
  });

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [waveOpen, setWaveOpen] = useState(false);
  const [selectedWave, setSelectedWave] = useState<WaveResult | null>(null);
  const [invitingSelected, setInvitingSelected] = useState(false);

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
        fail(loadFailed);
        return;
      }
      const body = await parseApiResponse<WaitlistEntryRow[]>(res);
      if (!isCurrent()) return;
      const meta = body.success ? parsePaginationMeta(body.meta) : null;
      if (!body.success || !Array.isArray(body.data) || !meta) {
        fail(loadFailed);
        return;
      }
      // An action that emptied the last page (a remove or erase of its one
      // row) leaves the page past the end: step back to the new last page,
      // which loads in turn.
      const lastPage = Math.max(1, Math.ceil(meta.total / LIMIT));
      if (page > lastPage) {
        setPage(lastPage);
        return;
      }
      setEntries(body.data);
      setTotal(meta.total);
    } catch (err) {
      if (!isCurrent()) return;
      logger.error('waitlist entries fetch failed', err);
      fail(loadFailed);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [filters, page, sortBy, sortOrder, loadFailed]);

  useEffect(() => {
    if (skipFirstLoad.current) {
      skipFirstLoad.current = false;
      return;
    }
    void load();
  }, [load]);

  // A selection is of rows on screen: another page, filter or sort starts afresh.
  useEffect(() => {
    setSelected(new Set());
  }, [filters, page, sortBy, sortOrder]);

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
    onChanged?.();
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

  const invite = async (entry: WaitlistEntryRow) => {
    rowSave.clear();
    setNotice(null);
    setSelectedWave(null);
    setBusyId(entry.id);
    try {
      const data = await apiClient.post<unknown>(API.ADMIN.waitlistEntryInvite(entry.id));
      const outcome = isRecord(data) && typeof data.outcome === 'string' ? data.outcome : 'invited';
      const emailStatus =
        isRecord(data) && typeof data.emailStatus === 'string' ? data.emailStatus : 'sent';
      setNotice(t(`notice.${inviteNoticeKey(outcome, emailStatus)}`));
      onChanged?.();
      await load();
    } catch (err) {
      rowSave.report(err);
    } finally {
      setBusyId(null);
    }
  };

  const inviteSelected = async () => {
    rowSave.clear();
    setNotice(null);
    setSelectedWave(null);
    setInvitingSelected(true);
    try {
      const result = await postWave({ mode: 'ids', ids: [...selected] });
      setSelectedWave(result);
      setSelected(new Set());
      onChanged?.();
      await load();
    } catch (err) {
      rowSave.report(err, t('inviteSelectedFailed'));
    } finally {
      setInvitingSelected(false);
    }
  };

  const toggleSelected = (id: string, on: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
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
      onChanged?.();
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
      // The search box as it reads now, not the debounced copy: an Export
      // clicked straight after typing must not export the wider set.
      const res = await fetch(
        `${API.ADMIN.WAITLIST_EXPORT}?${filterParams({ ...filters, q: searchText })}`
      );
      if (!res.ok) {
        setExportError(res.status === 429 ? t('exportRateLimited') : t('exportFailed'));
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
      setExportError(t('exportFailed'));
    } finally {
      setExporting(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / LIMIT));
  const invitableOnPage = entries.filter(canInvite);
  const allOnPageSelected =
    invitableOnPage.length > 0 && invitableOnPage.every((e) => selected.has(e.id));
  const columns = lists.length > 1 ? 10 : 9;
  const sortIcon = (field: SortField) =>
    sortBy !== field ? null : sortOrder === 'asc' ? (
      <ArrowUp className="ml-1 inline h-3 w-3" aria-hidden />
    ) : (
      <ArrowDown className="ml-1 inline h-3 w-3" aria-hidden />
    );
  const toggles: Array<[key: keyof Filters, label: string, help: string]> = [
    ['includeUnconfirmed', t('showUnconfirmed'), t('showUnconfirmedHelp')],
    ['includeRemoved', t('showRemoved'), t('showRemovedHelp')],
    ['includeJoined', t('showJoined'), t('showJoinedHelp')],
    ['flaggedOnly', t('flaggedOnly'), t('flaggedOnlyHelp')],
  ];

  return (
    <section className="space-y-3" aria-labelledby="waitlist-entries-heading">
      <h2 id="waitlist-entries-heading" className="text-lg font-semibold">
        {t('title')}
      </h2>

      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1">
          <Label htmlFor="waitlist-search" className="flex items-center gap-1">
            {t('search')}
            <FieldHelp title={t('search')}>{t('searchHelp')}</FieldHelp>
          </Label>
          <Input
            id="waitlist-search"
            className="w-64"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder={t('searchPlaceholder')}
          />
        </div>
        {lists.length > 1 && (
          <div className="space-y-1">
            <Label htmlFor="waitlist-list-filter" className="flex items-center gap-1">
              {t('list')}
              <FieldHelp title={t('list')}>{t('listHelp')}</FieldHelp>
            </Label>
            <Select value={filters.list} onValueChange={(v) => setFilter('list', v)}>
              <SelectTrigger id="waitlist-list-filter" className="w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t('allLists')}</SelectItem>
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
        <div className="flex items-center gap-2 pb-1">
          <Button
            size="sm"
            onClick={() => void inviteSelected()}
            disabled={
              selected.size === 0 || selected.size > WAITLIST_INVITE_WAVE_MAX || invitingSelected
            }
          >
            {invitingSelected ? t('inviting') : t('inviteSelected', { count: selected.size })}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setWaveOpen(true)}>
            {t('inviteWave')}
          </Button>
          <FieldHelp title={t('invitingHelpTitle')}>
            {t('invitingHelp', { max: WAITLIST_INVITE_WAVE_MAX })}
          </FieldHelp>
        </div>
        <div className="ml-auto flex items-center gap-2 pb-1">
          <span className="text-muted-foreground text-xs">
            {t('exportLimit', { max: exportMaxRows })}
          </span>
          <Button variant="outline" size="sm" onClick={() => void exportCsv()} disabled={exporting}>
            {exporting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Download className="mr-2 h-4 w-4" aria-hidden />
            )}
            {t('exportCsv')}
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
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {selectedWave && <WaveSummary result={selectedWave} />}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <Checkbox
                  aria-label={t('selectPage')}
                  checked={allOnPageSelected}
                  disabled={invitableOnPage.length === 0}
                  onCheckedChange={(checked) =>
                    setSelected(
                      checked === true ? new Set(invitableOnPage.map((e) => e.id)) : new Set()
                    )
                  }
                />
              </TableHead>
              <TableHead>
                <button type="button" onClick={() => sortOn('email')}>
                  {t('address')}
                  {sortIcon('email')}
                </button>
              </TableHead>
              <TableHead>{t('name')}</TableHead>
              {lists.length > 1 && <TableHead>{t('list')}</TableHead>}
              <TableHead>{t('answers')}</TableHead>
              <TableHead>{t('source')}</TableHead>
              <TableHead>
                <button type="button" onClick={() => sortOn('createdAt')}>
                  {t('joined')}
                  {sortIcon('createdAt')}
                </button>
              </TableHead>
              <TableHead>
                <button type="button" onClick={() => sortOn('confirmedAt')}>
                  {t('confirmed')}
                  {sortIcon('confirmedAt')}
                </button>
              </TableHead>
              <TableHead>{t('state')}</TableHead>
              <TableHead className="text-right">{tShell('actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns} className="text-muted-foreground py-8 text-center">
                  {loading ? tShell('loading') : error ? tShell('nothingToShow') : t('empty')}
                </TableCell>
              </TableRow>
            ) : (
              entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell>
                    {canInvite(entry) && (
                      <Checkbox
                        aria-label={t('selectOne', { email: entry.email })}
                        checked={selected.has(entry.id)}
                        onCheckedChange={(checked) => toggleSelected(entry.id, checked === true)}
                      />
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{entry.email}</TableCell>
                  <TableCell>{entry.name ?? '—'}</TableCell>
                  {lists.length > 1 && <TableCell>{entry.list}</TableCell>}
                  <TableCell className="max-w-xs text-xs">
                    {answers(entry, fields).map(([question, answer]) => {
                      const line = t('answer', { question, answer });
                      return (
                        <div key={line} className="truncate" title={line}>
                          {line}
                        </div>
                      );
                    })}
                  </TableCell>
                  <TableCell className="text-xs">{entry.utmSource ?? entry.source}</TableCell>
                  <TableCell>{format.dateTime(new Date(entry.createdAt), 'short')}</TableCell>
                  <TableCell>
                    {entry.confirmedAt
                      ? format.dateTime(new Date(entry.confirmedAt), 'short')
                      : '—'}
                  </TableCell>
                  <TableCell>
                    <StateBadges entry={entry} />
                  </TableCell>
                  <TableCell className="space-x-2 text-right whitespace-nowrap">
                    {canInvite(entry) && (
                      <Button
                        size="sm"
                        onClick={() => void invite(entry)}
                        disabled={busyId === entry.id}
                      >
                        {entry.invitedAt ? t('resend') : t('invite')}
                      </Button>
                    )}
                    {entry.removedAt ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setRestoreTarget(entry)}
                        disabled={busyId === entry.id}
                      >
                        {t('restore')}
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void remove(entry)}
                        disabled={busyId === entry.id}
                      >
                        {t('remove')}
                      </Button>
                    )}
                    <Button variant="destructive" size="sm" onClick={() => setEraseTarget(entry)}>
                      {t('erase')}
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{t('people', { count: total })}</span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => p - 1)}
            disabled={page <= 1 || loading}
            aria-label={tShell('previousPage')}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span>{t('pageOf', { page, total: totalPages })}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => p + 1)}
            disabled={page >= totalPages || loading}
            aria-label={tShell('nextPage')}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <WaitlistInviteWaveDialog
        open={waveOpen}
        onOpenChange={setWaveOpen}
        lists={lists}
        fields={fields}
        onInvited={() => {
          onChanged?.();
          void load();
        }}
      />

      <AlertDialog open={restoreTarget !== null} onOpenChange={restoreDialog.onOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('restoreTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {restoreTarget && restoreTarget.rejoinRequests > 0
                ? t('restoreDescriptionRejoined', { count: restoreTarget.rejoinRequests })
                : t('restoreDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <SaveError failure={restoreSave.failure} />
          <AlertDialogFooter>
            <AlertDialogCancel {...restoreDialog.cancelProps}>{tShell('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              {...restoreDialog.actionProps()}
              onClick={(e) => restoreDialog.confirm(e, handleRestore)}
            >
              {restoring ? t('restoring') : t('restore')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={eraseTarget !== null} onOpenChange={eraseDialog.onOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('eraseTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('eraseDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <SaveError failure={eraseSave.failure} />
          <AlertDialogFooter>
            <AlertDialogCancel {...eraseDialog.cancelProps}>{tShell('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              {...eraseDialog.actionProps()}
              onClick={(e) => eraseDialog.confirm(e, handleErase)}
              className="bg-red-600 hover:bg-red-700"
            >
              {erasing ? t('erasing') : t('erase')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
