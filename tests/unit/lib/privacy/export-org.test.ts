/**
 * Tests: lib/privacy/export-org.ts (§106 t-672)
 *
 * The manifest is mocked at the module so the service is tested against a
 * small known roster of sources — one of each disposition — rather than the
 * real one (`org-sources.test.ts` covers that). What is pinned: every source
 * runs, as the exported org whatever scope the caller is in (t-735), sections
 * land under the right key by disposition, `meta` describes
 * exactly what was delivered, one failing source fails the whole export, and
 * a missing org is its own error.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const db = vi.hoisted(() => ({ org: { findUnique: vi.fn() } }));
vi.mock('@/lib/db/client', () => ({ prisma: db }));

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({ logger: mockLogger }));

const sources = vi.hoisted(() => ({
  members: vi.fn(),
  keys: vi.fn(),
}));
vi.mock('@/lib/privacy/org-sources', () => ({
  ORG_DATA_SOURCES: [
    {
      model: 'OrgMembership',
      section: 'members',
      disposition: 'export',
      description: 'The roster.',
      fetch: sources.members,
    },
    {
      model: 'AiApiKey',
      section: 'apiKeys',
      disposition: 'attribution',
      description: 'Keys held.',
      fetch: sources.keys,
    },
  ],
  ORG_EXCLUDED_SOURCES: [{ model: 'Ghost', reason: 'Fixture exclusion.' }],
}));

// The fork seam is stubbed at the module; the REAL registry sits behind it, so
// these tests drive the same lazy init gate the export uses in production.
const mockInitAppOrgSources = vi.hoisted(() => vi.fn());
vi.mock('@/lib/app/org-export', () => ({
  initAppOrgSources: () => mockInitAppOrgSources(),
}));

import { getTenantContext, runAsOrg } from '@/lib/tenancy/context';
import {
  exportOrgData,
  OrgNotFoundError,
  AppOrgDeclarationsUnavailableError,
  AppOrgSourceInvalidError,
  ORG_EXPORT_FORMAT_VERSION,
} from '@/lib/privacy/export-org';
import {
  registerAppOrgSources,
  __resetAppOrgSourceRegistryForTests,
  type AppOrgDataSource,
} from '@/lib/privacy/org-source-registry';

const ORG = 'cmorg000000000000000other';
const ADMIN = 'cmjbv4i3x00003wsloputgwul';
const orgRow = { id: ORG, slug: 'other', name: 'Other Org', status: 'ACTIVE' };

beforeEach(() => {
  vi.clearAllMocks();
  __resetAppOrgSourceRegistryForTests();
  mockInitAppOrgSources.mockReset();
  db.org.findUnique.mockResolvedValue(orgRow);
  sources.members.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);
  sources.keys.mockResolvedValue([{ id: 'k1', label: 'CI', createdAt: new Date() }]);
});

describe('exportOrgData', () => {
  it('assembles the org row, the data sections and the attributions, described in meta', async () => {
    const bundle = await exportOrgData({ orgId: ORG, actorUserId: ADMIN });

    expect(bundle.org).toEqual(orgRow);
    expect(bundle.data).toEqual({ members: [{ userId: 'u1' }, { userId: 'u2' }] });
    expect(bundle.attributions.apiKeys).toHaveLength(1);
    expect(bundle.meta).toEqual({
      formatVersion: ORG_EXPORT_FORMAT_VERSION,
      generatedAt: expect.any(String),
      orgId: ORG,
      exported: [
        { model: 'OrgMembership', section: 'members', description: 'The roster.', rows: 2 },
      ],
      attribution: [{ model: 'AiApiKey', section: 'apiKeys', description: 'Keys held.', rows: 1 }],
      excluded: [{ model: 'Ghost', reason: 'Fixture exclusion.' }],
    });
  });

  it('asks every source for THIS org', async () => {
    await exportOrgData({ orgId: ORG, actorUserId: ADMIN });
    expect(sources.members).toHaveBeenCalledWith({ orgId: ORG });
    expect(sources.keys).toHaveBeenCalledWith({ orgId: ORG });
  });

  it('reads every source as the exported org, not as the org the caller is in (t-735)', async () => {
    const seen: Array<string | null | undefined> = [];
    sources.members.mockImplementation(async () => {
      seen.push(getTenantContext()?.orgId);
      return [];
    });
    sources.keys.mockImplementation(async () => {
      seen.push(getTenantContext()?.orgId);
      return [];
    });

    // An admin's session enters their own active org; an admin API key enters none.
    await runAsOrg('cmorg00000000000000active', () =>
      exportOrgData({ orgId: ORG, actorUserId: ADMIN })
    );
    await exportOrgData({ orgId: ORG, actorUserId: ADMIN });

    expect(seen).toEqual([ORG, ORG, ORG, ORG]);
  });

  it('reads one source at a time, so an export never queues its reads behind the pool', async () => {
    let releaseMembers: (rows: unknown[]) => void = () => {};
    sources.members.mockReturnValue(
      new Promise<unknown[]>((resolve) => {
        releaseMembers = resolve;
      })
    );

    const pending = exportOrgData({ orgId: ORG, actorUserId: ADMIN });
    await vi.waitFor(() => expect(sources.members).toHaveBeenCalled());
    expect(sources.keys).not.toHaveBeenCalled(); // test-review:accept no_arg_called — the second read must not start while the first is open

    releaseMembers([]);
    await pending;
    expect(sources.keys).toHaveBeenCalledWith({ orgId: ORG });
  });

  it('reports an empty section as delivered with zero rows, not as absent', async () => {
    sources.keys.mockResolvedValue([]);
    const bundle = await exportOrgData({ orgId: ORG, actorUserId: ADMIN });
    expect(bundle.attributions).toHaveProperty('apiKeys', []);
    expect(bundle.meta.attribution[0].rows).toBe(0);
  });

  it('fails the whole export when one source throws — nothing is best-effort', async () => {
    sources.keys.mockRejectedValue(new Error('db down'));
    await expect(exportOrgData({ orgId: ORG, actorUserId: ADMIN })).rejects.toThrow('db down');
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it('raises OrgNotFoundError for a missing org and consults no source', async () => {
    db.org.findUnique.mockResolvedValue(null);
    await expect(exportOrgData({ orgId: ORG, actorUserId: ADMIN })).rejects.toBeInstanceOf(
      OrgNotFoundError
    );
    expect(sources.members).not.toHaveBeenCalled();
  });

  it('logs the actor and the totals', async () => {
    await exportOrgData({ orgId: ORG, actorUserId: ADMIN });
    expect(mockLogger.info).toHaveBeenCalledWith('Org data export generated', {
      orgId: ORG,
      actorUserId: ADMIN,
      sources: 2,
      totalRows: 3,
    });
  });
});

describe('exportOrgData — a fork’s own tables (§109 t-737)', () => {
  const appFetch = vi.fn();
  const APP_SOURCE: AppOrgDataSource = {
    model: 'AppInvoice',
    section: 'invoices',
    disposition: 'export',
    description: 'Invoices raised against the org.',
    fetch: appFetch,
  };

  /** Make the fork's init register `contribution` the first time anything reads the registry. */
  function forkRegisters(contribution: Parameters<typeof registerAppOrgSources>[0]): void {
    mockInitAppOrgSources.mockImplementation(() => registerAppOrgSources(contribution));
  }

  beforeEach(() => {
    appFetch.mockReset();
    appFetch.mockResolvedValue([{ id: 'inv1' }, { id: 'inv2' }, { id: 'inv3' }]);
  });

  it('puts a registered source’s rows under app[section] and describes it in meta.app', async () => {
    forkRegisters({ tier: 'app', sources: [APP_SOURCE] });

    const bundle = await exportOrgData({ orgId: ORG, actorUserId: ADMIN });

    expect(bundle.app).toEqual({ invoices: [{ id: 'inv1' }, { id: 'inv2' }, { id: 'inv3' }] });
    expect(bundle.meta.app).toEqual([
      {
        model: 'AppInvoice',
        section: 'invoices',
        description: 'Invoices raised against the org.',
        disposition: 'export',
        rows: 3,
      },
    ]);
    // The fork's rows never leak into core's sections or core's summaries.
    expect(bundle.data).not.toHaveProperty('invoices');
    expect(bundle.attributions).not.toHaveProperty('invoices');
    expect(bundle.meta.exported.map((s) => s.model)).toEqual(['OrgMembership']);
  });

  it('carries the fork’s own disposition label into meta.app without sectioning by it', async () => {
    forkRegisters({
      tier: 'app',
      sources: [{ ...APP_SOURCE, disposition: 'attribution' }],
    });

    const bundle = await exportOrgData({ orgId: ORG, actorUserId: ADMIN });

    expect(bundle.meta.app?.[0].disposition).toBe('attribution');
    expect(bundle.app).toHaveProperty('invoices');
    expect(bundle.attributions).not.toHaveProperty('invoices');
  });

  it('reports a fork source with no rows as delivered with zero rows', async () => {
    appFetch.mockResolvedValue([]);
    forkRegisters({ tier: 'app', sources: [APP_SOURCE] });

    const bundle = await exportOrgData({ orgId: ORG, actorUserId: ADMIN });

    expect(bundle.app).toHaveProperty('invoices', []);
    expect(bundle.meta.app?.[0].rows).toBe(0);
  });

  it('hands the fork fetch { orgId } and runs it as the exported org, after every core source', async () => {
    const order: string[] = [];
    let forkContextOrg: string | null | undefined;
    sources.members.mockImplementation(async () => {
      order.push('members');
      return [];
    });
    sources.keys.mockImplementation(async () => {
      order.push('keys');
      return [];
    });
    appFetch.mockImplementation(async () => {
      order.push('app');
      forkContextOrg = getTenantContext()?.orgId;
      return [];
    });
    forkRegisters({ tier: 'app', sources: [APP_SOURCE] });

    // Called from inside a DIFFERENT org, as an admin session would be.
    await runAsOrg('cmorg00000000000000active', () =>
      exportOrgData({ orgId: ORG, actorUserId: ADMIN })
    );

    expect(appFetch).toHaveBeenCalledWith({ orgId: ORG });
    expect(forkContextOrg).toBe(ORG);
    expect(order).toEqual(['members', 'keys', 'app']);
  });

  it('reads fork sources one at a time, in registration order', async () => {
    const order: string[] = [];
    let releaseFirst: (rows: unknown[]) => void = () => {};
    const second = vi.fn(async () => {
      order.push('second');
      return [];
    });
    forkRegisters({
      tier: 'app',
      sources: [
        {
          ...APP_SOURCE,
          fetch: () =>
            new Promise<unknown[]>((resolve) => {
              order.push('first');
              releaseFirst = resolve;
            }),
        },
        { ...APP_SOURCE, model: 'AppCredit', section: 'credits', fetch: second },
      ],
    });

    const pending = exportOrgData({ orgId: ORG, actorUserId: ADMIN });
    await vi.waitFor(() => expect(order).toEqual(['first']));
    expect(second).not.toHaveBeenCalled(); // test-review:accept no_arg_called — the second fork read must wait for the first

    releaseFirst([]);
    const bundle = await pending;

    expect(order).toEqual(['first', 'second']);
    expect(Object.keys(bundle.app ?? {})).toEqual(['invoices', 'credits']);
  });

  it('counts fork rows in the audit log totals', async () => {
    forkRegisters({ tier: 'app', sources: [APP_SOURCE] });

    await exportOrgData({ orgId: ORG, actorUserId: ADMIN });

    // 2 core sources + 1 fork source; 2 + 1 core rows + 3 fork rows.
    expect(mockLogger.info).toHaveBeenCalledWith('Org data export generated', {
      orgId: ORG,
      actorUserId: ADMIN,
      sources: 3,
      totalRows: 6,
    });
  });

  it('adds NO app key and NO meta.app key when nothing is registered', async () => {
    const bundle = await exportOrgData({ orgId: ORG, actorUserId: ADMIN });

    // `in`/`Object.keys`, not `toBeUndefined()`: a present-but-undefined key
    // would still change a vanilla install's serialised shape.
    expect('app' in bundle).toBe(false);
    expect('app' in bundle.meta).toBe(false);
    expect(Object.keys(bundle).sort()).toEqual(['attributions', 'data', 'meta', 'org']);
    expect(Object.keys(bundle.meta).sort()).toEqual([
      'attribution',
      'excluded',
      'exported',
      'formatVersion',
      'generatedAt',
      'orgId',
    ]);
    expect(bundle.meta.excluded).toEqual([{ model: 'Ghost', reason: 'Fixture exclusion.' }]);
  });

  it('adds no app key when a fork registered only exclusions, but still lists them', async () => {
    forkRegisters({
      tier: 'app',
      excluded: [{ model: 'AppCountry', reason: 'Reference list of countries — no org data.' }],
    });

    const bundle = await exportOrgData({ orgId: ORG, actorUserId: ADMIN });

    expect('app' in bundle).toBe(false);
    expect('app' in bundle.meta).toBe(false);
    expect(bundle.meta.excluded.map((e) => e.model)).toEqual(['Ghost', 'AppCountry']);
  });

  it('appends the fork’s exclusions after core’s in meta.excluded', async () => {
    forkRegisters({
      tier: 'app',
      sources: [APP_SOURCE],
      excluded: [{ model: 'AppCountry', reason: 'Reference list of countries — no org data.' }],
    });

    const bundle = await exportOrgData({ orgId: ORG, actorUserId: ADMIN });

    expect(bundle.meta.excluded).toEqual([
      { model: 'Ghost', reason: 'Fixture exclusion.' },
      { model: 'AppCountry', reason: 'Reference list of countries — no org data.' },
    ]);
  });

  it('refuses with AppOrgDeclarationsUnavailableError when the fork init threw, reading nothing', async () => {
    mockInitAppOrgSources.mockImplementation(() => {
      throw new Error('typo in lib/app/org-export.ts');
    });

    await expect(exportOrgData({ orgId: ORG, actorUserId: ADMIN })).rejects.toBeInstanceOf(
      AppOrgDeclarationsUnavailableError
    );

    // Neither core's reads nor the fork's: a half-built bundle must not start.
    expect(sources.members).not.toHaveBeenCalled();
    expect(sources.keys).not.toHaveBeenCalled();
    expect(appFetch).not.toHaveBeenCalled();
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it('keeps refusing on the next call — a failed init is not retried into success', async () => {
    mockInitAppOrgSources
      .mockImplementationOnce(() => {
        throw new Error('typo');
      })
      .mockImplementation(() => registerAppOrgSources({ tier: 'app', sources: [APP_SOURCE] }));

    await expect(exportOrgData({ orgId: ORG, actorUserId: ADMIN })).rejects.toBeInstanceOf(
      AppOrgDeclarationsUnavailableError
    );
    await expect(exportOrgData({ orgId: ORG, actorUserId: ADMIN })).rejects.toBeInstanceOf(
      AppOrgDeclarationsUnavailableError
    );
    expect(mockInitAppOrgSources).toHaveBeenCalledTimes(1);
  });

  it('still reports a missing org as OrgNotFoundError, before consulting the fork seam', async () => {
    db.org.findUnique.mockResolvedValue(null);
    mockInitAppOrgSources.mockImplementation(() => {
      throw new Error('typo');
    });

    await expect(exportOrgData({ orgId: ORG, actorUserId: ADMIN })).rejects.toBeInstanceOf(
      OrgNotFoundError
    );
  });

  it.each([
    ['an object', {}],
    ['undefined', undefined],
    ['null', null],
    ['an array-like', { length: 1, 0: 'x' }],
  ])(
    'rejects with AppOrgSourceInvalidError naming the model when fetch resolves to %s',
    async (_label, value) => {
      appFetch.mockResolvedValue(value);
      forkRegisters({ tier: 'app', sources: [APP_SOURCE] });

      const failure = await exportOrgData({ orgId: ORG, actorUserId: ADMIN }).catch(
        (e: unknown) => e
      );

      expect(failure).toBeInstanceOf(AppOrgSourceInvalidError);
      expect((failure as AppOrgSourceInvalidError).model).toBe('AppInvoice');
      expect((failure as AppOrgSourceInvalidError).message).toContain(
        "AppInvoice (section 'invoices')"
      );
      expect(mockLogger.info).not.toHaveBeenCalled();
    }
  );

  it('fails the whole export when a fork fetch throws — nothing is best-effort', async () => {
    appFetch.mockRejectedValue(new Error('fork db down'));
    forkRegisters({ tier: 'app', sources: [APP_SOURCE] });

    await expect(exportOrgData({ orgId: ORG, actorUserId: ADMIN })).rejects.toThrow('fork db down');
    expect(mockLogger.info).not.toHaveBeenCalled();
  });
});
