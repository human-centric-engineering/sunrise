/**
 * The seal on a backup's `exportedAt` (§122 t-902).
 *
 * A backup import strips the people erased since its copy was taken, and keeps
 * anyone erased earlier whom the copy still names: an admin re-added them on
 * purpose. That needs `exportedAt` to be the moment **this install** took the
 * copy. The date alone cannot say so. A bundle exported from a staging copy
 * that never ran an erasure, or one whose date was edited, would bring the
 * person back unannounced (code review, owner ruling 2026-10-23).
 *
 * So the exporter seals `exportedAt` with an HMAC keyed by this install's
 * `BETTER_AUTH_SECRET`, and the importer trusts the date only when the seal
 * verifies. Anything else, whether unsealed, sealed by another install, or
 * sealed over a different date, counts every erasure, as imports did before
 * t-902.
 *
 * The signed bytes start with {@link SEAL_TYPE}, as `approval-tokens.ts` and
 * `lib/storage/access-tokens.ts` carry their own: all three use the same
 * secret, and the tag keeps a MAC minted for one from verifying as another.
 *
 * An install that shares its secret with another (a staging copy configured
 * from production's environment) shares its seals too. Give each environment
 * its own secret; nothing here can tell two installs with one key apart.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { env } from '@/lib/env';

/** Scheme tag inside the signed bytes. Changing it unseals every bundle already exported. */
const SEAL_TYPE = 'orchestration-backup-exported-at';

function mac(exportedAt: string): Buffer {
  return createHmac('sha256', env.BETTER_AUTH_SECRET)
    .update(`${SEAL_TYPE}\n${exportedAt}`, 'utf8')
    .digest();
}

/** The seal the exporter writes beside `exportedAt`. */
export function sealExportedAt(exportedAt: string): string {
  return mac(exportedAt).toString('base64url');
}

/** Whether `seal` is this install's seal over exactly `exportedAt`. */
export function isSealedByThisInstall(exportedAt: string, seal: string | undefined): boolean {
  if (!seal) return false;
  const given = Buffer.from(seal, 'base64url');
  const expected = mac(exportedAt);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
