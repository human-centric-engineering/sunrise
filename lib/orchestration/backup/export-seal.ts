/**
 * The seal on a backup's `exportedAt` (§122 t-902).
 *
 * A backup import strips the people erased since its copy was taken, and keeps
 * anyone erased earlier whom the copy still names: an admin re-added them on
 * purpose. That needs `exportedAt` to be the moment **this install** took the
 * copy, of **these** contacts, for **this** org. The date alone cannot say
 * so. A bundle exported from a staging copy that never ran an erasure, one
 * whose date or addresses were edited, or one taken in another org would
 * bring the person back unannounced (code review, owner ruling 2026-10-23).
 *
 * So the exporter seals, with an HMAC keyed by this install's
 * `BETTER_AUTH_SECRET`:
 *
 *   • `exportedAt`;
 *   • the org it exported, which the import must target;
 *   • every contact address the bundle carries ({@link bundleContacts}):
 *     the email subscriptions' and the escalation list's, normalised and
 *     sorted. An address added to the bundle afterwards breaks the seal.
 *
 * The importer trusts the date only when the seal verifies against all three
 * ({@link trustedExportedAt}). Anything else counts every erasure, as imports
 * did before t-902.
 *
 * Workflow definitions are not sealed: the importer holds them to every
 * erasure until t-900 whatever the seal says.
 *
 * The signed bytes start with {@link SEAL_TYPE}, as `approval-tokens.ts` and
 * `lib/storage/access-tokens.ts` carry their own: all three use the same
 * secret, and the tag keeps a MAC minted for one from verifying as another.
 * The fields follow as one JSON array, so no value can be read as another.
 *
 * An install that shares its secret with another (a staging copy configured
 * from production's environment) shares its seals too. Give each environment
 * its own secret; nothing here can tell two installs with one key apart.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { env } from '@/lib/env';
import { isRecord } from '@/lib/utils';
import { normaliseAddress } from '@/lib/orchestration/webhooks/destination';

/** Scheme tag inside the signed bytes. Changing it unseals every bundle already exported. */
const SEAL_TYPE = 'orchestration-backup-exported-at';

/** What a seal vouches for. */
export interface SealedFacts {
  exportedAt: string;
  orgId: string;
  /** The bundle's contact addresses, as {@link bundleContacts} reads them. */
  contacts: readonly string[];
}

/** The parts of a bundle {@link bundleContacts} reads. */
interface ContactSource {
  webhooks: ReadonlyArray<{ channel?: string | null; emailAddress?: string | null }>;
  settings?: { escalationConfig: unknown } | null;
}

/**
 * Every contact address a bundle carries: its email subscriptions', and its
 * escalation list's when it has settings. Read from the bundle as it stands,
 * whatever part an import writes, so exporter and importer seal the same list.
 */
export function bundleContacts(data: ContactSource): string[] {
  const contacts: string[] = [];
  for (const wh of data.webhooks) {
    if (wh.channel === 'email' && wh.emailAddress) contacts.push(wh.emailAddress);
  }
  contacts.push(...escalationAddresses(data.settings?.escalationConfig));
  return contacts;
}

/** The escalation list's addresses; non-strings are skipped, as the importer skips them. */
export function escalationAddresses(config: unknown): string[] {
  if (!isRecord(config) || !Array.isArray(config.emailAddresses)) return [];
  return config.emailAddresses.filter((a): a is string => typeof a === 'string');
}

function mac({ exportedAt, orgId, contacts }: SealedFacts): Buffer {
  const addresses = [...new Set(contacts.map(normaliseAddress))].sort();
  return createHmac('sha256', env.BETTER_AUTH_SECRET)
    .update(`${SEAL_TYPE}\n${JSON.stringify([exportedAt, orgId, addresses])}`, 'utf8')
    .digest();
}

/** The seal the exporter writes beside `exportedAt`. */
export function sealExport(facts: SealedFacts): string {
  return mac(facts).toString('base64url');
}

/** Whether `seal` is this install's seal over exactly `facts`. */
export function isSealedByThisInstall(facts: SealedFacts, seal: string | undefined): boolean {
  if (!seal) return false;
  const given = Buffer.from(seal, 'base64url');
  const expected = mac(facts);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * When a bundle's copy was taken, for the import into `orgId`, or `undefined`
 * to count every erasure: only a date this install sealed, over this org and
 * the bundle's contacts as they stand. A sealed date ahead of `now` is this
 * install's own clock having moved back, and is clamped to `now`.
 */
export function trustedExportedAt(
  bundle: { exportedAt: string; exportSeal?: string; data: ContactSource },
  orgId: string,
  now: Date
): Date | undefined {
  const facts = { exportedAt: bundle.exportedAt, orgId, contacts: bundleContacts(bundle.data) };
  if (!isSealedByThisInstall(facts, bundle.exportSeal)) return undefined;
  const at = Date.parse(bundle.exportedAt);
  if (Number.isNaN(at)) return undefined;
  return new Date(Math.min(at, now.getTime()));
}
