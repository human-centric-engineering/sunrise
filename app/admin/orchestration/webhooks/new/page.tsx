import type { Metadata } from 'next';
import Link from 'next/link';

import { WebhookForm } from '@/components/admin/orchestration/webhook-form';

export const metadata: Metadata = {
  title: 'New Webhook · AI Orchestration',
  description: 'Create a new webhook subscription.',
};

export default function NewWebhookPage() {
  return (
    <div className="space-y-6">
      <nav className="text-muted-foreground text-xs">
        <Link href="/admin/orchestration" className="hover:underline">
          AI Orchestration
        </Link>
        {' / '}
        <Link href="/admin/orchestration/webhooks" className="hover:underline">
          Webhooks
        </Link>
        {' / '}
        <span>New</span>
      </nav>

      <WebhookForm mode="create" />
    </div>
  );
}
