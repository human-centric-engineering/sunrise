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
  listOrgAuditLogQuerySchema,
  MAX_METERS,
  meterKeySchema,
  meterLimitSchema,
  orgMeterLimitsInputSchema,
  orgMeterLimitsSchema,
  orgPrivacySettingsSchema,
  orgSettingsPatchSchema,
  orgIdSchema,
  orgMemberParamsSchema,
  orgProviderPolicyInputSchema,
  orgProviderPolicySchema,
  jurisdictionSchema,
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

describe('jurisdictionSchema (§120 t-742)', () => {
  it('upper-cases a code, so a match never turns on case', () => {
    expect(jurisdictionSchema.parse(' eu-de ')).toBe('EU-DE');
  });

  it('refuses something that is not a short code', () => {
    for (const bad of ['', '1EU', 'E U', 'x'.repeat(33)]) {
      expect(jurisdictionSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('orgProviderPolicySchema — the stored slice (§120 t-742)', () => {
  it('holds provider row ids, folding duplicates in both lists', () => {
    expect(
      orgProviderPolicySchema.parse({
        approved: ['cmprov1', 'cmprov1', 'cmprov2'],
        jurisdictions: ['eu', 'EU'],
      })
    ).toEqual({ approved: ['cmprov1', 'cmprov2'], jurisdictions: ['EU'] });
  });

  it('accepts an empty approved set, and no restriction as absent or null', () => {
    expect(orgProviderPolicySchema.parse({ approved: [] })).toEqual({ approved: [] });
    expect(orgProviderPolicySchema.parse({ approved: [], jurisdictions: null })).toEqual({
      approved: [],
      jurisdictions: null,
    });
  });

  it('refuses an empty restriction and an unknown key — the read fails closed on both', () => {
    expect(orgProviderPolicySchema.safeParse({ approved: [], jurisdictions: [] }).success).toBe(
      false
    );
    expect(orgProviderPolicySchema.safeParse({ approved: [], extra: true }).success).toBe(false);
  });
});

describe('orgProviderPolicyInputSchema — the PUT body (§120 t-742)', () => {
  it('names providers by slug, folding duplicates', () => {
    expect(
      orgProviderPolicyInputSchema.parse({ approved: ['a', 'a', 'b'], jurisdictions: null })
    ).toEqual({ approved: ['a', 'b'], jurisdictions: null });
  });

  it('requires jurisdictions to be stated, as a list or null', () => {
    expect(orgProviderPolicyInputSchema.safeParse({ approved: ['a'] }).success).toBe(false);
  });

  it('refuses a non-slug, an empty restriction and an unknown key', () => {
    expect(
      orgProviderPolicyInputSchema.safeParse({ approved: ['Not A Slug'], jurisdictions: null })
        .success
    ).toBe(false);
    expect(
      orgProviderPolicyInputSchema.safeParse({ approved: [], jurisdictions: [] }).success
    ).toBe(false);
    expect(orgProviderPolicyInputSchema.safeParse({ approved: [], extra: 1 }).success).toBe(false);
  });
});

describe('meter limits (§135 t-1035)', () => {
  it('takes a meter key in the switch-key spelling and nothing else', () => {
    expect(meterKeySchema.safeParse('completed_conversations').success).toBe(true);
    expect(meterKeySchema.safeParse('seats').success).toBe(true);
    for (const bad of ['', 'Seats', 'lead-gen', '1seats', '_seats', 'a'.repeat(49)]) {
      expect(meterKeySchema.safeParse(bad).success).toBe(false);
    }
  });

  it('takes a limit that is a whole number from 0 to a billion', () => {
    for (const ok of [0, 1, 1_000_000_000]) expect(meterLimitSchema.parse(ok)).toBe(ok);
    for (const bad of [-1, 1.5, 1_000_000_001, Number.NaN, '3', null]) {
      expect(meterLimitSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('stores limits by meter key, refusing a bad key, a bad limit, or more than 1000 keys', () => {
    expect(orgMeterLimitsSchema.parse({ seats: 5, reports: 0 })).toEqual({ seats: 5, reports: 0 });
    expect(orgMeterLimitsSchema.safeParse({ Seats: 5 }).success).toBe(false);
    expect(orgMeterLimitsSchema.safeParse({ seats: -1 }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`m${i}`, 1]));
    expect(orgMeterLimitsSchema.safeParse(many).success).toBe(false);
    delete many.m1000;
    expect(orgMeterLimitsSchema.safeParse(many).success).toBe(true);
  });

  it('takes a PATCH naming at least one meter, null to clear, and nothing else', () => {
    expect(orgMeterLimitsInputSchema.parse({ limits: { seats: 3, reports: null } })).toEqual({
      limits: { seats: 3, reports: null },
    });
    expect(orgMeterLimitsInputSchema.safeParse({ limits: {} }).success).toBe(false);
    expect(orgMeterLimitsInputSchema.safeParse({}).success).toBe(false);
    expect(orgMeterLimitsInputSchema.safeParse({ limits: { seats: 1 }, extra: 1 }).success).toBe(
      false
    );
    // Bounded by what can be stored, not what can be registered, so clearing
    // every kept limit is one request.
    const tooMany = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`m${i}`, null]));
    expect(orgMeterLimitsInputSchema.safeParse({ limits: tooMany }).success).toBe(false);
    const most = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`m${i}`, null]));
    expect(orgMeterLimitsInputSchema.safeParse({ limits: most }).success).toBe(true);
    expect(MAX_METERS).toBeLessThan(1000);
  });
});

describe('org settings boundaries', () => {
  it('keeps one of each protected term, whatever its case', () => {
    const parsed = orgPrivacySettingsSchema.parse({
      minimumMode: null,
      protectedTerms: [
        { type: 'PERSON', value: 'Ada Lovelace' },
        { type: 'PERSON', value: 'ada lovelace' },
        { type: 'ORG', value: 'Ada Lovelace' },
      ],
    });
    expect(parsed.protectedTerms).toEqual([
      { type: 'PERSON', value: 'Ada Lovelace' },
      { type: 'ORG', value: 'Ada Lovelace' },
    ]);
  });

  it('refuses a settings PATCH that names no slice', () => {
    expect(orgSettingsPatchSchema.safeParse({}).success).toBe(false);
    expect(orgSettingsPatchSchema.safeParse({ quotas: null }).success).toBe(true);
  });

  it('reads an entity-type filter as a list, and an empty one as no filter', () => {
    expect(
      listOrgAuditLogQuerySchema.parse({ entityType: ' agent, ,workflow ' }).entityType
    ).toEqual(['agent', 'workflow']);
    expect(listOrgAuditLogQuerySchema.parse({ entityType: '' }).entityType).toBeUndefined();
  });
});
