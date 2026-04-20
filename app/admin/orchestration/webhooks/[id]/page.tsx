import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { WebhookForm } from '@/components/admin/orchestration/webhook-form';
import { WebhookTestButton } from '@/components/admin/orchestration/webhook-test-button';
import { WebhookDeliveries } from '@/components/admin/orchestration/webhook-deliveries';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';

export const metadata: Metadata = {
  title: 'Edit Webhook · AI Orchestration',
  description: 'Edit webhook subscription and view delivery history.',
};

interface WebhookDetail {
  id: string;
  url: string;
  events: string[];
  isActive: boolean;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

async function getWebhook(id: string): Promise<WebhookDetail | null> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.webhookById(id));
    if (!res.ok) return null;
    const body = await parseApiResponse<WebhookDetail>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('webhook detail page: fetch failed', err);
    return null;
  }
}

export default async function WebhookDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const webhook = await getWebhook(id);
  if (!webhook) notFound();

  return (
    <div className="space-y-8">
      <nav className="text-muted-foreground text-xs">
        <Link href="/admin/orchestration" className="hover:underline">
          AI Orchestration
        </Link>
        {' / '}
        <Link href="/admin/orchestration/webhooks" className="hover:underline">
          Webhooks
        </Link>
        {' / '}
        <span>Edit</span>
      </nav>

      <WebhookForm mode="edit" webhook={webhook} />

      <div className="flex items-center gap-4 rounded-lg border p-4">
        <div className="flex-1 space-y-0.5">
          <p className="text-sm font-medium">Test connectivity</p>
          <p className="text-muted-foreground text-xs">
            Send a <code>ping</code> event to verify your endpoint is reachable and responding.
          </p>
        </div>
        <WebhookTestButton webhookId={webhook.id} />
      </div>

      <hr />

      <WebhookDeliveries webhookId={webhook.id} />
    </div>
  );
}
