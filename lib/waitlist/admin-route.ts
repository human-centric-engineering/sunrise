/**
 * What every admin waitlist route shares (§125 t-976).
 */

import { NotFoundError } from '@/lib/api/errors';
import type { RouteOwnership } from '@/lib/auth/guards';
import { getWaitlistConfig, type ResolvedWaitlistConfig } from '@/lib/waitlist/config';

/**
 * The config, or a 404: with the scaffold empty the app has no waitlist, and
 * its admin routes answer as if they did not exist — the public route's rule.
 */
export function requireWaitlistConfig(): ResolvedWaitlistConfig {
  const config = getWaitlistConfig();
  if (!config) throw new NotFoundError('Not found');
  return config;
}

/**
 * The `ownership` every admin waitlist route declares. `tier: 'org'` is written
 * inline at each call site: the roster scan reads it there.
 */
export const WAITLIST_ADMIN_OWNERSHIP: RouteOwnership = {
  decidedBy: 'nothing',
  because:
    'A waitlist is the org’s list of people waiting for it, not any admin’s personal rows; row isolation bounds it to the entered org.',
};
