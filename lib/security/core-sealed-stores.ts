/**
 * Sunrise's own sealed stores (§137): every place core keeps a value sealed
 * with `sealSecret()`, registered with the reseal walk ahead of any fork's.
 *
 * Add a store here in the same change that starts sealing values into it.
 * Missing from this list, its values would never be moved onto a new master
 * key, and removing the old key would make them unreadable.
 *
 * A list of its own so the walk's tests can replace it; the stores themselves
 * live beside the code that writes them.
 *
 * Tenancy posture: no-tenant-data — a constant list of code
 * (lib/tenancy/process-state.ts).
 *
 * @see lib/security/sealed-stores.ts — the walk
 */

import { orgProviderKeySealedStore } from '@/lib/orchestration/llm/org-provider-keys';
import type { SealedStore } from '@/lib/security/sealed-stores';

export const CORE_SEALED_STORES: readonly SealedStore[] = [orgProviderKeySealedStore];
