/**
 * Outbound adapter bootstrap. Mirror of the inbound bootstrap.
 *
 * Idempotent — first call registers any adapter whose required env vars
 * are set; subsequent calls are no-ops. Paired with inbound bootstrap:
 * the same env vars that enable an inbound adapter also enable its
 * outbound sibling, so a deployment never ends up with mismatched
 * halves (inbound configured but no outbound, or vice versa).
 *
 * Providers:
 *   - `twilio` — when TWILIO_AUTH_TOKEN is set (same trigger as
 *                inbound). Handles SMS + Twilio-routed WhatsApp.
 *   - `meta`   — when WHATSAPP_VERIFY_TOKEN AND WHATSAPP_APP_SECRET are
 *                set (same trigger as inbound). Handles Meta-direct
 *                WhatsApp.
 *
 * Tests call `resetOutboundAdapters()` between cases.
 */

import { logger } from '@/lib/logging';
import { TwilioOutboundAdapter } from '@/lib/orchestration/outbound/adapters/twilio';
import { MetaWhatsAppOutboundAdapter } from '@/lib/orchestration/outbound/adapters/whatsapp-cloud';
import { registerOutboundAdapter } from '@/lib/orchestration/outbound/registry';

let bootstrapped = false;

export function bootstrapOutboundAdapters(): void {
  if (bootstrapped) return;
  bootstrapped = true;

  const enabled: string[] = [];

  if (process.env.TWILIO_AUTH_TOKEN) {
    registerOutboundAdapter(new TwilioOutboundAdapter());
    enabled.push('twilio');
  }

  if (process.env.WHATSAPP_VERIFY_TOKEN && process.env.WHATSAPP_APP_SECRET) {
    registerOutboundAdapter(new MetaWhatsAppOutboundAdapter());
    enabled.push('meta');
  }

  logger.info('Outbound adapters registered', { providers: enabled });
}

/** Tests only. */
export function resetOutboundBootstrapState(): void {
  bootstrapped = false;
}
