/**
 * Unit Test: GET /api/v1/admin/orchestration/knowledge/documents/:id/agents
 *
 * Returns every active agent that can search a document, with the path
 * granting access:
 *   - `full`        — agent has `knowledgeAccessMode = 'full'`
 *   - `direct`      — restricted agent with a direct doc grant
 *   - `tag`         — restricted agent with a shared tag grant
 *   - `system`      — restricted agent + `document.scope = 'system'`
 *
 * Mirrors `lib/orchestration/knowledge/resolveAgentDocumentAccess.ts`.
 *
 * @see app/api/v1/admin/orchestration/knowledge/documents/[id]/agents/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mockAdminUser } from '@/tests/helpers/auth';

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

const mockDocumentFindUnique = vi.fn();
const mockDocTagFindMany = vi.fn();
const mockAgentFindMany = vi.fn();
const mockDirectFindMany = vi.fn();
const mockTagFindMany = vi.fn();

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiKnowledgeDocument: {
      findUnique: (...args: unknown[]) => mockDocumentFindUnique(...args),
    },
    aiKnowledgeDocumentTag: {
      findMany: (...args: unknown[]) => mockDocTagFindMany(...args),
    },
    aiAgent: {
      findMany: (...args: unknown[]) => mockAgentFindMany(...args),
    },
    aiAgentKnowledgeDocument: {
      findMany: (...args: unknown[]) => mockDirectFindMany(...args),
    },
    aiAgentKnowledgeTag: {
      findMany: (...args: unknown[]) => mockTagFindMany(...args),
    },
  },
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

import { auth } from '@/lib/auth/config';
import { GET } from '@/app/api/v1/admin/orchestration/knowledge/documents/[id]/agents/route';

const VALID_DOC_ID = 'cmjbv4i3x00003wsloputgwul';

function makeRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/knowledge/documents/${VALID_DOC_ID}/agents`
  );
}

function makeAgent(
  overrides: Partial<{
    id: string;
    name: string;
    slug: string;
    kind: string;
    knowledgeAccessMode: string;
  }> = {}
) {
  return {
    id: 'agent-cuid-1',
    name: 'Sales Bot',
    slug: 'sales-bot',
    kind: 'chat',
    knowledgeAccessMode: 'restricted',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

  // Default: app-scoped document, no tags, no agents anywhere.
  mockDocumentFindUnique.mockResolvedValue({ id: VALID_DOC_ID, scope: 'app' });
  mockDocTagFindMany.mockResolvedValue([]);
  mockAgentFindMany.mockResolvedValue([]);
  mockDirectFindMany.mockResolvedValue([]);
  mockTagFindMany.mockResolvedValue([]);
});

describe('GET /knowledge/documents/[id]/agents — auth + validation', () => {
  it('rejects a non-CUID document id with 400', async () => {
    const res = await GET(makeRequest().clone() as NextRequest, {
      params: Promise.resolve({ id: 'not-a-cuid' }),
    });
    expect(res.status).toBe(400);
    expect(mockDocumentFindUnique).not.toHaveBeenCalled();
  });

  it('returns 404 when the document does not exist', async () => {
    mockDocumentFindUnique.mockResolvedValue(null);
    const res = await GET(makeRequest(), { params: Promise.resolve({ id: VALID_DOC_ID }) });
    expect(res.status).toBe(404);
  });
});

describe('GET /knowledge/documents/[id]/agents — access paths', () => {
  it('includes full-access agents with a {kind: "full"} path', async () => {
    mockAgentFindMany.mockImplementation((args: { where: { knowledgeAccessMode?: string } }) => {
      // The route makes two parallel `aiAgent.findMany` calls. Distinguish
      // by the mode filter: 'full' = the full-access query, 'restricted'
      // = the system-scope short-circuit (returns [] for app-scoped docs).
      if (args.where.knowledgeAccessMode === 'full') {
        return Promise.resolve([makeAgent({ id: 'a-full', knowledgeAccessMode: 'full' })]);
      }
      return Promise.resolve([]);
    });

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: VALID_DOC_ID }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { agents: Array<{ id: string; paths: Array<{ kind: string }> }> };
    };
    expect(body.data.agents).toHaveLength(1);
    expect(body.data.agents[0].id).toBe('a-full');
    expect(body.data.agents[0].paths).toEqual([{ kind: 'full' }]);
  });

  it('includes direct-grant agents with a {kind: "direct"} path', async () => {
    mockDirectFindMany.mockResolvedValue([{ agent: makeAgent({ id: 'a-direct' }) }]);

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: VALID_DOC_ID }) });
    const body = (await res.json()) as {
      data: { agents: Array<{ id: string; paths: Array<{ kind: string }> }> };
    };
    expect(body.data.agents).toEqual([
      expect.objectContaining({ id: 'a-direct', paths: [{ kind: 'direct' }] }),
    ]);
  });

  it('includes tag-grant agents with a {kind: "tag", tagId, tagName, tagSlug} path', async () => {
    mockDocTagFindMany.mockResolvedValue([{ tagId: 'tag-1' }]);
    mockTagFindMany.mockResolvedValue([
      {
        tagId: 'tag-1',
        tag: { id: 'tag-1', name: 'Sales', slug: 'sales' },
        agent: makeAgent({ id: 'a-tag' }),
      },
    ]);

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: VALID_DOC_ID }) });
    const body = (await res.json()) as {
      data: {
        agents: Array<{
          id: string;
          paths: Array<{ kind: string; tagId?: string; tagName?: string; tagSlug?: string }>;
        }>;
      };
    };
    expect(body.data.agents[0].paths).toEqual([
      { kind: 'tag', tagId: 'tag-1', tagName: 'Sales', tagSlug: 'sales' },
    ]);
  });

  it('short-circuits the tag query when the document has no tags', async () => {
    // Default mock: empty docTags. The route should NOT call
    // aiAgentKnowledgeTag.findMany at all in that branch.
    await GET(makeRequest(), { params: Promise.resolve({ id: VALID_DOC_ID }) });
    expect(mockTagFindMany).not.toHaveBeenCalled();
  });

  it('adds a {kind: "system"} path to every restricted agent when the document scope is system', async () => {
    mockDocumentFindUnique.mockResolvedValue({ id: VALID_DOC_ID, scope: 'system' });
    mockAgentFindMany.mockImplementation((args: { where: { knowledgeAccessMode?: string } }) => {
      if (args.where.knowledgeAccessMode === 'restricted') {
        return Promise.resolve([makeAgent({ id: 'a-restricted' })]);
      }
      return Promise.resolve([]);
    });

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: VALID_DOC_ID }) });
    const body = (await res.json()) as {
      data: {
        documentScope: string;
        agents: Array<{ id: string; paths: Array<{ kind: string }> }>;
      };
    };
    expect(body.data.documentScope).toBe('system');
    expect(body.data.agents).toEqual([
      expect.objectContaining({ id: 'a-restricted', paths: [{ kind: 'system' }] }),
    ]);
  });

  it('folds multiple paths onto the same agent (direct + tag)', async () => {
    const agent = makeAgent({ id: 'a-multi' });
    mockDirectFindMany.mockResolvedValue([{ agent }]);
    mockDocTagFindMany.mockResolvedValue([{ tagId: 'tag-1' }]);
    mockTagFindMany.mockResolvedValue([
      { tagId: 'tag-1', tag: { id: 'tag-1', name: 'Sales', slug: 'sales' }, agent },
    ]);

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: VALID_DOC_ID }) });
    const body = (await res.json()) as {
      data: { agents: Array<{ id: string; paths: Array<{ kind: string }> }> };
    };
    expect(body.data.agents).toHaveLength(1);
    expect(body.data.agents[0].paths).toEqual([
      { kind: 'direct' },
      { kind: 'tag', tagId: 'tag-1', tagName: 'Sales', tagSlug: 'sales' },
    ]);
  });

  it('sorts the result alphabetically by agent name', async () => {
    mockAgentFindMany.mockImplementation((args: { where: { knowledgeAccessMode?: string } }) => {
      if (args.where.knowledgeAccessMode === 'full') {
        return Promise.resolve([
          makeAgent({ id: 'a-z', name: 'Zelda', knowledgeAccessMode: 'full' }),
          makeAgent({ id: 'a-a', name: 'Apollo', knowledgeAccessMode: 'full' }),
        ]);
      }
      return Promise.resolve([]);
    });

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: VALID_DOC_ID }) });
    const body = (await res.json()) as {
      data: { agents: Array<{ name: string }> };
    };
    expect(body.data.agents.map((a) => a.name)).toEqual(['Apollo', 'Zelda']);
  });

  it('filters all queries by isActive=true and deletedAt=null', async () => {
    await GET(makeRequest(), { params: Promise.resolve({ id: VALID_DOC_ID }) });

    // Both aiAgent.findMany calls must carry the activeFilter shape.
    for (const call of mockAgentFindMany.mock.calls) {
      const arg = call[0] as { where: { isActive?: boolean; deletedAt?: null } };
      expect(arg.where.isActive).toBe(true);
      expect(arg.where.deletedAt).toBeNull();
    }
    // The direct-grant query nests the activeFilter under `agent`.
    const directCall = mockDirectFindMany.mock.calls[0][0] as {
      where: { agent: { isActive?: boolean; deletedAt?: null } };
    };
    expect(directCall.where.agent.isActive).toBe(true);
    expect(directCall.where.agent.deletedAt).toBeNull();
  });
});
