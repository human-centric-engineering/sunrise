/**
 * Tests: lib/privacy/export-org.ts (§106 t-672)
 *
 * The manifest is mocked at the module so the service is tested against a
 * small known roster of sources — one of each disposition — rather than the
 * real one (`org-sources.test.ts` covers that). What is pinned: every source
 * runs, sections land under the right key by disposition, `meta` describes
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

import {
  exportOrgData,
  OrgNotFoundError,
  ORG_EXPORT_FORMAT_VERSION,
} from '@/lib/privacy/export-org';

const ORG = 'cmorg000000000000000other';
const ADMIN = 'cmjbv4i3x00003wsloputgwul';
const orgRow = { id: ORG, slug: 'other', name: 'Other Org', status: 'ACTIVE' };

beforeEach(() => {
  vi.clearAllMocks();
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
