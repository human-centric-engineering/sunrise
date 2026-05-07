/**
 * Inbound adapter registry.
 *
 * Adapters self-register at module-import time when their environment is
 * configured (e.g. `SLACK_SIGNING_SECRET` set). Channels with no registered
 * adapter return 404 from the inbound route — there is no "channel disabled"
 * intermediate state, mirroring the OTEL pattern where an unset
 * `OTEL_EXPORTER_OTLP_ENDPOINT` produces no spans.
 *
 * Tests use `resetInboundAdapters()` to clear the registry between cases.
 */

import { logger } from '@/lib/logging';
import type { InboundAdapter } from '@/lib/orchestration/inbound/types';

const adapters = new Map<string, InboundAdapter>();

/**
 * Look up an adapter by channel slug. Returns `null` when no adapter is
 * registered — caller responds 404.
 */
export function getInboundAdapter(channel: string): InboundAdapter | null {
  return adapters.get(channel) ?? null;
}

/**
 * Register an adapter. Logs a warning when replacing an existing registration
 * (typically harmless under dev hot reload, but worth noticing in production
 * where it usually means double-bootstrap).
 */
export function registerInboundAdapter(adapter: InboundAdapter): void {
  if (adapters.has(adapter.channel)) {
    logger.warn('Inbound adapter already registered; replacing', {
      channel: adapter.channel,
    });
  }
  adapters.set(adapter.channel, adapter);
}

/** List currently registered channels — used by health checks and tests. */
export function listInboundChannels(): string[] {
  return [...adapters.keys()].sort();
}

/** Clear all adapters. Tests only — production code never calls this. */
export function resetInboundAdapters(): void {
  adapters.clear();
}
