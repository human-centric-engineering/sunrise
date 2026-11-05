/**
 * The fork half of the tenancy classification (t-983, #964), against a
 * synthetic tier and the real registry.
 *
 * The fork seam is mocked here, deliberately: each case registers its own
 * fixture rows (or sets what the seam's init does) and asserts exactly what the
 * readers return, so a fork that has filled `lib/app/tenancy-classification.ts`
 * does not change their answer. The real seam is read by the coverage guard
 * (`model-classification.test.ts`) and pinned empty by
 * `tests/unit/lib/app/defaults.test.ts`.
 *
 * @see lib/tenancy/classification.ts — registerAppTenancyClassification
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const seam = vi.hoisted(() => ({ init: (): void => {} }));
vi.mock('@/lib/app/tenancy-classification', () => ({
  initAppTenancyClassification: () => seam.init(),
}));

import {
  GLOBAL_CONFIG_MODELS,
  SYSTEM_MODELS,
  USER_OWNED_MODELS,
  __resetAppTenancyClassificationForTests,
  allGlobalConfigModels,
  allSystemModels,
  allUserOwnedModels,
  appTenancyClassifications,
  classifyModels,
  registerAppTenancyClassification,
  warnAboutAppIsolationExemptions,
  type RuntimeDataModel,
} from '@/lib/tenancy/classification';
import { logger } from '@/lib/logging';

/** A runtime data model of the named models, `orgId` on those marked. */
function rdm(models: Record<string, { orgId?: boolean }>): RuntimeDataModel {
  const out: RuntimeDataModel = { models: {} };
  for (const [name, { orgId }] of Object.entries(models)) {
    out.models[name] = {
      dbName: null,
      fields: [
        { name: 'id', kind: 'scalar', type: 'String' },
        ...(orgId ? [{ name: 'orgId', kind: 'scalar' as const, type: 'String' }] : []),
      ],
    };
  }
  return out;
}

describe('tenancy classification — fork tiers', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    seam.init = () => {};
    __resetAppTenancyClassificationForTests();
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetAppTenancyClassificationForTests();
  });

  it('reads exactly core’s lists when nothing is registered', () => {
    expect(allSystemModels()).toEqual([...SYSTEM_MODELS]);
    expect(allGlobalConfigModels()).toEqual([...GLOBAL_CONFIG_MODELS]);
    expect(allUserOwnedModels()).toEqual([...USER_OWNED_MODELS]);
    expect(appTenancyClassifications().size).toBe(0);
  });

  it('classifies a registered model in the class it was registered in', () => {
    registerAppTenancyClassification({
      tier: 'app',
      system: ['AppReservedName'],
      globalConfig: ['AppLineageNode'],
      userOwned: ['AppKit'],
    });

    const result = classifyModels(
      rdm({ AppReservedName: {}, AppLineageNode: {}, AppKit: {}, AppStray: {} })
    );

    expect(result.system).toEqual(['AppReservedName']);
    expect(result.globalConfig).toEqual(['AppLineageNode']);
    expect(result.userOwned).toEqual(['AppKit']);
    expect(result.unclassified).toEqual(['AppStray']);
    expect(allGlobalConfigModels()).toContain('AppLineageNode');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('refuses to move a core model, keeping core’s class', () => {
    registerAppTenancyClassification({ tier: 'app', userOwned: ['FeatureFlag', 'Session'] });

    const result = classifyModels(rdm({ FeatureFlag: {}, Session: {} }));
    expect(result.globalConfig).toEqual(['FeatureFlag']);
    expect(result.system).toEqual(['Session']);
    expect(result.userOwned).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(
      'tenancy-classification: app classification rejected',
      expect.objectContaining({
        model: 'FeatureFlag',
        reason: 'core already classifies this model',
      })
    );
  });

  it('keeps the first tier’s class when another tier names the same model', () => {
    registerAppTenancyClassification({ tier: 'framework', userOwned: ['SharedModel'] });
    registerAppTenancyClassification({ tier: 'app', system: ['SharedModel'] });

    expect(classifyModels(rdm({ SharedModel: {} })).userOwned).toEqual(['SharedModel']);
    expect(errorSpy).toHaveBeenCalledWith(
      'tenancy-classification: app classification rejected',
      expect.objectContaining({
        tier: 'app',
        model: 'SharedModel',
        reason: "already classified by tier 'framework'",
      })
    );
  });

  it('drops a model one tier puts in two classes, leaving it unclassified for the guard to name', () => {
    registerAppTenancyClassification({
      tier: 'app',
      system: ['AppTwice'],
      userOwned: ['AppTwice'],
    });

    expect(classifyModels(rdm({ AppTwice: {} })).unclassified).toEqual(['AppTwice']);
    expect(errorSpy).toHaveBeenCalledWith(
      'tenancy-classification: app classification rejected',
      expect.objectContaining({
        model: 'AppTwice',
        reason: "listed as both 'system' and 'userOwned'",
      })
    );
  });

  it('refuses a model listed in all three classes, not just the first clash', () => {
    registerAppTenancyClassification({
      tier: 'app',
      system: ['AppThrice'],
      globalConfig: ['AppThrice'],
      userOwned: ['AppThrice'],
    });

    expect(classifyModels(rdm({ AppThrice: {} })).unclassified).toEqual(['AppThrice']);
  });

  it('keeps refusing a clashed model, from any tier, afterwards', () => {
    registerAppTenancyClassification({
      tier: 'app',
      system: ['AppTwice'],
      userOwned: ['AppTwice'],
    });
    registerAppTenancyClassification({ tier: 'framework', userOwned: ['AppTwice'] });
    registerAppTenancyClassification({ tier: 'app', userOwned: ['AppTwice'] });

    expect(appTenancyClassifications().has('AppTwice')).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      'tenancy-classification: app classification rejected',
      expect.objectContaining({
        tier: 'framework',
        model: 'AppTwice',
        reason: 'was listed in two classes; every entry for it is refused',
      })
    );
  });

  it.each([
    ['empty', ''],
    ['blank', '  '],
    ['missing', undefined],
  ])('drops a contribution whose tier is %s', (_label, tier) => {
    registerAppTenancyClassification({ tier: tier as unknown as string, userOwned: ['AppKit'] });

    expect(appTenancyClassifications().size).toBe(0);
    expect(errorSpy).toHaveBeenCalledWith(
      'tenancy-classification: app classification rejected',
      expect.objectContaining({ reason: '`tier` is required' })
    );
  });

  it('records which tier registered each model', () => {
    registerAppTenancyClassification({ tier: 'framework', system: ['FwJoin'] });
    registerAppTenancyClassification({ tier: 'app', userOwned: ['AppKit'] });

    expect(Object.fromEntries(appTenancyClassifications())).toEqual({
      FwJoin: { cls: 'system', tier: 'framework' },
      AppKit: { cls: 'userOwned', tier: 'app' },
    });
  });

  it('is idempotent for the same model in the same class', () => {
    registerAppTenancyClassification({ tier: 'app', userOwned: ['AppKit'] });
    registerAppTenancyClassification({ tier: 'app', userOwned: ['AppKit'] });

    expect(allUserOwnedModels()).toEqual(['AppKit']);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('rejects an empty name, a non-string, and a class that is not a list', () => {
    registerAppTenancyClassification({
      tier: 'app',
      system: ['  ', 42 as unknown as string, ' AppTrimmed '],
      userOwned: 'AppKit' as unknown as string[],
    });

    expect(allSystemModels()).toContain('AppTrimmed');
    expect(allUserOwnedModels()).toEqual([...USER_OWNED_MODELS]);
    const reasons = errorSpy.mock.calls.map(
      ([, ctx]: unknown[]) => (ctx as { reason: string }).reason
    );
    expect(reasons).toEqual([
      'model is empty or not a string',
      'model is empty or not a string',
      '`userOwned` must be an array of model names',
    ]);
  });

  describe('a fork system model that carries orgId', () => {
    it('leaves row isolation, and the build of the client says so once', () => {
      registerAppTenancyClassification({ tier: 'app', system: ['AppTeamJoin'] });
      const result = classifyModels(
        rdm({
          AppTeamJoin: { orgId: true },
          AppNote: { orgId: true },
          OrgMembership: { orgId: true },
        })
      );

      expect(result.tenantOwned.map((m) => m.model)).toEqual(['AppNote']);
      expect(result.systemWithOrgId).toEqual(['AppTeamJoin', 'OrgMembership']);

      warnAboutAppIsolationExemptions(result);
      warnAboutAppIsolationExemptions(result);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      // Core's own exemption (OrgMembership) is by design and not repeated in the warning.
      expect(warnSpy).toHaveBeenCalledWith(
        'tenancy-classification: fork system models carry orgId and are not row-isolated',
        expect.objectContaining({ models: ['AppTeamJoin'] })
      );
    });

    it.each([
      ['the chokepoint’s schema (readTenancySchema)', 'chokepoint'],
      ['the scripts’ roster (tenantOwnedModels)', 'roster'],
    ])('is warned about when %s is built from a client', async (_label, builder) => {
      registerAppTenancyClassification({ tier: 'app', system: ['AppTeamJoin'] });
      const client = {
        _runtimeDataModel: rdm({ AppTeamJoin: { orgId: true }, AppNote: { orgId: true } }),
        _engineConfig: { inlineSchema: 'model AppTeamJoin {\n}\nmodel AppNote {\n}\n' },
      };

      if (builder === 'chokepoint') {
        const { readTenancySchema } = await import('@/lib/db/tenancy-extension');
        expect([...readTenancySchema(client).tenantOwned]).toEqual(['AppNote']);
      } else {
        const { tenantOwnedModels } = await import('@/lib/tenancy/classification');
        expect([...tenantOwnedModels(client).keys()]).toEqual(['AppNote']);
      }

      expect(warnSpy).toHaveBeenCalledWith(
        'tenancy-classification: fork system models carry orgId and are not row-isolated',
        expect.objectContaining({ models: ['AppTeamJoin'] })
      );
    });

    it('warns about nothing when only core’s exemptions are present', () => {
      warnAboutAppIsolationExemptions(classifyModels(rdm({ OrgMembership: { orgId: true } })));
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('the seam’s init', () => {
    it('runs lazily on the first read', () => {
      seam.init = () => registerAppTenancyClassification({ tier: 'app', userOwned: ['AppKit'] });

      expect(classifyModels(rdm({ AppKit: {} })).userOwned).toEqual(['AppKit']);
    });

    it('rolls a throwing init back, so a model with orgId stays isolated', () => {
      seam.init = () => {
        registerAppTenancyClassification({ tier: 'app', system: ['AppTeamJoin'] });
        throw new Error('half-way');
      };

      const result = classifyModels(rdm({ AppTeamJoin: { orgId: true } }));
      expect(result.system).toEqual([]);
      expect(result.tenantOwned.map((m) => m.model)).toEqual(['AppTeamJoin']);
    });
  });

  it('puts a registered shared-settings model under the shared-settings scanner', async () => {
    // The scanner derives its list when it loads, so load it fresh — and
    // register through the fresh classification module it will read.
    vi.resetModules();
    const fresh = await import('@/lib/tenancy/classification');
    seam.init = () =>
      fresh.registerAppTenancyClassification({ tier: 'app', globalConfig: ['AppLineageNode'] });

    const scanner = await import('@/scripts/ci/shared-settings-writes');

    expect(scanner.GLOBAL_CONFIG_ACCESSORS.has('appLineageNode')).toBe(true);
    expect(scanner.GLOBAL_CONFIG_ACCESSORS.has('aiProviderConfig')).toBe(true);

    // Raw SQL against the fork's table, which has no @@map: its name is the model's.
    const writes = (body: string): boolean =>
      scanner.analyzeRoute(
        {
          path: 'app/api/v1/fixture/route.ts',
          source: `export const POST = withAdminAuth(async () => {\n${body}\n});`,
        },
        new Set()
      )[0].writes;
    expect(writes('await prisma.$executeRaw`UPDATE "AppLineageNode" SET "label" = 1`;')).toBe(true);
    expect(writes('await prisma.$executeRaw`UPDATE app_lineage_node SET label = 1`;')).toBe(true);
    expect(writes('await prisma.$executeRaw`UPDATE "AppOther" SET "label" = 1`;')).toBe(false);
  });
});
