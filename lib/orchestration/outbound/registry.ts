/**
 * Outbound adapter registry — single-process singleton mapping
 * `provider` slug → `OutboundAdapter`. Self-registry pattern mirrors
 * `lib/orchestration/inbound/registry.ts`.
 */

import type { OutboundAdapter } from '@/lib/orchestration/outbound/types';

const adapters = new Map<string, OutboundAdapter>();

/**
 * Register an outbound adapter. Idempotent — re-registering the same
 * provider replaces the previous instance (useful in dev hot-reload).
 */
export function registerOutboundAdapter(adapter: OutboundAdapter): void {
  adapters.set(adapter.provider, adapter);
}

export function getOutboundAdapter(provider: string): OutboundAdapter | undefined {
  return adapters.get(provider);
}

export function listOutboundProviders(): string[] {
  return [...adapters.keys()].sort();
}

/** Tests only — wipe the registry between cases. */
export function resetOutboundAdapters(): void {
  adapters.clear();
}
