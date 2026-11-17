/**
 * Tests: lib/privacy/adapters/policy.ts — combining policies so they only get
 * stricter (§127 t-988).
 */
import { describe, expect, it } from 'vitest';
import {
  confidentialStrictness,
  modeStrictness,
  privacyPolicyPatchSchema,
  stricterConfidentialPolicy,
  tightenPolicy,
} from '@/lib/privacy/adapters/policy';
import {
  CONFIDENTIAL_POLICIES_BY_STRICTNESS,
  PRIVACY_MODES_BY_STRICTNESS,
  type PrivacyPolicy,
} from '@/lib/privacy/adapters/types';

const BASE: PrivacyPolicy = {
  mode: 'detect',
  ignoredEntityTypes: ['DATE', 'LOCATION'],
  protectLocalProviders: false,
  onDetectorFailure: 'fallback',
  confidentialPersonal: 'allow',
  confidentialCommercial: 'allow',
};

describe('tightenPolicy', () => {
  it.each(
    PRIVACY_MODES_BY_STRICTNESS.flatMap((a) => PRIVACY_MODES_BY_STRICTNESS.map((b) => [a, b]))
  )('from %s, a patch of %s keeps the stricter mode', (current, patch) => {
    const result = tightenPolicy({ ...BASE, mode: current }, { mode: patch });
    expect(modeStrictness(result.mode)).toBe(
      Math.max(modeStrictness(current), modeStrictness(patch))
    );
  });

  it('can stop ignoring a type but never start', () => {
    expect(tightenPolicy(BASE, { ignoredEntityTypes: ['DATE'] }).ignoredEntityTypes).toEqual([
      'DATE',
    ]);
    expect(
      tightenPolicy(BASE, { ignoredEntityTypes: ['DATE', 'LOCATION', 'PERSON'] }).ignoredEntityTypes
    ).toEqual(['DATE', 'LOCATION']);
    expect(tightenPolicy(BASE, { ignoredEntityTypes: [] }).ignoredEntityTypes).toEqual([]);
  });

  it('can turn protection of local providers on but not off', () => {
    expect(tightenPolicy(BASE, { protectLocalProviders: true }).protectLocalProviders).toBe(true);
    const on = { ...BASE, protectLocalProviders: true };
    expect(tightenPolicy(on, { protectLocalProviders: false }).protectLocalProviders).toBe(true);
  });

  it('can make a detector failure block but not fall back', () => {
    expect(tightenPolicy(BASE, { onDetectorFailure: 'block' }).onDetectorFailure).toBe('block');
    const blocking = { ...BASE, onDetectorFailure: 'block' as const };
    expect(tightenPolicy(blocking, { onDetectorFailure: 'fallback' }).onDetectorFailure).toBe(
      'block'
    );
  });

  it('leaves out what the patch leaves out', () => {
    expect(tightenPolicy(BASE, {})).toEqual(BASE);
  });
});

describe('privacyPolicyPatchSchema', () => {
  it('accepts a partial policy', () => {
    expect(privacyPolicyPatchSchema.safeParse({ mode: 'redact' }).success).toBe(true);
  });

  it.each([
    ['an unknown mode', { mode: 'mask' }],
    ['a misspelt field, which would be a tightening that did nothing', { modes: 'block' }],
    ['an invalid entity type', { ignoredEntityTypes: ['date'] }],
    ['a non-boolean flag', { protectLocalProviders: 'yes' }],
    ['something that is not an object', 'block'],
  ])('refuses %s', (_name, patch) => {
    expect(privacyPolicyPatchSchema.safeParse(patch).success).toBe(false);
  });
});

describe('the confidential-content policies (§130 t-1037)', () => {
  it('ranks them allow < warn < approved_only < local_only < block', () => {
    expect(CONFIDENTIAL_POLICIES_BY_STRICTNESS.map(confidentialStrictness)).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(stricterConfidentialPolicy('local_only', 'warn')).toBe('local_only');
    expect(stricterConfidentialPolicy('warn', 'block')).toBe('block');
  });

  it('tightens each group on its own, and never loosens either', () => {
    const strict = { ...BASE, confidentialPersonal: 'local_only' as const };
    expect(
      tightenPolicy(strict, {
        confidentialPersonal: 'warn',
        confidentialCommercial: 'approved_only',
      })
    ).toMatchObject({
      confidentialPersonal: 'local_only',
      confidentialCommercial: 'approved_only',
    });
    expect(tightenPolicy(strict, { confidentialPersonal: 'block' }).confidentialPersonal).toBe(
      'block'
    );
    // A field the patch leaves out is unchanged.
    expect(tightenPolicy(strict, { mode: 'block' }).confidentialPersonal).toBe('local_only');
  });

  it('are part of a patch a resolver may return, and nothing else is', () => {
    expect(privacyPolicyPatchSchema.safeParse({ confidentialCommercial: 'block' }).success).toBe(
      true
    );
    expect(privacyPolicyPatchSchema.safeParse({ confidentialPersonal: 'ask_first' }).success).toBe(
      false
    );
    expect(privacyPolicyPatchSchema.safeParse({ confidentialMedical: 'block' }).success).toBe(
      false
    );
  });
});
