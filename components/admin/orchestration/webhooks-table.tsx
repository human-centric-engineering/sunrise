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
import { ChevronLeft, ChevronRight, Plus, Trash2 } from 'lucide-react';

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
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
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
}

export interface WebhooksTableProps {
  initialWebhooks: WebhookListItem[];
  initialMeta: PaginationMeta;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function WebhooksTable({ initialWebhooks, initialMeta }: WebhooksTableProps) {
  const [webhooks, setWebhooks] = useState(initialWebhooks);
  const [meta, setMeta] = useState(initialMeta);
  const [activeFilter, setActiveFilter] = useState('all');
  const [loading, setLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<WebhookListItem | null>(null);

  const fetchPage = useCallback(
    async (page: number) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ page: String(page), limit: String(meta.limit) });
        if (activeFilter !== 'all') params.set('isActive', activeFilter);
        const res = await fetch(`${API.ADMIN.ORCHESTRATION.WEBHOOKS}?${params}`);
        const body = await parseApiResponse<WebhookListItem[]>(res);
        if (body.success) {
          setWebhooks(body.data);
          setMeta(parsePaginationMeta(body.meta) ?? meta);
        }
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
    try {
      await apiClient.delete(API.ADMIN.ORCHESTRATION.webhookById(deleteTarget.id));
      void fetchPage(meta.page);
    } finally {
      setDeleteTarget(null);
    }
  };

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

      {/* Table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>URL</TableHead>
              <TableHead>Events</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {webhooks.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground py-8 text-center">
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
                          {e}
                        </Badge>
                      ))}
                      {wh.events.length > 3 && (
                        <Badge variant="outline" className="text-[10px]">
                          +{wh.events.length - 3}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    {wh.isActive ? (
                      <span className="flex items-center gap-1 text-sm text-green-600">
                        <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
                        Active
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-sm text-gray-400">
                        <span className="inline-block h-2 w-2 rounded-full bg-gray-300" />
                        Inactive
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {new Date(wh.createdAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setDeleteTarget(wh)}
                      title="Delete webhook"
                    >
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
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
