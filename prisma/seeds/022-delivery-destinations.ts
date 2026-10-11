/**
 * Seed: backfill the destination on webhook and event-hook deliveries that
 * predate destination recording (§109 t-739).
 *
 * Since `20261008120000_delivery_destination`, every delivery records where it
 * was sent (`lib/orchestration/webhooks/destination.ts`) and outlives its
 * subscription or hook. Rows written before that have `destination` NULL. This
 * unit fills them from each row's CURRENT parent, while that parent still
 * exists: once it is deleted, a row with no destination says nothing about
 * where it went.
 *
 * **The best available value, not a record.** The parent may have been edited
 * since the row was sent, so what this writes is where the subscription or hook
 * points now. Rows whose parent is already gone stay NULL, which the admin UI
 * shows as "Destination not recorded".
 *
 * Not SQL in the migration, because the reduced form (the URL's origin) and the
 * keyed fingerprint are computed in application code with a key the database
 * cannot see. Runs in the system scope so it reaches every org's rows at
 * `TENANCY_MODE=multi`, including suspended orgs, which `forEachOrg` skips.
 * Idempotent: it only touches rows whose `destination` is NULL, so a re-run
 * finds nothing to do.
 */

import type { SeedUnit } from '@/prisma/runner';
import { runAsSystem } from '@/lib/tenancy/context';
import { WebhookActionSchema } from '@/lib/orchestration/hooks/types';
import {
  describeDestination,
  subscriptionDestination,
} from '@/lib/orchestration/webhooks/destination';

const unit: SeedUnit = {
  name: '022-delivery-destinations',
  async run({ prisma, logger }) {
    logger.info('📮 Backfilling webhook and event-hook delivery destinations...');

    await runAsSystem('backfill delivery destinations (§109 t-739)', async () => {
      let webhookRows = 0;
      const subscriptions = await prisma.aiWebhookSubscription.findMany({
        where: { deliveries: { some: { destination: null } } },
        select: { id: true, channel: true, url: true, emailAddress: true },
      });
      for (const sub of subscriptions) {
        const destination = subscriptionDestination(sub);
        if (!destination) continue;
        const { count } = await prisma.aiWebhookDelivery.updateMany({
          where: { subscriptionId: sub.id, destination: null },
          data: destination,
        });
        webhookRows += count;
      }

      let hookRows = 0;
      const hooks = await prisma.aiEventHook.findMany({
        where: { deliveries: { some: { destination: null } } },
        select: { id: true, action: true },
      });
      for (const hook of hooks) {
        // The same parse dispatch applies: an action that fails it was never
        // sent anywhere, so there is nothing to record.
        const action = WebhookActionSchema.safeParse(hook.action);
        if (!action.success) continue;
        const { count } = await prisma.aiEventHookDelivery.updateMany({
          where: { hookId: hook.id, destination: null },
          data: describeDestination('webhook', action.data.url),
        });
        hookRows += count;
      }

      logger.info(
        `  ✓ backfilled ${webhookRows} webhook and ${hookRows} event-hook deliveries from their current parent`
      );
    });
  },
};

export default unit;
