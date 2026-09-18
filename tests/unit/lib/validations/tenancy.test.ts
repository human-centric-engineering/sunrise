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
import {
  addOrgMemberSchema,
  createOrgSchema,
  orgIdSchema,
  orgMemberParamsSchema,
  switchOrgSchema,
  updateOrgMemberSchema,
  updateOrgSchema,
} from '@/lib/validations/tenancy';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { ORG_ID_SHAPE } from '@/lib/tenancy/resolver';
import { ORG_ADMIN_ROLE, ORG_ROLES } from '@/lib/tenancy/roles';

const CUID = 'cmjbv4i3x00003wsloputgwul';

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

describe('orgIdSchema — the URL segment (t-672)', () => {
  it('accepts the install org id and a cuid', () => {
    expect(orgIdSchema.parse(INSTALL_ORG_ID)).toBe(INSTALL_ORG_ID);
    expect(orgIdSchema.parse('cmorg000000000000000other')).toBe('cmorg000000000000000other');
  });

  it('agrees with the resolver’s ORG_ID_SHAPE, so a value that passes here is one the proxy would carry', () => {
    for (const value of [INSTALL_ORG_ID, 'acme-corp_2', 'has space', 'a/b', '', 'x'.repeat(201)]) {
      expect(orgIdSchema.safeParse(value).success, JSON.stringify(value)).toBe(
        ORG_ID_SHAPE.test(value)
      );
    }
  });

  it('the member params want a cuid for the user', () => {
    expect(orgMemberParamsSchema.safeParse({ id: INSTALL_ORG_ID, userId: CUID }).success).toBe(
      true
    );
    expect(orgMemberParamsSchema.safeParse({ id: INSTALL_ORG_ID, userId: 'install' }).success).toBe(
      false
    );
  });
});

describe('createOrgSchema', () => {
  it('accepts a slug, a trimmed name and an optional owner', () => {
    expect(createOrgSchema.parse({ slug: 'acme', name: '  Acme  ', ownerUserId: CUID })).toEqual({
      slug: 'acme',
      name: 'Acme',
      ownerUserId: CUID,
    });
    expect(createOrgSchema.parse({ slug: 'acme', name: 'Acme' })).toEqual({
      slug: 'acme',
      name: 'Acme',
    });
  });

  it.each([
    [{ slug: 'Acme', name: 'x' }],
    [{ slug: 'acme corp', name: 'x' }],
    [{ slug: '-acme', name: 'x' }],
    [{ slug: 'a'.repeat(101), name: 'x' }],
    [{ slug: 'acme', name: '' }],
    [{ slug: 'acme', name: 'x'.repeat(201) }],
    [{ slug: 'acme', name: 'x', ownerUserId: 'install' }],
  ])('rejects %j', (body) => {
    expect(createOrgSchema.safeParse(body).success).toBe(false);
  });
});

describe('updateOrgSchema', () => {
  it('accepts any one of name, slug, status', () => {
    expect(updateOrgSchema.safeParse({ name: 'Renamed' }).success).toBe(true);
    expect(updateOrgSchema.safeParse({ slug: 'renamed' }).success).toBe(true);
    expect(updateOrgSchema.safeParse({ status: 'SUSPENDED' }).success).toBe(true);
  });

  it('refuses an empty patch and an unknown status', () => {
    expect(updateOrgSchema.safeParse({}).success).toBe(false);
    expect(updateOrgSchema.safeParse({ status: 'DELETED' }).success).toBe(false);
    expect(updateOrgSchema.safeParse({ status: 'active' }).success).toBe(false);
  });
});

describe('the member bodies', () => {
  it('addOrgMemberSchema wants a cuid and an optional known role', () => {
    expect(addOrgMemberSchema.parse({ userId: CUID })).toEqual({ userId: CUID });
    expect(addOrgMemberSchema.parse({ userId: CUID, role: ORG_ADMIN_ROLE })).toEqual({
      userId: CUID,
      role: ORG_ADMIN_ROLE,
    });
    expect(addOrgMemberSchema.safeParse({ userId: CUID, role: 'ROOT' }).success).toBe(false);
    expect(addOrgMemberSchema.safeParse({ userId: 'nope' }).success).toBe(false);
  });

  it('updateOrgMemberSchema requires a known role — every one of them', () => {
    for (const role of ORG_ROLES) expect(updateOrgMemberSchema.parse({ role })).toEqual({ role });
    expect(updateOrgMemberSchema.safeParse({}).success).toBe(false);
    expect(updateOrgMemberSchema.safeParse({ role: 'owner' }).success).toBe(false);
  });
});
