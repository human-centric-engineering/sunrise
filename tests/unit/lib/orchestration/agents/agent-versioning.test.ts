import { describe, it, expect, vi } from 'vitest';

import type { Prisma } from '@prisma/client';

import type { prisma } from '@/lib/db/client';
import { buildChangeSummary } from '@/lib/orchestration/agent-version-diff';
import {
  INITIAL_VERSION_SUMMARY,
  LATEST_AGENT_VERSION_ID_INCLUDE,
  asSnapshotJson,
  buildAgentSnapshot,
  ensureBaselineVersion,
  nextAgentVersionNumber,
  readAgentConsistently,
  recordAgentVersion,
} from '@/lib/orchestration/agents/agent-versioning';

/** A live agent row: versioned columns plus columns the snapshot must drop. */
const LIVE_AGENT = {
  id: 'agent-1',
  createdAt: new Date('2026-01-01'),
  model: 'claude-opus-4-8',
  systemInstructions: 'Reverted instructions.',
  temperature: 0.4,
  providerConfig: { b: 2, a: 1 },
};

/**
 * A transaction client holding one agent, its grants and its version rows.
 * `create` appends, so a test reads back exactly what the helper wrote.
 */
function makeTx(versions: Array<{ version: number; snapshot: unknown }>) {
  const created: Array<Record<string, unknown>> = [];
  const tx = {
    aiAgent: { findUniqueOrThrow: vi.fn(async () => LIVE_AGENT) },
    aiAgentKnowledgeTag: { findMany: vi.fn(async () => [{ tagId: 'tag-b' }, { tagId: 'tag-a' }]) },
    aiAgentKnowledgeDocument: { findMany: vi.fn(async () => [{ documentId: 'doc-1' }]) },
    aiAgentVersion: {
      findFirst: vi.fn(async () => {
        const newest = [...versions].sort((a, b) => b.version - a.version)[0];
        return newest ?? null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return data;
      }),
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, created };
}

/** The snapshot the helpers should build from LIVE_AGENT and its grants. */
const LIVE_SNAPSHOT = buildAgentSnapshot(LIVE_AGENT, {
  grantedTagIds: ['tag-a', 'tag-b'],
  grantedDocumentIds: ['doc-1'],
});

/**
 * Shared point-in-time versioning helpers used by create, PATCH, restore, and
 * the seed backfill. They must agree on the snapshot shape and version numbering
 * so those paths can't drift.
 */
describe('agent-versioning helpers', () => {
  describe('buildAgentSnapshot', () => {
    it('captures the versioned config and injects sorted grant id arrays', () => {
      const agent = {
        model: 'claude-opus-4-8',
        temperature: 0.4,
        // Non-versioned columns must NOT leak into the snapshot.
        id: 'agent-1',
        createdAt: new Date('2026-01-01'),
        createdBy: 'admin-1',
      };

      const snapshot = buildAgentSnapshot(agent, {
        grantedTagIds: ['tag-c', 'tag-a', 'tag-b'],
        grantedDocumentIds: ['doc-b', 'doc-a'],
      });

      // Versioned scalars are carried through…
      expect(snapshot).toHaveProperty('model', 'claude-opus-4-8');
      expect(snapshot).toHaveProperty('temperature', 0.4);
      // …grants are injected, sorted for order-stability…
      expect(snapshot.grantedTagIds).toEqual(['tag-a', 'tag-b', 'tag-c']);
      expect(snapshot.grantedDocumentIds).toEqual(['doc-a', 'doc-b']);
      // …and audit/identity columns are excluded.
      expect(snapshot).not.toHaveProperty('id');
      expect(snapshot).not.toHaveProperty('createdAt');
      expect(snapshot).not.toHaveProperty('createdBy');
    });

    it('does not mutate the caller-supplied grant arrays', () => {
      const grantedTagIds = ['z', 'a'];
      buildAgentSnapshot({ model: 'm' }, { grantedTagIds, grantedDocumentIds: [] });
      // Sorting happens on a copy.
      expect(grantedTagIds).toEqual(['z', 'a']);
    });
  });

  describe('nextAgentVersionNumber', () => {
    it('returns highest existing version + 1', async () => {
      const tx = {
        aiAgentVersion: { findFirst: vi.fn().mockResolvedValue({ version: 7 }) },
      };
      await expect(nextAgentVersionNumber(tx, 'agent-1')).resolves.toBe(8);
      expect(tx.aiAgentVersion.findFirst).toHaveBeenCalledWith({
        where: { agentId: 'agent-1' },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
    });

    it('returns 1 when the agent has no versions yet', async () => {
      const tx = {
        aiAgentVersion: { findFirst: vi.fn().mockResolvedValue(null) },
      };
      await expect(nextAgentVersionNumber(tx, 'agent-1')).resolves.toBe(1);
    });
  });

  describe('constants + passthrough', () => {
    it('exposes the initial-version summary', () => {
      expect(INITIAL_VERSION_SUMMARY).toBe('Initial configuration');
    });

    it('asSnapshotJson returns the snapshot unchanged (type boundary only)', () => {
      const snap = { model: 'm', grantedTagIds: [] };
      expect(asSnapshotJson(snap)).toBe(snap);
    });
  });

  describe('recordAgentVersion', () => {
    it('saves the live row and grants as the next version, summarising what changed', async () => {
      // The newest version differs from the live config in two fields.
      const { tx, created } = makeTx([
        {
          version: 3,
          snapshot: { ...LIVE_SNAPSHOT, model: 'older-model', systemInstructions: 'Old.' },
        },
      ]);

      const written = await recordAgentVersion(tx, 'agent-1', {
        label: 'Overwritten by agent import',
        createdBy: 'admin-1',
      });

      expect(written).toBe(4);
      expect(created).toEqual([
        {
          agentId: 'agent-1',
          version: 4,
          snapshot: LIVE_SNAPSHOT,
          // The label, then the changed fields grouped by tab as PATCH writes them.
          changeSummary: `Overwritten by agent import — ${buildChangeSummary([
            'model',
            'systemInstructions',
          ])}`,
          createdBy: 'admin-1',
        },
      ]);
      // The snapshot is the live config: the reverted instructions and the
      // grants as they stand, not whatever the caller thought it wrote.
      expect(created[0].snapshot).toMatchObject({
        systemInstructions: 'Reverted instructions.',
        grantedTagIds: ['tag-a', 'tag-b'],
        grantedDocumentIds: ['doc-1'],
      });
      expect(created[0].snapshot).not.toHaveProperty('id');
    });

    it('saves v1 for an agent with no versions', async () => {
      const { tx, created } = makeTx([]);

      const written = await recordAgentVersion(tx, 'agent-1', {
        label: INITIAL_VERSION_SUMMARY,
        createdBy: 'admin-1',
      });

      expect(written).toBe(1);
      expect(created).toHaveLength(1);
      // A first version has nothing to diff against: the label alone.
      expect(created[0]).toMatchObject({ version: 1, changeSummary: INITIAL_VERSION_SUMMARY });
    });

    it('writes nothing when the live config already equals the newest version', async () => {
      // JSONB hands keys back in its own order; the comparison must not care.
      const reordered = JSON.parse(
        JSON.stringify({ ...LIVE_SNAPSHOT, providerConfig: { a: 1, b: 2 } })
      ) as Record<string, unknown>;
      const keysReversed = Object.fromEntries(Object.entries(reordered).reverse());
      const { tx, created } = makeTx([{ version: 5, snapshot: keysReversed }]);

      const written = await recordAgentVersion(tx, 'agent-1', {
        label: 'Overwritten by backup import',
        createdBy: 'admin-1',
      });

      expect(written).toBeNull();
      expect(created).toEqual([]);
    });

    it('writes a version when a nested value differs from the newest version', async () => {
      const { tx, created } = makeTx([
        { version: 5, snapshot: { ...LIVE_SNAPSHOT, providerConfig: { a: 1, b: 3 } } },
      ]);

      const written = await recordAgentVersion(tx, 'agent-1', {
        label: 'Overwritten by backup import',
        createdBy: 'admin-1',
      });

      expect(written).toBe(6);
      expect(created).toHaveLength(1);
      expect(created[0].changeSummary).toBe(
        `Overwritten by backup import — ${buildChangeSummary(['providerConfig'])}`
      );
    });
  });

  describe('ensureBaselineVersion', () => {
    it('saves the current config as v1 when the agent has no versions', async () => {
      const { tx, created } = makeTx([]);

      await ensureBaselineVersion(tx, 'agent-1', 'admin-1');

      expect(created).toEqual([
        {
          agentId: 'agent-1',
          version: 1,
          snapshot: LIVE_SNAPSHOT,
          changeSummary: INITIAL_VERSION_SUMMARY,
          createdBy: 'admin-1',
        },
      ]);
    });

    it('reads the live config one query at a time on the transaction connection', async () => {
      // pg deprecates concurrent queries on one client, and an interactive
      // transaction holds exactly one: no read may start before the last ends.
      let inFlight = 0;
      let maxInFlight = 0;
      const slow =
        <T>(value: T) =>
        async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 1));
          inFlight -= 1;
          return value;
        };
      const tx = {
        aiAgent: { findUniqueOrThrow: vi.fn(slow(LIVE_AGENT)) },
        aiAgentKnowledgeTag: { findMany: vi.fn(slow([])) },
        aiAgentKnowledgeDocument: { findMany: vi.fn(slow([])) },
        aiAgentVersion: { findFirst: vi.fn(slow(null)), create: vi.fn(slow({})) },
      } as unknown as Prisma.TransactionClient;

      await recordAgentVersion(tx, 'agent-1', { label: 'x', createdBy: 'admin-1' });

      expect(maxInFlight).toBe(1);
    });

    it('writes nothing when the agent already has versions', async () => {
      const { tx, created } = makeTx([{ version: 2, snapshot: {} }]);

      await ensureBaselineVersion(tx, 'agent-1', 'admin-1');

      expect(created).toEqual([]);
    });
  });

  describe('readAgentConsistently', () => {
    it('runs the read in one REPEATABLE READ transaction and returns its result', async () => {
      const tx = { marker: 'tx' };
      const db = {
        $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
      };
      const read = vi.fn(async (t: unknown) => ({ readWith: t }));

      const result = await readAgentConsistently(db as unknown as typeof prisma, read);

      expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: 'RepeatableRead',
      });
      // The read gets the transaction client, so its include shares the snapshot.
      expect(read).toHaveBeenCalledWith(tx);
      expect(result).toEqual({ readWith: tx });
    });

    it('selects only the newest version id', () => {
      expect(LATEST_AGENT_VERSION_ID_INCLUDE).toEqual({
        orderBy: { version: 'desc' },
        take: 1,
        select: { id: true },
      });
    });
  });
});
