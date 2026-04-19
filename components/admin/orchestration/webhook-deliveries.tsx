'use client';

/**
 * WebhookDeliveries
 *
 * Delivery log table for a specific webhook subscription.
 * Shows timestamp, event, status, response code, and retry button.
 */

import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2, RotateCcw } from 'lucide-react';

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

// ─── Types ──────────────────────────────────────────────────────────────────

interface Delivery {
  id: string;
  event: string;
  status: 'pending' | 'delivered' | 'failed' | 'exhausted';
  responseCode: number | null;
  attempts: number;
  createdAt: string;
}

interface DeliveryMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface WebhookDeliveriesProps {
  webhookId: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const STATUS_VARIANTS: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  delivered: 'default',
  pending: 'secondary',
  failed: 'destructive',
  exhausted: 'destructive',
};

// ─── Component ─────────────────────────────────────────────────────────────

export function WebhookDeliveries({ webhookId }: WebhookDeliveriesProps) {
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [meta, setMeta] = useState<DeliveryMeta>({
    page: 1,
    pageSize: 20,
    total: 0,
    totalPages: 1,
  });
  const [statusFilter, setStatusFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState<string | null>(null);

  const fetchDeliveries = useCallback(
    async (page: number) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({
          page: String(page),
          pageSize: String(meta.pageSize),
        });
        if (statusFilter !== 'all') params.set('status', statusFilter);

        const res = await fetch(
          `${API.ADMIN.ORCHESTRATION.webhookDeliveries(webhookId)}?${params}`
        );
        const body = await parseApiResponse<Delivery[]>(res);
        if (body.success) {
          setDeliveries(body.data);
          if (body.meta) {
            setMeta(body.meta as unknown as DeliveryMeta);
          }
        }
      } finally {
        setLoading(false);
      }
    },
    [webhookId, statusFilter, meta.pageSize]
  );

  useEffect(() => {
    void fetchDeliveries(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  const handleRetry = async (deliveryId: string) => {
    setRetrying(deliveryId);
    try {
      await apiClient.post(API.ADMIN.ORCHESTRATION.retryDelivery(deliveryId));
      void fetchDeliveries(meta.page);
    } finally {
      setRetrying(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Delivery history</h2>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="delivered">Delivered</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
            <SelectItem value="exhausted">Exhausted</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Event</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Response</TableHead>
              <TableHead>Attempts</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {deliveries.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground py-8 text-center">
                  {loading ? 'Loading…' : 'No deliveries yet.'}
                </TableCell>
              </TableRow>
            ) : (
              deliveries.map((d) => (
                <TableRow key={d.id} className={loading ? 'opacity-50' : ''}>
                  <TableCell className="text-muted-foreground text-xs">
                    {new Date(d.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="text-[10px]">
                      {d.event}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANTS[d.status] ?? 'outline'} className="text-[10px]">
                      {d.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-sm">{d.responseCode ?? '—'}</TableCell>
                  <TableCell className="text-sm">{d.attempts}</TableCell>
                  <TableCell>
                    {(d.status === 'failed' || d.status === 'exhausted') && (
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={retrying === d.id}
                        onClick={() => void handleRetry(d.id)}
                        title="Retry delivery"
                      >
                        {retrying === d.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <RotateCcw className="h-4 w-4" />
                        )}
                      </Button>
                    )}
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
              onClick={() => void fetchDeliveries(meta.page - 1)}
            >
              <ChevronLeft className="mr-1 h-4 w-4" /> Prev
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={meta.page >= meta.totalPages || loading}
              onClick={() => void fetchDeliveries(meta.page + 1)}
            >
              Next <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
