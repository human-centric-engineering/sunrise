import { describe, it, expect, vi } from 'vitest';

import {
  INITIAL_VERSION_SUMMARY,
  asSnapshotJson,
  buildAgentSnapshot,
  nextAgentVersionNumber,
} from '@/lib/orchestration/agents/agent-versioning';

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
});
