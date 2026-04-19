import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { WebhookForm } from '@/components/admin/orchestration/webhook-form';
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

      <hr />

      <WebhookDeliveries webhookId={webhook.id} />
    </div>
  );
}
