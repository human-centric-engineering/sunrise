/**
 * The words an org admin reads for each state of their org's AI keys
 * (§137 t-1045). One place, so the badge and the sentence beside it never
 * disagree, and a test can hold every state the API reports to a sentence.
 */

import type { OrgProviderKeyState } from '@/lib/orchestration/llm/org-provider-keys';
import type { SaveBlocked } from '@/lib/orchestration/llm/org-provider-key-admin';

/** A saved key's state, as `GET /api/v1/orgs/[id]/provider-keys` reports it. */
export type ProviderKeyState = OrgProviderKeyState;

/** Why the viewer cannot save a key, as the same route reports it. */
export type ProviderKeySaveBlocked = NonNullable<SaveBlocked>;

/** One provider as the list route returns it (dates as JSON strings). */
export interface ProviderKeyRow {
  providerConfigId: string;
  name: string;
  slug: string;
  approved: boolean;
  /** Whether a key can be saved or tested for the row (active, not local). */
  takesKey: boolean;
  key: {
    hint: string;
    version: number;
    savedAt: string;
    savedBy: { id: string; name: string } | null;
    state: ProviderKeyState;
  } | null;
}

/** The short label on a provider's badge, and whether it reads as a problem. */
export function stateBadge(row: ProviderKeyRow): { label: string; problem: boolean } {
  if (!row.key) return { label: 'Platform key', problem: false };
  switch (row.key.state) {
    case 'in_use':
      return { label: 'Your key, in use', problem: false };
    case 'provider_off':
      return { label: 'Not in use: provider switched off', problem: true };
    case 'switched_off':
      return { label: 'Not in use: switched off', problem: true };
    case 'not_approved':
      return { label: 'Not in use: provider not approved', problem: true };
    case 'will_not_open':
      return { label: 'Not in use: key unreadable', problem: true };
  }
}

/**
 * What the state means for this organisation's calls to the provider.
 * `masterKeyMissing`: no saved key opens because the platform has no master
 * key, which saving again cannot fix.
 */
export function stateSentence(
  row: ProviderKeyRow,
  { masterKeyMissing = false }: { masterKeyMissing?: boolean } = {}
): string {
  const name = row.name;
  if (!row.key) {
    return `No key saved. This organisation’s calls to ${name} use the platform’s key.`;
  }
  switch (row.key.state) {
    case 'in_use':
      return `This organisation’s calls to ${name} go out on your key, and are billed to your ${name} account.`;
    case 'provider_off':
      return `Platform staff have switched ${name} off on this platform, so this organisation’s calls to it are refused and the key is not used. Remove the key if you no longer need it.`;
    case 'switched_off':
      return `Organisations’ own keys are switched off on this platform, so this organisation’s calls to ${name} are refused. They work again when platform staff switch own keys back on, or when you remove this key and go back to the platform’s key.`;
    case 'not_approved':
      return `This organisation is not approved to use ${name}, so its calls to ${name} are refused and the key is not used. Platform staff approve providers.`;
    case 'will_not_open':
      return masterKeyMissing
        ? `The saved key cannot be read, because the platform has nowhere to keep keys safely, so this organisation’s calls to ${name} are refused. Platform staff need to configure it.`
        : `The saved key can no longer be read, so this organisation’s calls to ${name} are refused. Save the key again to fix this.`;
  }
}

/** Why saving is not offered, in a sentence for the top of the page. */
export const SAVE_BLOCKED_SENTENCE: Record<ProviderKeySaveBlocked, string> = {
  switched_off:
    'Organisations’ own AI keys are switched off on this platform, so a key cannot be saved here until platform staff switch them on.',
  master_key_missing:
    'The platform has nowhere to keep keys safely yet, so a key cannot be saved here. Platform staff need to configure it.',
  support_session:
    'You are working in this organisation as platform support. Support can see and test its keys, and remove one, but cannot save or replace a key.',
};

/** Why nothing can be changed here: a READ_ONLY support session. */
export const READ_ONLY_SENTENCE =
  'Your support access to this organisation is read-only: you can see its keys, but not test, replace or remove them.';

/** What a failed test means, by the reason the test route gives. */
export function testFailureSentence(name: string, reason: 'test_failed' | 'will_not_open'): string {
  return reason === 'will_not_open'
    ? 'The saved key can no longer be read. Save it again.'
    : `${name} did not accept the key, or could not be reached.`;
}
