'use client';

/**
 * WebhookDlqTable
 *
 * Cross-subscription view of `exhausted` webhook deliveries. Replaces the
 * per-subscription drill-down when an operator just wants "show me
 * everything in the dead-letter state right now."
 *
 * Each row shows the destination recorded on the delivery itself, which
 * outlives its subscription (§109 t-739). A row whose subscription was
 * deleted has no link and cannot be retried; it is kept as a record.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, Loader2, RotateCcw, Trash2, Repeat } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { SaveError } from '@/components/forms/form-error';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { NO_SERVER_FIELDS, useSaveFailure } from '@/lib/hooks/use-save-failure';
import { useCommittedDialog } from '@/lib/hooks/use-committed-dialog';
import { parseApiResponse } from '@/lib/api/parse-response';
import { formatEventLabel } from '@/lib/orchestration/webhooks/event-labels';
import { parsePaginationMeta } from '@/lib/validations/common';
import { WEBHOOK_EVENT_TYPES } from '@/lib/validations/orchestration';
import type { PaginationMeta } from '@/types/api';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DlqDelivery {
  id: string;
  eventType: string;
  status: 'exhausted';
  lastResponseCode: number | null;
  lastError: string | null;
  attempts: number;
  createdAt: string;
  lastAttemptAt: string | null;
  /** URL origin or email address the delivery was sent to; null on rows that predate recording. */
  destination: string | null;
  /** Null once the subscription was deleted. */
  subscriptionId: string | null;
  /** Null once the subscription was deleted. No `url`: it can carry a credential. */
  subscription: {
    id: string;
    description: string | null;
  } | null;
}

export interface WebhookDlqTableProps {
  initialDeliveries: DlqDelivery[];
  initialMeta: PaginationMeta;
  subscriptions: { id: string; url: string; description: string | null }[];
}

/** What a row is called: its subscription's description, else where it went. */
function deliveryLabel(d: DlqDelivery): string {
  return d.subscription?.description ?? d.destination ?? 'Subscription';
}

// ─── Component ─────────────────────────────────────────────────────────────

export function WebhookDlqTable({
  initialDeliveries,
  initialMeta,
  subscriptions,
}: WebhookDlqTableProps) {
  const [deliveries, setDeliveries] = useState<DlqDelivery[]>(initialDeliveries);
  const [meta, setMeta] = useState<PaginationMeta>(initialMeta);
  const [subscriptionFilter, setSubscriptionFilter] = useState('all');
  const [eventFilter, setEventFilter] = useState('all');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [loading, setLoading] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  // A refused row retry or bulk replay: shown in the one box above the table (§124).
  // It names the row retried, or the bulk replay, since they share it.
  const actionSave = useSaveFailure({ fallback: 'Try again.', fields: NO_SERVER_FIELDS });
  // The row whose discard dialog is open. A refused discard shows inside it,
  // and it stays open.
  const [discardId, setDiscardId] = useState<string | null>(null);
  const discardSave = useSaveFailure({
    fallback: 'Delete failed. Please try again.',
    fields: NO_SERVER_FIELDS,
  });

  const fetchPage = useCallback(
    async (page: number) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({
          page: String(page),
          pageSize: String(meta.limit),
        });
        if (subscriptionFilter !== 'all') params.set('subscriptionId', subscriptionFilter);
        if (eventFilter !== 'all') params.set('eventType', eventFilter);
        if (since) params.set('since', new Date(since).toISOString());
        if (until) params.set('until', new Date(until).toISOString());

        const res = await fetch(`${API.ADMIN.ORCHESTRATION.WEBHOOK_DLQ}?${params}`);
        const body = await parseApiResponse<DlqDelivery[]>(res);
        if (body.success) {
          setDeliveries(body.data);
          if (body.meta) {
            const parsed = parsePaginationMeta(body.meta);
            if (parsed) setMeta(parsed);
          }
        }
      } finally {
        setLoading(false);
      }
    },
    [subscriptionFilter, eventFilter, since, until, meta.limit]
  );

  useEffect(() => {
    void fetchPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscriptionFilter, eventFilter, since, until]);

  const handleRetry = async (delivery: DlqDelivery) => {
    const deliveryId = delivery.id;
    setActionId(deliveryId);
    actionSave.clear();
    try {
      await apiClient.post(API.ADMIN.ORCHESTRATION.retryDelivery(deliveryId));
      void fetchPage(meta.page);
    } catch (err) {
      actionSave.report(err, `Couldn't retry the delivery to "${deliveryLabel(delivery)}"`);
    } finally {
      setActionId(null);
    }
  };

  const handleBulkReplay = async () => {
    setActionId('bulk');
    actionSave.clear();
    try {
      const body: Record<string, unknown> = {};
      if (subscriptionFilter !== 'all') {
        body.subscriptionId = subscriptionFilter;
        if (until) body.before = new Date(until).toISOString();
      } else {
        // No subscription selected: replay everything visible on this page
        // that still has a subscription to send to. A row whose subscription
        // was deleted is kept as a record and cannot be retried; the server
        // would only skip it, and say nothing.
        body.deliveryIds = deliveries.filter((d) => d.subscription).map((d) => d.id);
        if ((body.deliveryIds as string[]).length === 0) {
          actionSave.show(
            deliveries.length > 0
              ? 'Nothing to replay on this page: every row’s subscription was deleted.'
              : 'Nothing to replay on this page.'
          );
          setActionId(null);
          return;
        }
      }
      await apiClient.post(API.ADMIN.ORCHESTRATION.WEBHOOK_DLQ_REPLAY, { body });
      void fetchPage(meta.page);
    } catch (err) {
      actionSave.report(err, 'Bulk replay failed');
    } finally {
      setActionId(null);
    }
  };

  const handleDelete = async (deliveryId: string) => {
    setActionId(deliveryId);
    discardSave.clear();
    try {
      await apiClient.delete(API.ADMIN.ORCHESTRATION.deliveryById(deliveryId));
      setDiscardId(null);
      void fetchPage(meta.page);
    } catch (err) {
      discardSave.report(err);
    } finally {
      setActionId(null);
    }
  };

  // One discard dialog is open at a time (each row's trigger sets its id):
  // committed while its discard runs, cleared each time it opens.
  const discardDialog = useCommittedDialog({
    open: discardId !== null,
    pending: discardId !== null && actionId === discardId,
    onClose: () => setDiscardId(null),
    clear: discardSave.clear,
  });

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <div className="grid gap-1">
          <span className="text-muted-foreground text-xs">Subscription</span>
          <Select value={subscriptionFilter} onValueChange={setSubscriptionFilter}>
            <SelectTrigger>
              <SelectValue placeholder="All subscriptions" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All subscriptions</SelectItem>
              {subscriptions.map((sub) => (
                <SelectItem key={sub.id} value={sub.id}>
                  {sub.description ?? sub.url}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1">
          <span className="text-muted-foreground text-xs">Event type</span>
          <Select value={eventFilter} onValueChange={setEventFilter}>
            <SelectTrigger>
              <SelectValue placeholder="All events" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All events</SelectItem>
              {WEBHOOK_EVENT_TYPES.map((event) => (
                <SelectItem key={event} value={event}>
                  {formatEventLabel(event)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1">
          <label className="text-muted-foreground text-xs" htmlFor="dlq-since">
            From
          </label>
          <DatePicker id="dlq-since" value={since} onChange={setSince} />
        </div>
        <div className="grid gap-1">
          <label className="text-muted-foreground text-xs" htmlFor="dlq-until">
            To
          </label>
          <DatePicker id="dlq-until" value={until} onChange={setUntil} />
        </div>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-xs">
          {subscriptionFilter === 'all'
            ? 'Bulk replay re-dispatches every row on this page whose subscription still exists.'
            : 'Bulk replay re-dispatches every exhausted delivery for the selected subscription (optionally before the "To" date).'}
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={actionId !== null}
          onClick={() => void handleBulkReplay()}
        >
          {actionId === 'bulk' ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Repeat className="mr-2 h-4 w-4" />
          )}
          Bulk replay
        </Button>
      </div>

      <SaveError failure={actionSave.failure} />

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Subscription</TableHead>
              <TableHead>Event</TableHead>
              <TableHead>Last response</TableHead>
              <TableHead>Attempts</TableHead>
              <TableHead>Last error</TableHead>
              <TableHead className="w-24 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {deliveries.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground py-8 text-center">
                  {loading ? 'Loading…' : 'Nothing in the dead-letter queue.'}
                </TableCell>
              </TableRow>
            ) : (
              deliveries.map((d) => (
                <TableRow key={d.id} className={loading ? 'opacity-50' : ''}>
                  <TableCell className="text-muted-foreground text-xs">
                    {new Date(d.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    {d.subscription ? (
                      <Link
                        href={`/admin/orchestration/event-subscriptions/${d.subscription.id}`}
                        className="hover:underline"
                      >
                        <span className="block max-w-[220px] truncate text-sm">
                          {deliveryLabel(d)}
                        </span>
                        <span className="text-muted-foreground block max-w-[220px] truncate text-xs">
                          {d.destination ?? 'Destination not recorded'}
                        </span>
                      </Link>
                    ) : (
                      <>
                        <span className="text-muted-foreground block text-sm italic">
                          Deleted subscription
                        </span>
                        <span className="text-muted-foreground block max-w-[220px] truncate text-xs">
                          {d.destination ?? 'Destination not recorded'}
                        </span>
                      </>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="text-[10px]">
                      {formatEventLabel(d.eventType)}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-sm">{d.lastResponseCode ?? '—'}</TableCell>
                  <TableCell className="text-sm">{d.attempts}</TableCell>
                  <TableCell className="max-w-[240px] truncate text-xs text-red-600 dark:text-red-400">
                    {d.lastError ?? '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={actionId === d.id || !d.subscription}
                        onClick={() => void handleRetry(d)}
                        title={
                          d.subscription
                            ? 'Retry delivery'
                            : 'Its subscription was deleted, so there is nowhere to retry it'
                        }
                      >
                        {actionId === d.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <RotateCcw className="h-4 w-4" />
                        )}
                      </Button>
                      <AlertDialog
                        open={discardId === d.id}
                        onOpenChange={discardDialog.onOpenChange}
                      >
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setDiscardId(d.id)}
                            disabled={actionId === d.id}
                            title="Discard from DLQ"
                          >
                            <Trash2 className="text-destructive h-4 w-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Discard this delivery?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Permanently deletes the delivery record. Use this for failures
                              you&apos;ve reviewed and don&apos;t need to keep. Bulk cleanup is
                              handled by the retention sweep.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <SaveError failure={discardSave.failure} />
                          <AlertDialogFooter>
                            <AlertDialogCancel {...discardDialog.cancelProps}>
                              Cancel
                            </AlertDialogCancel>
                            {/* Closes only on success, so a refusal can be read inside it. */}
                            <AlertDialogAction
                              {...discardDialog.actionProps()}
                              onClick={(e) => discardDialog.confirm(e, () => handleDelete(d.id))}
                            >
                              Delete
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {meta.totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            Page {meta.page} of {meta.totalPages} ({meta.total} total)
          </span>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={meta.page <= 1 || loading}
              onClick={() => void fetchPage(meta.page - 1)}
            >
              <ChevronLeft className="mr-1 h-4 w-4" /> Prev
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={meta.page >= meta.totalPages || loading}
              onClick={() => void fetchPage(meta.page + 1)}
            >
              Next <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
