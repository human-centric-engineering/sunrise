/**
 * Tests: lib/validations/tenancy.ts — the org API's request shapes (§106)
 *
 * `switchOrgSchema` is exercised end-to-end by the switch route test; this
 * pins the boundary itself, including the one choice worth a sentence: the
 * install org's id is the literal `'install'`, so the field is a non-empty
 * string and NOT `cuidSchema` — a cuid-only rule would refuse the org most
 * switches name.
 */
import { describe, it, expect } from 'vitest';
import { switchOrgSchema } from '@/lib/validations/tenancy';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

describe('switchOrgSchema', () => {
  it('accepts the install org id, which is not a cuid', () => {
    expect(switchOrgSchema.parse({ orgId: INSTALL_ORG_ID })).toEqual({ orgId: INSTALL_ORG_ID });
  });

  it('accepts a cuid', () => {
    const id = 'cmorg000000000000000other';
    expect(switchOrgSchema.parse({ orgId: id })).toEqual({ orgId: id });
  });

  it.each([
    [{}],
    [{ orgId: '' }],
    [{ orgId: 42 }],
    [{ orgId: null }],
    [{ orgId: 'x'.repeat(201) }],
  ])('rejects %j', (body) => {
    expect(switchOrgSchema.safeParse(body).success).toBe(false);
  });

  it('ignores keys it does not know, so a client cannot smuggle a user id', () => {
    const parsed = switchOrgSchema.parse({ orgId: INSTALL_ORG_ID, userId: 'someone-else' });
    expect(parsed).toEqual({ orgId: INSTALL_ORG_ID });
  });
});
