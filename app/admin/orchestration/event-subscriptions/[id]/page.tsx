import type { Metadata } from 'next';
import Link from 'next/link';

import { WebhookForm } from '@/components/admin/orchestration/webhook-form';
import { WebhookTestButton } from '@/components/admin/orchestration/webhook-test-button';
import { WebhookDeliveries } from '@/components/admin/orchestration/webhook-deliveries';
import { API } from '@/lib/api/endpoints';
import { requireServerData } from '@/lib/api/server-load';

export const metadata: Metadata = {
  title: 'Edit Event Subscription · AI Orchestration',
  description: 'Edit webhook subscription and view delivery history.',
};

interface WebhookDetail {
  id: string;
  channel: 'webhook' | 'email';
  url: string | null;
  emailAddress: string | null;
  events: string[];
  agentIds: string[];
  workflowIds: string[];
  isActive: boolean;
  description: string | null;
  maxAttempts: number;
  retryBackoffMs: number[];
  createdAt: string;
  updatedAt: string;
  /** Sent back as If-Match by the edit form's save (§122 t-899). */
  version: string;
}

export default async function WebhookDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // A 404 is a missing subscription; any other failure reaches the error boundary.
  const { data: webhook } = await requireServerData<WebhookDetail>(
    API.ADMIN.ORCHESTRATION.webhookById(id),
    { notFound: true }
  );

  return (
    <div className="space-y-8">
      <nav className="text-muted-foreground text-xs">
        <Link href="/admin/orchestration" className="hover:underline">
          AI Orchestration
        </Link>
        {' / '}
        <Link href="/admin/orchestration/event-subscriptions" className="hover:underline">
          Event Subscriptions
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
