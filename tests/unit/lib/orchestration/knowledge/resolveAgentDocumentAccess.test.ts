/**
 * Agent Knowledge-Access Resolver — Unit Tests
 *
 * Covers the three behaviours the rest of the search path depends on:
 *  - mode dispatch (`full` short-circuit vs `restricted` set construction)
 *  - missing-agent fallback (must NOT throw — defaults to empty restricted)
 *  - grant set construction (doc grants ∪ tag-expanded docs, deduped)
 *  - cache lifecycle (hit, per-agent invalidation, full clear, TTL expiry)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: { findUnique: vi.fn() },
    aiAgentKnowledgeDocument: { findMany: vi.fn() },
    aiAgentKnowledgeTag: { findMany: vi.fn() },
    aiKnowledgeDocumentTag: { findMany: vi.fn() },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { prisma } from '@/lib/db/client';
import {
  resolveAgentDocumentAccess,
  invalidateAgentAccess,
  invalidateAllAgentAccess,
  registerAgentAccessContributor,
  __resetAgentAccessContributorsForTests,
} from '@/lib/orchestration/knowledge/resolveAgentDocumentAccess';
import { logger } from '@/lib/logging';

type Mocked = ReturnType<typeof vi.fn>;
const agentFindUnique = prisma.aiAgent.findUnique as unknown as Mocked;
const docGrantsFindMany = prisma.aiAgentKnowledgeDocument.findMany as unknown as Mocked;
const tagGrantsFindMany = prisma.aiAgentKnowledgeTag.findMany as unknown as Mocked;
const docTagsFindMany = prisma.aiKnowledgeDocumentTag.findMany as unknown as Mocked;

beforeEach(() => {
  vi.clearAllMocks();
  invalidateAllAgentAccess();
  __resetAgentAccessContributorsForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('resolveAgentDocumentAccess', () => {
  describe('mode dispatch', () => {
    it('returns `full` when the agent is not restricted', async () => {
      agentFindUnique.mockResolvedValueOnce({ knowledgeAccessMode: 'full' });

      const result = await resolveAgentDocumentAccess('agent-1');

      expect(result).toEqual({ mode: 'full' });
      // No grant lookups should happen in `full` mode.
      expect(docGrantsFindMany).not.toHaveBeenCalled();
      expect(tagGrantsFindMany).not.toHaveBeenCalled();
    });

    it('treats unknown access modes as `full` (anything not exactly "restricted")', async () => {
      // Defensive: the column is a string today; any future enum drift should
      // fail open (no filter) rather than silently lock out a deployed agent.
      agentFindUnique.mockResolvedValueOnce({ knowledgeAccessMode: 'something-else' });

      const result = await resolveAgentDocumentAccess('agent-x');

      expect(result).toEqual({ mode: 'full' });
    });
  });

  describe('missing agent', () => {
    it('returns empty restricted access with system scope when the agent is not found', async () => {
      agentFindUnique.mockResolvedValueOnce(null);

      const result = await resolveAgentDocumentAccess('missing-agent');

      expect(result).toEqual({
        mode: 'restricted',
        documentIds: [],
        includeSystemScope: true,
      });
      // We should NOT have queried grants for a non-existent agent.
      expect(docGrantsFindMany).not.toHaveBeenCalled();
      expect(tagGrantsFindMany).not.toHaveBeenCalled();
    });

    it('caches the missing-agent fallback so repeat lookups do not re-query', async () => {
      agentFindUnique.mockResolvedValueOnce(null);

      await resolveAgentDocumentAccess('missing-agent');
      await resolveAgentDocumentAccess('missing-agent');

      expect(agentFindUnique).toHaveBeenCalledTimes(1);
    });
  });

  describe('restricted mode grant resolution', () => {
    it('returns empty docIds when a restricted agent has no grants', async () => {
      agentFindUnique.mockResolvedValueOnce({ knowledgeAccessMode: 'restricted' });
      docGrantsFindMany.mockResolvedValueOnce([]);
      tagGrantsFindMany.mockResolvedValueOnce([]);

      const result = await resolveAgentDocumentAccess('agent-2');

      expect(result).toEqual({
        mode: 'restricted',
        documentIds: [],
        includeSystemScope: true,
      });
      // No tag IDs → no tag→doc expansion query.
      expect(docTagsFindMany).not.toHaveBeenCalled();
    });

    it('returns explicit doc grants when no tags are granted', async () => {
      agentFindUnique.mockResolvedValueOnce({ knowledgeAccessMode: 'restricted' });
      docGrantsFindMany.mockResolvedValueOnce([{ documentId: 'doc-a' }, { documentId: 'doc-b' }]);
      tagGrantsFindMany.mockResolvedValueOnce([]);

      const result = await resolveAgentDocumentAccess('agent-3');

      expect(result).toMatchObject({ mode: 'restricted', includeSystemScope: true });
      if (result.mode !== 'restricted') throw new Error('expected restricted');
      expect(result.documentIds.sort()).toEqual(['doc-a', 'doc-b']);
      expect(docTagsFindMany).not.toHaveBeenCalled();
    });

    it('expands tag grants into the document set', async () => {
      agentFindUnique.mockResolvedValueOnce({ knowledgeAccessMode: 'restricted' });
      docGrantsFindMany.mockResolvedValueOnce([]);
      tagGrantsFindMany.mockResolvedValueOnce([{ tagId: 'tag-1' }, { tagId: 'tag-2' }]);
      docTagsFindMany.mockResolvedValueOnce([
        { documentId: 'doc-from-tag-1' },
        { documentId: 'doc-from-tag-2' },
      ]);

      const result = await resolveAgentDocumentAccess('agent-4');

      if (result.mode !== 'restricted') throw new Error('expected restricted');
      expect(result.documentIds.sort()).toEqual(['doc-from-tag-1', 'doc-from-tag-2']);
      expect(docTagsFindMany).toHaveBeenCalledWith({
        where: { tagId: { in: ['tag-1', 'tag-2'] } },
        select: { documentId: true },
      });
    });

    it('unions doc grants with tag-expanded docs and deduplicates overlap', async () => {
      // doc-shared is granted both directly AND via a tag — it must appear once.
      agentFindUnique.mockResolvedValueOnce({ knowledgeAccessMode: 'restricted' });
      docGrantsFindMany.mockResolvedValueOnce([
        { documentId: 'doc-shared' },
        { documentId: 'doc-only-grant' },
      ]);
      tagGrantsFindMany.mockResolvedValueOnce([{ tagId: 'tag-1' }]);
      docTagsFindMany.mockResolvedValueOnce([
        { documentId: 'doc-shared' },
        { documentId: 'doc-only-tag' },
      ]);

      const result = await resolveAgentDocumentAccess('agent-5');

      if (result.mode !== 'restricted') throw new Error('expected restricted');
      expect(result.documentIds.sort()).toEqual(['doc-only-grant', 'doc-only-tag', 'doc-shared']);
    });
  });

  describe('caching', () => {
    it('serves repeat lookups from the in-memory cache within the TTL', async () => {
      agentFindUnique.mockResolvedValue({ knowledgeAccessMode: 'full' });

      await resolveAgentDocumentAccess('agent-cache');
      await resolveAgentDocumentAccess('agent-cache');
      await resolveAgentDocumentAccess('agent-cache');

      expect(agentFindUnique).toHaveBeenCalledTimes(1);
    });

    it('caches per-agent — different agents do not collide', async () => {
      agentFindUnique
        .mockResolvedValueOnce({ knowledgeAccessMode: 'full' })
        .mockResolvedValueOnce({ knowledgeAccessMode: 'restricted' });
      docGrantsFindMany.mockResolvedValueOnce([]);
      tagGrantsFindMany.mockResolvedValueOnce([]);

      const a = await resolveAgentDocumentAccess('agent-a');
      const b = await resolveAgentDocumentAccess('agent-b');

      expect(a).toEqual({ mode: 'full' });
      expect(b).toMatchObject({ mode: 'restricted', documentIds: [] });
      expect(agentFindUnique).toHaveBeenCalledTimes(2);
    });

    it('`invalidateAgentAccess` evicts only the named entry', async () => {
      agentFindUnique
        .mockResolvedValueOnce({ knowledgeAccessMode: 'full' })
        .mockResolvedValueOnce({ knowledgeAccessMode: 'full' }) // refetch after invalidation
        .mockResolvedValueOnce({ knowledgeAccessMode: 'full' });

      await resolveAgentDocumentAccess('agent-1');
      await resolveAgentDocumentAccess('agent-2');
      invalidateAgentAccess('agent-1');

      await resolveAgentDocumentAccess('agent-1'); // refetch
      await resolveAgentDocumentAccess('agent-2'); // cached

      expect(agentFindUnique).toHaveBeenCalledTimes(3);
    });

    it('`invalidateAllAgentAccess` clears every cached entry', async () => {
      agentFindUnique.mockResolvedValue({ knowledgeAccessMode: 'full' });

      await resolveAgentDocumentAccess('agent-1');
      await resolveAgentDocumentAccess('agent-2');
      invalidateAllAgentAccess();
      await resolveAgentDocumentAccess('agent-1');
      await resolveAgentDocumentAccess('agent-2');

      expect(agentFindUnique).toHaveBeenCalledTimes(4);
    });

    it('refetches after the TTL expires', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

      agentFindUnique.mockResolvedValue({ knowledgeAccessMode: 'full' });

      await resolveAgentDocumentAccess('agent-ttl');
      // Advance just past the 60s TTL.
      vi.setSystemTime(new Date('2026-01-01T00:01:01Z'));
      await resolveAgentDocumentAccess('agent-ttl');

      expect(agentFindUnique).toHaveBeenCalledTimes(2);
    });
  });

  describe('access-contributor seam (#403)', () => {
    function restrictedWith(docs: string[] = [], tags: string[] = []): void {
      agentFindUnique.mockResolvedValueOnce({ knowledgeAccessMode: 'restricted' });
      docGrantsFindMany.mockResolvedValueOnce(docs.map((documentId) => ({ documentId })));
      tagGrantsFindMany.mockResolvedValueOnce(tags.map((tagId) => ({ tagId })));
    }

    it('unions a contributor’s documentIds into a restricted agent’s set', async () => {
      restrictedWith(['doc-core']);
      registerAgentAccessContributor('mod', async () => ({ documentIds: ['doc-mod'] }));

      const result = await resolveAgentDocumentAccess('agent-c1');

      if (result.mode !== 'restricted') throw new Error('expected restricted');
      expect(result.documentIds.sort()).toEqual(['doc-core', 'doc-mod']);
    });

    it('expands a contributor’s tagIds through the tag→doc query (deduped with granted tags)', async () => {
      restrictedWith([], ['tag-core']);
      registerAgentAccessContributor('mod', async () => ({ tagIds: ['tag-mod', 'tag-core'] }));
      docTagsFindMany.mockResolvedValueOnce([{ documentId: 'doc-from-tag' }]);

      const result = await resolveAgentDocumentAccess('agent-c2');

      if (result.mode !== 'restricted') throw new Error('expected restricted');
      expect(result.documentIds).toEqual(['doc-from-tag']);
      // tag-core (granted) and tag-mod (contributed) go into ONE deduped IN query.
      expect(docTagsFindMany).toHaveBeenCalledTimes(1);
      const inClause: string[] = docTagsFindMany.mock.calls[0][0].where.tagId.in;
      expect([...inClause].sort()).toEqual(['tag-core', 'tag-mod']);
    });

    it('deduplicates a contributed doc that overlaps a direct grant', async () => {
      restrictedWith(['doc-shared']);
      registerAgentAccessContributor('mod', async () => ({
        documentIds: ['doc-shared', 'doc-mod'],
      }));

      const result = await resolveAgentDocumentAccess('agent-c3');

      if (result.mode !== 'restricted') throw new Error('expected restricted');
      expect(result.documentIds.sort()).toEqual(['doc-mod', 'doc-shared']);
    });

    it('never consults contributors for a `full` agent (widen-only)', async () => {
      agentFindUnique.mockResolvedValueOnce({ knowledgeAccessMode: 'full' });
      const contributor = vi.fn(async () => ({ documentIds: ['doc-mod'] }));
      registerAgentAccessContributor('mod', contributor);

      const result = await resolveAgentDocumentAccess('agent-full');

      expect(result).toEqual({ mode: 'full' });
      expect(contributor).not.toHaveBeenCalled();
    });

    it('ignores a contributor that rejects, preserving the core grant set', async () => {
      restrictedWith(['doc-core']);
      registerAgentAccessContributor('boom', async () => {
        throw new Error('contributor blew up');
      });

      const result = await resolveAgentDocumentAccess('agent-c4');

      if (result.mode !== 'restricted') throw new Error('expected restricted');
      expect(result.documentIds).toEqual(['doc-core']);
      expect(vi.mocked(logger.error)).toHaveBeenCalled();
    });

    it('ignores a contributor that throws synchronously', async () => {
      restrictedWith(['doc-core']);
      // Not async-safe: throws before returning a promise.
      registerAgentAccessContributor('sync-boom', () => {
        throw new Error('sync throw');
      });

      const result = await resolveAgentDocumentAccess('agent-c5');

      if (result.mode !== 'restricted') throw new Error('expected restricted');
      expect(result.documentIds).toEqual(['doc-core']);
    });

    it('ignores a malformed (non-array) contribution shape without throwing or spreading garbage', async () => {
      // A fork that violates the `string[]` contract must not crash the resolver
      // (a bare number would make `.push(...)` throw "not iterable") nor poison
      // the set (a string would spread into single characters).
      restrictedWith(['doc-core']);
      // Casts: these deliberately violate the `string[]` contract.
      registerAgentAccessContributor('bad-number', (async () => ({ documentIds: 123 })) as never);
      registerAgentAccessContributor('bad-string', (async () => ({
        documentIds: 'doc-x',
      })) as never);

      const result = await resolveAgentDocumentAccess('agent-bad');

      if (result.mode !== 'restricted') throw new Error('expected restricted');
      expect(result.documentIds).toEqual(['doc-core']);
    });

    it('unions contributions from multiple contributors', async () => {
      restrictedWith(['doc-core']);
      registerAgentAccessContributor('a', async () => ({ documentIds: ['doc-a'] }));
      registerAgentAccessContributor('b', async () => ({ documentIds: ['doc-b'] }));

      const result = await resolveAgentDocumentAccess('agent-c6');

      if (result.mode !== 'restricted') throw new Error('expected restricted');
      expect(result.documentIds.sort()).toEqual(['doc-a', 'doc-b', 'doc-core']);
    });

    it('re-registering the same key replaces the prior contributor', async () => {
      restrictedWith([]);
      registerAgentAccessContributor('mod', async () => ({ documentIds: ['old'] }));
      registerAgentAccessContributor('mod', async () => ({ documentIds: ['new'] }));

      const result = await resolveAgentDocumentAccess('agent-c7');

      if (result.mode !== 'restricted') throw new Error('expected restricted');
      expect(result.documentIds).toEqual(['new']);
    });
  });
});
