'use client';

/**
 * EventSubscriptionsTabs
 *
 * URL-synced tabs that switch the Event Subscriptions surface between
 * the active subscription list and the cross-subscription dead-letter
 * queue. Both tabs are server-seeded so deep linking
 * (`?tab=dlq`) renders without a client-side fetch flash.
 *
 * Tab state lives in the URL (`?tab=...`) via `useUrlTabs`, matching
 * the user-management tabs pattern — clicking the sidebar resets to
 * the default tab and browser back/forward navigates between tabs.
 */

import type { ReactElement } from 'react';

import { Badge } from '@/components/ui/badge';
import { FieldHelp } from '@/components/ui/field-help';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  WebhooksTable,
  type WebhookListItem,
} from '@/components/admin/orchestration/webhooks-table';
import { WebhookDlqTable } from '@/components/admin/orchestration/webhook-dlq-table';
import { useUrlTabs } from '@/lib/hooks/use-url-tabs';
import type { PaginationMeta } from '@/types/api';

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

interface DlqSubscriptionOption {
  id: string;
  url: string;
  description: string | null;
}

export interface EventSubscriptionsTabsProps {
  webhooks: WebhookListItem[];
  webhooksMeta: PaginationMeta;
  dlqDeliveries: DlqDelivery[];
  dlqMeta: PaginationMeta;
  dlqSubscriptions: DlqSubscriptionOption[];
}

const ALLOWED_TABS = ['subscriptions', 'dlq'] as const;
type EventSubscriptionsTab = (typeof ALLOWED_TABS)[number];

export function EventSubscriptionsTabs({
  webhooks,
  webhooksMeta,
  dlqDeliveries,
  dlqMeta,
  dlqSubscriptions,
}: EventSubscriptionsTabsProps): ReactElement {
  const { activeTab, setActiveTab } = useUrlTabs<EventSubscriptionsTab>({
    defaultTab: 'subscriptions',
    allowedTabs: ALLOWED_TABS,
  });

  return (
    <Tabs
      value={activeTab}
      onValueChange={(v) => setActiveTab(v as EventSubscriptionsTab)}
      className="space-y-4"
    >
      <TabsList>
        <TabsTrigger value="subscriptions">
          Subscriptions
          {webhooksMeta.total > 0 && (
            <Badge variant="secondary" className="ml-2 px-1.5 text-[10px]">
              {webhooksMeta.total}
            </Badge>
          )}
        </TabsTrigger>
        <TabsTrigger value="dlq">
          Dead Letter Queue
          {dlqMeta.total > 0 && (
            <Badge variant="destructive" className="ml-2 px-1.5 text-[10px]">
              {dlqMeta.total}
            </Badge>
          )}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="subscriptions">
        <WebhooksTable initialWebhooks={webhooks} initialMeta={webhooksMeta} />
      </TabsContent>

      <TabsContent value="dlq">
        <p className="text-muted-foreground mb-4 flex items-center gap-1.5 text-sm">
          <span>
            Exhausted webhook deliveries across all subscriptions you own. Retry once the receiver
            is fixed, or discard rows you&apos;ve already reviewed.
          </span>
          <FieldHelp title="Dead letter queue overview" contentClassName="w-96">
            <p>
              When a webhook delivery fails enough times to hit the subscription&apos;s{' '}
              <code>maxAttempts</code> limit, Sunrise stops retrying and parks it here. Nothing is
              dropped — the row stays until you retry it, discard it, or the retention sweep removes
              it.
            </p>
            <p className="text-foreground mt-2 font-medium">Common actions</p>
            <ul className="mt-1 list-disc space-y-1 pl-4">
              <li>
                <span className="font-medium">Retry</span> — re-dispatch a single delivery once
                you&apos;ve fixed the receiver.
              </li>
              <li>
                <span className="font-medium">Discard</span> — delete a delivery you&apos;ve already
                reviewed and don&apos;t need to keep.
              </li>
              <li>
                <span className="font-medium">Bulk replay</span> — re-dispatch every exhausted row
                for the selected subscription (or every row visible on the current page).
              </li>
            </ul>
          </FieldHelp>
        </p>
        <WebhookDlqTable
          initialDeliveries={dlqDeliveries}
          initialMeta={dlqMeta}
          subscriptions={dlqSubscriptions}
        />
      </TabsContent>
    </Tabs>
  );
}
