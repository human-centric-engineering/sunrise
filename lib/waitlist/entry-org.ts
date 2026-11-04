/**
 * Entering the org a waitlist entry belongs to, from a link that names it
 * (§125 t-977).
 *
 * A confirm or leave link names an entry, not a principal, so nothing has
 * entered an org when its route runs. The entry is tenant-owned, so the one
 * read that learns its org runs under `runAsCredentialLookup`; the org then
 * goes through `resolveCredentialOrg` — the rule every credential's org does,
 * so a suspended org's links stop working as its members' sessions do — and
 * the rest runs inside `runAsOrg`. The shape is `runAsExecutionOrg`'s
 * (`lib/orchestration/approval-route-helpers.ts`).
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { runAsCredentialLookup, runAsOrg } from '@/lib/tenancy/context';
import { isOrgRefusal, resolveCredentialOrg } from '@/lib/tenancy/entry';

/**
 * Run `fn` inside the entry's org. `{ found: false }` when no entry has that
 * id (`missing`) or its org cannot be entered (`refused`). Confirm answers
 * both as an unusable link; leave tells them apart, because an entry it could
 * not reach is still there.
 */
export async function runAsWaitlistEntryOrg<T>(
  entryId: string,
  fn: () => Promise<T>
): Promise<{ found: true; value: T } | { found: false; reason: 'missing' | 'refused' }> {
  const entry = await runAsCredentialLookup('waitlist-link', () =>
    prisma.waitlistEntry.findUnique({
      where: { id: entryId },
      select: { orgId: true, org: { select: { status: true } } },
    })
  );
  if (!entry) return { found: false, reason: 'missing' };
  const org = resolveCredentialOrg(
    { orgId: entry.orgId, orgStatus: entry.org?.status ?? null },
    'waitlist-link'
  );
  if (isOrgRefusal(org)) {
    logger.warn('Waitlist link: the entry cannot enter its org', { entryId, refused: org.refused });
    return { found: false, reason: 'refused' };
  }
  const value = await runAsOrg(org.orgId, fn, { source: org.source });
  return { found: true, value };
}
