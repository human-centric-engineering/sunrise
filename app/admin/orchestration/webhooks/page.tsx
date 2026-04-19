import type { Metadata } from 'next';
import Link from 'next/link';

import {
  WebhooksTable,
  type WebhookListItem,
} from '@/components/admin/orchestration/webhooks-table';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { parsePaginationMeta } from '@/lib/validations/common';
import { logger } from '@/lib/logging';
import type { PaginationMeta } from '@/types/api';

export const metadata: Metadata = {
  title: 'Webhooks · AI Orchestration',
  description: 'Manage webhook subscriptions for orchestration events.',
};

const EMPTY_META: PaginationMeta = {
  page: 1,
  limit: 25,
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

export default async function WebhooksListPage() {
  const { webhooks, meta } = await getWebhooks();

  return (
    <div className="space-y-6">
      <header>
        <nav className="text-muted-foreground mb-1 text-xs">
          <Link href="/admin/orchestration" className="hover:underline">
            AI Orchestration
          </Link>
          {' / '}
          <span>Webhooks</span>
        </nav>
        <h1 className="text-2xl font-semibold">
          Webhooks{' '}
          <FieldHelp title="What are webhooks?" contentClassName="w-96 max-h-80 overflow-y-auto">
            <p>
              Webhooks let you receive real-time notifications when events happen in the
              orchestration system — budget exceeded, workflow failed, conversation started, etc.
            </p>
            <p className="text-foreground mt-2 font-medium">How it works</p>
            <p>
              When an event fires, Sunrise sends an HMAC-signed POST request to your endpoint with
              the event type and payload. Failed deliveries are retried with exponential backoff.
            </p>
            <p className="text-foreground mt-2 font-medium">This page</p>
            <p>Create, edit, and monitor webhook subscriptions and their delivery history.</p>
          </FieldHelp>
        </h1>
        <p className="text-muted-foreground text-sm">
          Subscribe to orchestration events and monitor delivery status.
        </p>
      </header>

      <WebhooksTable initialWebhooks={webhooks} initialMeta={meta} />
    </div>
  );
}
