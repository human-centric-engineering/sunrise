'use client';

/**
 * WebhooksTable
 *
 * Admin list view for webhook subscriptions. Supports:
 *   - Active/inactive filter
 *   - Pagination
 *   - Delete with confirmation
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronLeft, ChevronRight, Edit, MoreHorizontal, Plus, Trash2 } from 'lucide-react';

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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import { formatEventLabel } from '@/lib/orchestration/webhooks/event-labels';
import { parsePaginationMeta } from '@/lib/validations/common';
import type { PaginationMeta } from '@/types/api';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WebhookListItem {
  id: string;
  url: string;
  events: string[];
  isActive: boolean;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  _count: { deliveries: number };
}

export interface WebhooksTableProps {
  initialWebhooks: WebhookListItem[];
  initialMeta: PaginationMeta;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function WebhooksTable({ initialWebhooks, initialMeta }: WebhooksTableProps) {
  const router = useRouter();
  const [webhooks, setWebhooks] = useState(initialWebhooks);
  const [meta, setMeta] = useState(initialMeta);
  const [activeFilter, setActiveFilter] = useState('all');
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WebhookListItem | null>(null);

  const fetchPage = useCallback(
    async (page: number) => {
      setLoading(true);
      setListError(null);
      try {
        const params = new URLSearchParams({ page: String(page), limit: String(meta.limit) });
        if (activeFilter !== 'all') params.set('isActive', activeFilter);
        const res = await fetch(`${API.ADMIN.ORCHESTRATION.WEBHOOKS}?${params}`);
        const body = await parseApiResponse<WebhookListItem[]>(res);
        if (body.success) {
          setWebhooks(body.data);
          setMeta(parsePaginationMeta(body.meta) ?? meta);
        }
      } catch (err) {
        setListError(err instanceof APIClientError ? err.message : 'Failed to load webhooks');
      } finally {
        setLoading(false);
      }
    },
    [activeFilter, meta.limit, meta]
  );

  useEffect(() => {
    void fetchPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFilter]);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setListError(null);
    try {
      await apiClient.delete(API.ADMIN.ORCHESTRATION.webhookById(deleteTarget.id));
      void fetchPage(meta.page);
    } catch (err) {
      setListError(
        err instanceof APIClientError
          ? `Delete failed: ${err.message}`
          : 'Could not delete webhook. Try again.'
      );
    } finally {
      setDeleteTarget(null);
    }
  };

  const handleToggleActive = useCallback(async (wh: WebhookListItem, nextActive: boolean) => {
    setWebhooks((prev) => prev.map((w) => (w.id === wh.id ? { ...w, isActive: nextActive } : w)));
    try {
      await apiClient.patch(API.ADMIN.ORCHESTRATION.webhookById(wh.id), {
        body: { isActive: nextActive },
      });
    } catch (err) {
      setWebhooks((prev) =>
        prev.map((w) => (w.id === wh.id ? { ...w, isActive: wh.isActive } : w))
      );
      setListError(
        err instanceof APIClientError
          ? `Could not update webhook: ${err.message}`
          : 'Could not update webhook. Try again.'
      );
    }
  }, []);

  const truncateUrl = (url: string, max = 50) => (url.length > max ? url.slice(0, max) + '…' : url);

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Select value={activeFilter} onValueChange={setActiveFilter}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="true">Active</SelectItem>
              <SelectItem value="false">Inactive</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button asChild>
          <Link href="/admin/orchestration/webhooks/new">
            <Plus className="mr-2 h-4 w-4" />
            New webhook
          </Link>
        </Button>
      </div>

      {listError && (
        <div className="border-destructive/50 bg-destructive/5 text-destructive rounded-md border px-3 py-2 text-sm">
          {listError}
        </div>
      )}

      {/* Table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>URL</TableHead>
              <TableHead>Events</TableHead>
              <TableHead className="text-center">Deliveries</TableHead>
              <TableHead className="text-center">Active</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {webhooks.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground py-8 text-center">
                  {loading ? 'Loading…' : 'No webhook subscriptions yet.'}
                </TableCell>
              </TableRow>
            ) : (
              webhooks.map((wh) => (
                <TableRow key={wh.id} className={loading ? 'opacity-50' : ''}>
                  <TableCell>
                    <Link
                      href={`/admin/orchestration/webhooks/${wh.id}`}
                      className="font-mono text-sm hover:underline"
                    >
                      {truncateUrl(wh.url)}
                    </Link>
                    {wh.description && (
                      <p className="text-muted-foreground text-xs">{wh.description}</p>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {wh.events.slice(0, 3).map((e) => (
                        <Badge key={e} variant="secondary" className="text-[10px]">
                          {formatEventLabel(e)}
                        </Badge>
                      ))}
                      {wh.events.length > 3 && (
                        <Badge variant="outline" className="text-[10px]">
                          +{wh.events.length - 3}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-center text-sm tabular-nums">
                    {wh._count.deliveries}
                  </TableCell>
                  <TableCell className="text-center">
                    <Switch
                      checked={wh.isActive}
                      onCheckedChange={(v) => void handleToggleActive(wh, v)}
                      aria-label={`Toggle ${truncateUrl(wh.url, 30)} active`}
                    />
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {new Date(wh.createdAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" className="h-8 w-8 p-0">
                          <span className="sr-only">Row actions</span>
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuLabel>Actions</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() => router.push(`/admin/orchestration/webhooks/${wh.id}`)}
                        >
                          <Edit className="mr-2 h-4 w-4" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-red-600"
                          onClick={() => setDeleteTarget(wh)}
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
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

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete webhook?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the webhook subscription to{' '}
              <code className="text-xs">{deleteTarget?.url}</code>. Delivery history will also be
              removed. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleDelete()}
              className="bg-red-600 hover:bg-red-700"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
