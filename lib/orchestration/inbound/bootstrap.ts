/**
 * Inbound adapter bootstrap.
 *
 * Imported once from the inbound route at module level — auto-registers any
 * adapter whose env vars are configured. No env vars set → no registration →
 * route returns 404 for that channel. This mirrors the OTEL pattern: the
 * primitive ships, presence of config decides activation.
 *
 * Channels:
 *   - `hmac`     — always registered (per-trigger secrets in DB; no env vars)
 *   - `postmark` — registered only when both POSTMARK_INBOUND_USER and
 *                  POSTMARK_INBOUND_PASS are set (and non-empty)
 *   - `slack`    — registered only when SLACK_SIGNING_SECRET is set
 *
 * Tests call `resetInboundAdapters()` between cases; production code never does.
 */

import { logger } from '@/lib/logging';
import { GenericHmacAdapter } from '@/lib/orchestration/inbound/adapters/generic-hmac';
import { PostmarkAdapter } from '@/lib/orchestration/inbound/adapters/postmark';
import { SlackAdapter } from '@/lib/orchestration/inbound/adapters/slack';
import { registerInboundAdapter } from '@/lib/orchestration/inbound/registry';

let bootstrapped = false;

/**
 * Idempotent bootstrap. Safe to call from multiple route entry points; only
 * the first call has effect. Logs which channels registered so dev hot-reload
 * trails are easy to follow.
 */
export function bootstrapInboundAdapters(): void {
  if (bootstrapped) return;
  bootstrapped = true;

  const enabled: string[] = [];

  registerInboundAdapter(new GenericHmacAdapter());
  enabled.push('hmac');

  const postmarkUser = process.env.POSTMARK_INBOUND_USER;
  const postmarkPass = process.env.POSTMARK_INBOUND_PASS;
  if (postmarkUser && postmarkPass) {
    registerInboundAdapter(new PostmarkAdapter(postmarkUser, postmarkPass));
    enabled.push('postmark');
  }

  const slackSecret = process.env.SLACK_SIGNING_SECRET;
  if (slackSecret) {
    registerInboundAdapter(new SlackAdapter(slackSecret));
    enabled.push('slack');
  }

  logger.info('Inbound adapters registered', { channels: enabled });
}

/** Tests only — re-enable bootstrap after `resetInboundAdapters()`. */
export function resetBootstrapState(): void {
  bootstrapped = false;
}
