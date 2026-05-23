'use client';

/**
 * WebhookDlqTable
 *
 * Cross-subscription view of `exhausted` webhook deliveries. Replaces the
 * per-subscription drill-down when an operator just wants "show me
 * everything in the dead-letter state right now."
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
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import { formatEventLabel } from '@/lib/orchestration/webhooks/event-labels';
import { parsePaginationMeta } from '@/lib/validations/common';
import { WEBHOOK_EVENT_TYPES } from '@/lib/validations/orchestration';
import type { PaginationMeta } from '@/types/api';

// ─── Types ──────────────────────────────────────────────────────────────────

interface DlqDelivery {
  id: string;
  eventType: string;
  status: 'exhausted';
  lastResponseCode: number | null;
  lastError: string | null;
  attempts: number;
  createdAt: string;
  lastAttemptAt: string | null;
  subscriptionId: string;
  subscription: {
    id: string;
    url: string;
    description: string | null;
  };
}

export interface WebhookDlqTableProps {
  initialDeliveries: DlqDelivery[];
  initialMeta: PaginationMeta;
  subscriptions: { id: string; url: string; description: string | null }[];
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
  const [actionError, setActionError] = useState<string | null>(null);

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

  const handleRetry = async (deliveryId: string) => {
    setActionId(deliveryId);
    setActionError(null);
    try {
      await apiClient.post(API.ADMIN.ORCHESTRATION.retryDelivery(deliveryId));
      void fetchPage(meta.page);
    } catch (err) {
      setActionError(
        err instanceof APIClientError
          ? `Retry failed: ${err.message}`
          : 'Retry failed. Please try again.'
      );
    } finally {
      setActionId(null);
    }
  };

  const handleBulkReplay = async () => {
    setActionId('bulk');
    setActionError(null);
    try {
      const body: Record<string, unknown> = {};
      if (subscriptionFilter !== 'all') {
        body.subscriptionId = subscriptionFilter;
        if (until) body.before = new Date(until).toISOString();
      } else {
        // No subscription selected: replay everything visible on this page.
        body.deliveryIds = deliveries.map((d) => d.id);
        if ((body.deliveryIds as string[]).length === 0) {
          setActionError('Nothing to replay on this page.');
          setActionId(null);
          return;
        }
      }
      await apiClient.post(API.ADMIN.ORCHESTRATION.WEBHOOK_DLQ_REPLAY, { body });
      void fetchPage(meta.page);
    } catch (err) {
      setActionError(
        err instanceof APIClientError
          ? `Bulk replay failed: ${err.message}`
          : 'Bulk replay failed. Please try again.'
      );
    } finally {
      setActionId(null);
    }
  };

  const handleDelete = async (deliveryId: string) => {
    setActionId(deliveryId);
    setActionError(null);
    try {
      await apiClient.delete(API.ADMIN.ORCHESTRATION.deliveryById(deliveryId));
      void fetchPage(meta.page);
    } catch (err) {
      setActionError(
        err instanceof APIClientError
          ? `Delete failed: ${err.message}`
          : 'Delete failed. Please try again.'
      );
    } finally {
      setActionId(null);
    }
  };

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
            ? 'Bulk replay re-dispatches every row visible on this page.'
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

      {actionError && <p className="text-destructive text-sm">{actionError}</p>}

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
                    <Link
                      href={`/admin/orchestration/event-subscriptions/${d.subscription.id}`}
                      className="hover:underline"
                    >
                      <span className="block max-w-[220px] truncate text-sm">
                        {d.subscription.description ?? d.subscription.url}
                      </span>
                      <span className="text-muted-foreground block max-w-[220px] truncate text-xs">
                        {d.subscription.url}
                      </span>
                    </Link>
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
                        disabled={actionId === d.id}
                        onClick={() => void handleRetry(d.id)}
                        title="Retry delivery"
                      >
                        {actionId === d.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <RotateCcw className="h-4 w-4" />
                        )}
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
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
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => void handleDelete(d.id)}>
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
