/**
 * Which words an org admin reads for each state of their org's AI keys
 * (§137 t-1045). One place, so the badge and the sentence beside it never
 * disagree, and a test can hold every state the API reports to a sentence.
 * The words are in the catalogue under `admin.providerKeys` (§138 t-1074);
 * this picks the key.
 */

import type { OrgProviderKeyState } from '@/lib/orchestration/llm/org-provider-keys';
import type { ProviderKeyView, SaveBlocked } from '@/lib/orchestration/llm/org-provider-key-admin';

/** A saved key's state, as `GET /api/v1/orgs/[id]/provider-keys` reports it. */
export type ProviderKeyState = OrgProviderKeyState;

/** Why the viewer cannot save a key, as the same route reports it. */
export type ProviderKeySaveBlocked = NonNullable<SaveBlocked>;

/**
 * One provider as the list route returns it: the server's
 * {@link ProviderKeyView}, with its date as the JSON string it arrives as.
 * Derived, so a field added or renamed there is a type error here.
 */
export type ProviderKeyRow = Omit<ProviderKeyView, 'key'> & {
  key: (Omit<NonNullable<ProviderKeyView['key']>, 'savedAt'> & { savedAt: string }) | null;
};

/** The catalogue key for a provider's badge (`admin.providerKeys.badge.*`). */
export type ProviderKeyBadgeKey = 'platform' | ProviderKeyState;

/** The badge's label key, and whether it reads as a problem. */
export function stateBadge(row: ProviderKeyRow): { key: ProviderKeyBadgeKey; problem: boolean } {
  if (!row.key) return { key: 'platform', problem: false };
  return { key: row.key.state, problem: row.key.state !== 'in_use' };
}

/** The catalogue key for a state's sentence (`admin.providerKeys.state.*`). */
export type ProviderKeyStateKey = 'noKey' | ProviderKeyState | 'will_not_open_no_master';

/**
 * Which sentence says what the state means for this organisation's calls to
 * the provider; each takes the provider's `name`. `masterKeyMissing`: no
 * saved key opens because the platform has no master key, which saving again
 * cannot fix.
 */
export function stateSentenceKey(
  row: ProviderKeyRow,
  { masterKeyMissing = false }: { masterKeyMissing?: boolean } = {}
): ProviderKeyStateKey {
  if (!row.key) return 'noKey';
  if (row.key.state === 'will_not_open' && masterKeyMissing) return 'will_not_open_no_master';
  return row.key.state;
}
