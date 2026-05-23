import type { Metadata } from 'next';
import Link from 'next/link';

import { EventSubscriptionsTabs } from '@/components/admin/orchestration/event-subscriptions-tabs';
import { type WebhookListItem } from '@/components/admin/orchestration/webhooks-table';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { parsePaginationMeta } from '@/lib/validations/common';
import { logger } from '@/lib/logging';
import type { PaginationMeta } from '@/types/api';

export const metadata: Metadata = {
  title: 'Event Subscriptions · AI Orchestration',
  description: 'Manage webhook subscriptions and the dead-letter queue.',
};

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
  subscription: { id: string; url: string; description: string | null };
}

const EMPTY_META: PaginationMeta = {
  page: 1,
  limit: 25,
  total: 0,
  totalPages: 1,
};

const EMPTY_DLQ_META: PaginationMeta = {
  page: 1,
  limit: 20,
  total: 0,
  totalPages: 1,
};

async function getWebhooks(): Promise<{ webhooks: WebhookListItem[]; meta: PaginationMeta }> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.WEBHOOKS}?page=1&limit=25`);
    if (!res.ok) return { webhooks: [], meta: EMPTY_META };
    const body = await parseApiResponse<WebhookListItem[]>(res);
    if (!body.success) return { webhooks: [], meta: EMPTY_META };
    return {
      webhooks: body.data,
      meta: parsePaginationMeta(body.meta) ?? EMPTY_META,
    };
  } catch (err) {
    logger.error('webhooks list page: initial fetch failed', err);
    return { webhooks: [], meta: EMPTY_META };
  }
}

async function getDlq(): Promise<{ deliveries: DlqDelivery[]; meta: PaginationMeta }> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.WEBHOOK_DLQ}?page=1&pageSize=20`);
    if (!res.ok) return { deliveries: [], meta: EMPTY_DLQ_META };
    const body = await parseApiResponse<DlqDelivery[]>(res);
    if (!body.success) return { deliveries: [], meta: EMPTY_DLQ_META };
    return {
      deliveries: body.data,
      meta: parsePaginationMeta(body.meta) ?? EMPTY_DLQ_META,
    };
  } catch (err) {
    logger.error('event-subscriptions page: dlq fetch failed', err);
    return { deliveries: [], meta: EMPTY_DLQ_META };
  }
}

export default async function EventSubscriptionsPage() {
  const [{ webhooks, meta }, { deliveries: dlqDeliveries, meta: dlqMeta }] = await Promise.all([
    getWebhooks(),
    getDlq(),
  ]);

  // The DLQ filter dropdown lists the same set of subscriptions returned
  // from the main list call — no separate fetch needed.
  const dlqSubscriptions = webhooks.map((w) => ({
    id: w.id,
    url: w.url,
    description: w.description,
  }));

  return (
    <div className="space-y-6">
      <header>
        <nav className="text-muted-foreground mb-1 text-xs">
          <Link href="/admin/orchestration" className="hover:underline">
            AI Orchestration
          </Link>
          {' / '}
          <span>Event Subscriptions</span>
        </nav>
        <h1 className="text-2xl font-semibold">
          Event Subscriptions{' '}
          <FieldHelp title="What are webhooks?" contentClassName="w-96 max-h-80 overflow-y-auto">
            <p>
              Webhooks let you receive real-time notifications when events happen in the
              orchestration system — budget exceeded, workflow failed, conversation started, etc.
            </p>
            <p className="text-foreground mt-2 font-medium">How it works</p>
            <p>
              When an event fires, Sunrise sends a signed POST request to your endpoint with the
              event type and payload. The signature (HMAC-SHA256 — a tamper-proof hash using your
              secret key) lets you verify the request genuinely came from Sunrise. Failed deliveries
              are retried with exponential backoff; deliveries that exhaust their configured
              attempts land in the Dead Letter Queue tab.
            </p>
            <p className="text-foreground mt-2 font-medium">This page</p>
            <p>
              Create and monitor webhook subscriptions, and review or replay deliveries that have
              been parked in the dead-letter queue.
            </p>
          </FieldHelp>
        </h1>
        <p className="text-muted-foreground text-sm">
          Subscribe to orchestration events and monitor delivery status.
        </p>
      </header>

      <EventSubscriptionsTabs
        webhooks={webhooks}
        webhooksMeta={meta}
        dlqDeliveries={dlqDeliveries}
        dlqMeta={dlqMeta}
        dlqSubscriptions={dlqSubscriptions}
      />
    </div>
  );
}
