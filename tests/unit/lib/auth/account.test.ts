import { describe, it, expect } from 'vitest';

import { humanWhere, humanAdminWhere, serviceAccountWhere } from '@/lib/auth/account';

/**
 * These predicate fragments are the single source of truth for distinguishing
 * real human users from non-login SERVICE principals. Pinning their exact shape
 * guards against accidental drift, since every admin count/list/guard depends on
 * them filtering on `accountType` (issue #278 / PR #279 review).
 */
describe('lib/auth/account predicates', () => {
  it('humanWhere matches only HUMAN accounts', () => {
    expect(humanWhere).toEqual({ accountType: 'HUMAN' });
  });

  it('humanAdminWhere matches real human admins (role + accountType)', () => {
    expect(humanAdminWhere).toEqual({ role: 'ADMIN', accountType: 'HUMAN' });
  });

  it('serviceAccountWhere matches only SERVICE accounts', () => {
    expect(serviceAccountWhere).toEqual({ accountType: 'SERVICE' });
  });
});
