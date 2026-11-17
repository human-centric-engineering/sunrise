/**
 * Tests: the install-wide privacy settings as a policy, and what the settings
 * API accepts for them (§127).
 */
import { describe, expect, it } from 'vitest';
import {
  basePolicyFromSettings,
  CONFIDENTIAL_TIGHTENING_POLICIES,
  isConfidentialTighteningPolicy,
  isStoredConfidentialPolicy,
  isTighteningMode,
  parseConfidentialPolicy,
  parseTighteningConfidentialPolicy,
  parseEmbeddingsPolicy,
  parseTighteningMode,
  PRIVACY_MODE_LABELS,
  PRIVACY_TIGHTENING_MODES,
  parseIgnoredEntityTypes,
  parsePrivacyMode,
  PRIVACY_MODES_AVAILABLE,
} from '@/lib/orchestration/privacy/settings-policy';
import { updateOrchestrationSettingsSchema } from '@/lib/validations/orchestration';

describe('parsePrivacyMode', () => {
  it('accepts the five modes and nothing else', () => {
    for (const mode of ['off', 'detect', 'pseudonymise', 'redact', 'block']) {
      expect(parsePrivacyMode(mode)).toBe(mode);
    }
    for (const bad of ['pseudonymize', 'OFF', '', null, undefined, 1]) {
      expect(parsePrivacyMode(bad)).toBeNull();
    }
  });
});

describe('the modes an agent or an org can require (t-1010)', () => {
  it('are every available mode but off, in strictness order', () => {
    expect(PRIVACY_TIGHTENING_MODES).toEqual(PRIVACY_MODES_AVAILABLE.filter((m) => m !== 'off'));
  });

  it('read null and undefined as none set', () => {
    expect(parseTighteningMode(null)).toBeNull();
    expect(parseTighteningMode(undefined)).toBeNull();
  });

  it('read each mode as itself', () => {
    for (const mode of PRIVACY_TIGHTENING_MODES) expect(parseTighteningMode(mode)).toBe(mode);
  });

  it.each(['off', 'Block', 'strict', 3, {}])(
    'throw on a stored %j rather than read it as none: it may have been stricter',
    (raw) => {
      expect(() => parseTighteningMode(raw)).toThrow('stored privacy mode is not a mode');
      expect(isTighteningMode(raw)).toBe(false);
    }
  );

  it('have a label each', () => {
    for (const mode of PRIVACY_MODES_AVAILABLE) expect(PRIVACY_MODE_LABELS[mode]).toBeTruthy();
  });
});

describe('parseIgnoredEntityTypes', () => {
  it('keeps a list of type names, once each', () => {
    expect(parseIgnoredEntityTypes(['DATE', 'LOCATION', 'DATE'])).toEqual(['DATE', 'LOCATION']);
  });

  it('reads anything else as nothing ignored, the stricter reading of exclusions', () => {
    for (const bad of [null, 'DATE', { DATE: true }, ['DATE', 'lower'], ['DATE', 1]]) {
      expect(parseIgnoredEntityTypes(bad)).toEqual([]);
    }
  });
});

describe('parseEmbeddingsPolicy', () => {
  it('reads the two policies as themselves, and an absent one as the column default', () => {
    expect(parseEmbeddingsPolicy('allow')).toBe('allow');
    expect(parseEmbeddingsPolicy('local_only')).toBe('local_only');
    expect(parseEmbeddingsPolicy(undefined)).toBe('allow');
  });

  it('reads a stored value that is not a policy as local_only, the stricter', () => {
    for (const bad of ['LOCAL_ONLY', 'local', '', null, 1]) {
      expect(parseEmbeddingsPolicy(bad)).toBe('local_only');
    }
  });
});

describe('basePolicyFromSettings', () => {
  it('starts from the settings, falling back on a failed detector', () => {
    expect(
      basePolicyFromSettings({
        privacyMode: 'detect',
        privacyIgnoredEntityTypes: ['DATE'],
        privacyProtectLocalProviders: true,
        privacyConfidentialPersonal: 'warn',
        privacyConfidentialCommercial: 'approved_only',
      })
    ).toEqual({
      mode: 'detect',
      ignoredEntityTypes: ['DATE'],
      protectLocalProviders: true,
      onDetectorFailure: 'fallback',
      confidentialPersonal: 'warn',
      confidentialCommercial: 'approved_only',
    });
  });

  it('gives no policy for an unreadable mode', () => {
    expect(
      basePolicyFromSettings({
        privacyMode: null,
        privacyIgnoredEntityTypes: [],
        privacyProtectLocalProviders: false,
        privacyConfidentialPersonal: 'allow',
        privacyConfidentialCommercial: 'allow',
      })
    ).toBeNull();
  });
});

describe('the settings API', () => {
  it('accepts every mode now that each is built, and nothing else', () => {
    expect(PRIVACY_MODES_AVAILABLE).toEqual(['off', 'detect', 'pseudonymise', 'redact', 'block']);
    for (const mode of PRIVACY_MODES_AVAILABLE) {
      expect(updateOrchestrationSettingsSchema.safeParse({ privacyMode: mode }).success).toBe(true);
    }
    for (const mode of ['pseudonymize', 'nonsense']) {
      expect(updateOrchestrationSettingsSchema.safeParse({ privacyMode: mode }).success).toBe(
        false
      );
    }
  });

  it('accepts ignored types that are type names, deduplicated, and refuses others', () => {
    const ok = updateOrchestrationSettingsSchema.safeParse({
      privacyIgnoredEntityTypes: ['DATE', 'DATE', 'US_SSN'],
    });
    expect(ok.success && ok.data.privacyIgnoredEntityTypes).toEqual(['DATE', 'US_SSN']);
    expect(
      updateOrchestrationSettingsSchema.safeParse({ privacyIgnoredEntityTypes: ['date'] }).success
    ).toBe(false);
  });

  it('counts a privacy field alone as a change', () => {
    expect(
      updateOrchestrationSettingsSchema.safeParse({ privacyProtectLocalProviders: true }).success
    ).toBe(true);
    expect(
      updateOrchestrationSettingsSchema.safeParse({ privacyEmbeddingsPolicy: 'local_only' }).success
    ).toBe(true);
  });

  it('accepts the two embeddings policies and nothing else', () => {
    for (const ok of ['allow', 'local_only']) {
      expect(
        updateOrchestrationSettingsSchema.safeParse({ privacyEmbeddingsPolicy: ok }).success
      ).toBe(true);
    }
    expect(
      updateOrchestrationSettingsSchema.safeParse({ privacyEmbeddingsPolicy: 'local' }).success
    ).toBe(false);
  });
});

describe('the confidential-content policies (§130 t-1037)', () => {
  it('reads an absent install policy as allow, the upgrade fill, and one that is not a policy as block', () => {
    expect(parseConfidentialPolicy(undefined)).toBe('allow');
    expect(parseConfidentialPolicy('approved_only')).toBe('approved_only');
    expect(parseConfidentialPolicy('ask_first')).toBe('block');
    expect(parseConfidentialPolicy(null)).toBe('block');
  });

  it('lets an agent require every policy but allow, and inherit with null', () => {
    expect(CONFIDENTIAL_TIGHTENING_POLICIES).toEqual([
      'warn',
      'approved_only',
      'local_only',
      'block',
    ]);
    expect(parseTighteningConfidentialPolicy(null)).toBeNull();
    expect(parseTighteningConfidentialPolicy(undefined)).toBeNull();
    expect(parseTighteningConfidentialPolicy('local_only')).toBe('local_only');
    // Set but unknown may have been stricter: thrown, so the stage refuses.
    expect(() => parseTighteningConfidentialPolicy('allow')).toThrow();
    expect(() => parseTighteningConfidentialPolicy('ask_first')).toThrow();
    expect(isConfidentialTighteningPolicy('allow')).toBe(false);
  });

  it('exports an agent policy only when it is null or one it knows', () => {
    expect(isStoredConfidentialPolicy(null)).toBe(true);
    expect(isStoredConfidentialPolicy('block')).toBe(true);
    expect(isStoredConfidentialPolicy('ask_first')).toBe(false);
    expect(isStoredConfidentialPolicy(undefined)).toBe(false);
  });

  it('are accepted by the settings API with every value, and nothing else', () => {
    for (const policy of ['allow', 'warn', 'approved_only', 'local_only', 'block']) {
      expect(
        updateOrchestrationSettingsSchema.safeParse({ privacyConfidentialPersonal: policy }).success
      ).toBe(true);
    }
    expect(
      updateOrchestrationSettingsSchema.safeParse({ privacyConfidentialCommercial: 'ask_first' })
        .success
    ).toBe(false);
    // Either alone is a change.
    expect(
      updateOrchestrationSettingsSchema.safeParse({ privacyConfidentialCommercial: 'warn' }).success
    ).toBe(true);
  });

  it('reads an unreadable stored install policy as block in the base policy', () => {
    expect(
      basePolicyFromSettings({
        privacyMode: 'off',
        privacyIgnoredEntityTypes: [],
        privacyProtectLocalProviders: false,
        privacyConfidentialPersonal: 'garbled' as never,
        privacyConfidentialCommercial: 'allow',
      })
    ).toMatchObject({ confidentialPersonal: 'block', confidentialCommercial: 'allow' });
  });
});
