/**
 * Knowledge Base Seeder Unit Tests
 *
 * Tests for the two-phase seeder:
 *
 * seedChunks (Phase 1):
 * - Idempotency: skips seeding if document already exists
 * - Cleans up failed documents before re-seeding
 * - Happy path: reads file, resolves uploader, creates doc, inserts chunks (no embeddings)
 * - ADMIN user fallback to any user
 * - No users: throws with descriptive message
 * - File read / JSON parse error propagation
 *
 * embedChunks (Phase 2):
 * - Skips when all chunks already embedded
 * - Embeds only NULL-embedding chunks
 * - Propagates embedding errors
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';

// --- Mocks ---

vi.mock('fs/promises', () => {
  const mockReadFile = vi.fn();
  return {
    readFile: mockReadFile,
    default: { readFile: mockReadFile },
  };
});

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiKnowledgeDocument: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    aiKnowledgeChunk: {
      count: vi.fn(),
      deleteMany: vi.fn(),
    },
    knowledgeTag: {
      upsert: vi.fn(),
    },
    aiKnowledgeDocumentTag: {
      upsert: vi.fn(),
    },
    aiAgent: {
      findMany: vi.fn(),
    },
    aiAgentKnowledgeTag: {
      upsert: vi.fn(),
    },
    user: {
      findFirst: vi.fn(),
    },
    aiOrchestrationSettings: {
      upsert: vi.fn(),
    },
    $executeRawUnsafe: vi.fn(),
    $queryRawUnsafe: vi.fn(),
  },
}));

vi.mock('@/lib/orchestration/knowledge/embedder', () => ({
  embedBatch: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// --- Imports after mocks ---

import { readFile } from 'fs/promises';
import { prisma } from '@/lib/db/client';
import { embedBatch } from '@/lib/orchestration/knowledge/embedder';
import type { EmbedBatchResult } from '@/lib/orchestration/knowledge/embedder';
import { seedChunks, embedChunks } from '@/lib/orchestration/knowledge/seeder';

// --- Helpers ---

function mockEmbedResult(embeddings: number[][]): EmbedBatchResult {
  return {
    embeddings,
    provenance: {
      model: 'test-model',
      provider: 'test-provider',
      embeddedAt: new Date('2026-01-01'),
    },
  };
}

function makeSeedChunk(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chunk-001',
    chunk_id: 1,
    content: 'Pattern content here',
    metadata: {
      type: 'pattern',
      section: 'intro',
      section_title: 'Introduction',
      pattern_number: 1,
      pattern_name: 'Test Pattern',
      pattern_id: 'tp-001',
      category: 'orchestration',
      complexity: 'medium',
      related_patterns: ['pattern-2'],
      keywords: 'ai,agents',
      source: 'handbook',
    },
    estimated_tokens: 150,
    ...overrides,
  };
}

function makeDocument(overrides = {}) {
  return {
    id: 'seed-doc-id',
    name: 'Agentic Design Patterns',
    fileName: 'agentic-design-patterns.md',
    fileHash: 'hash-abc',
    status: 'ready',
    chunkCount: 0,
    uploadedBy: 'user-001',
    errorMessage: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    ...overrides,
  };
}

const CHUNKS_PATH = '/data/chunks.json';

// --- Phase 1: seedChunks ---

describe('seedChunks', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // New seeder upserts tags and document↔tag links; default no-op mocks keep tests
    // focused on the legacy assertions (chunk insert SQL, uploader resolution, etc.).
    (
      vi.mocked(prisma.knowledgeTag.upsert) as unknown as {
        mockImplementation: (fn: (args: unknown) => unknown) => void;
      }
    ).mockImplementation((args: unknown) => {
      const a = args as { where: { slug: string }; create: { slug: string; name: string } };
      return Promise.resolve({
        id: `tag-${a.where.slug}`,
        slug: a.where.slug,
        name: a.create?.name ?? a.where.slug,
      });
    });
    vi.mocked(prisma.aiKnowledgeDocumentTag.upsert).mockResolvedValue({} as never);
    vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue({} as never);
    // Most tests don't care about the bidirectional system-agent grant —
    // default to "no system agents seeded yet" so the loop is a no-op.
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.aiAgentKnowledgeTag.upsert).mockResolvedValue({} as never);
  });

  it('grants the patterns tag to existing system agents (pattern-advisor, quiz-master)', async () => {
    // Bidirectional safety net: if the prisma seeds have already created
    // the system agents, loading the patterns should grant them the tag
    // so the relationship is explicit in the admin UI. Idempotent — the
    // upsert is keyed on (agentId, tagId).
    const chunks = [makeSeedChunk({ id: 'c1', content: 'Content A' })];
    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(null as never);
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(chunks) as never);
    vi.mocked(prisma.user.findFirst)
      .mockResolvedValueOnce({ id: 'admin-001' } as never)
      .mockResolvedValueOnce({ id: 'user-001' } as never);
    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(makeDocument() as never);
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([
      { id: 'agent-pa', slug: 'pattern-advisor' },
      { id: 'agent-qm', slug: 'quiz-master' },
    ] as never);

    await seedChunks(CHUNKS_PATH);

    expect(prisma.aiAgent.findMany).toHaveBeenCalledWith({
      where: { slug: { in: ['pattern-advisor', 'quiz-master'] } },
      select: { id: true, slug: true },
    });
    expect(prisma.aiAgentKnowledgeTag.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.aiAgentKnowledgeTag.upsert).toHaveBeenCalledWith({
      where: { agentId_tagId: { agentId: 'agent-pa', tagId: 'tag-agentic-design-patterns' } },
      create: { agentId: 'agent-pa', tagId: 'tag-agentic-design-patterns' },
      update: {},
    });
    expect(prisma.aiAgentKnowledgeTag.upsert).toHaveBeenCalledWith({
      where: { agentId_tagId: { agentId: 'agent-qm', tagId: 'tag-agentic-design-patterns' } },
      create: { agentId: 'agent-qm', tagId: 'tag-agentic-design-patterns' },
      update: {},
    });
  });

  it('skips the system-agent grant loop when no system agents are seeded yet', async () => {
    const chunks = [makeSeedChunk({ id: 'c1', content: 'Content A' })];
    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(null as never);
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(chunks) as never);
    vi.mocked(prisma.user.findFirst)
      .mockResolvedValueOnce({ id: 'admin-001' } as never)
      .mockResolvedValueOnce({ id: 'user-001' } as never);
    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(makeDocument() as never);
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);
    // beforeEach already mocks aiAgent.findMany → [], so no grants should fire.

    await seedChunks(CHUNKS_PATH);

    expect(prisma.aiAgentKnowledgeTag.upsert).not.toHaveBeenCalled();
  });

  it('skips when the legacy single document already exists (refuses to silently delete embeddings)', async () => {
    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(
      makeDocument({ status: 'ready' }) as never
    );

    await seedChunks(CHUNKS_PATH);

    expect(vi.mocked(readFile)).not.toHaveBeenCalled();
    expect(prisma.aiKnowledgeDocument.create).not.toHaveBeenCalled();
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('detects the legacy single document by its exact name', async () => {
    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(
      makeDocument({ status: 'ready' }) as never
    );

    await seedChunks(CHUNKS_PATH);

    expect(prisma.aiKnowledgeDocument.findFirst).toHaveBeenCalledWith({
      where: { name: 'Agentic Design Patterns' },
    });
  });

  it('cleans up a failed seed document before re-seeding', async () => {
    const failedDoc = makeDocument({ id: 'failed-doc', status: 'failed' });
    const chunks = [makeSeedChunk()];

    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(failedDoc as never);
    vi.mocked(prisma.aiKnowledgeChunk.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.aiKnowledgeDocument.delete).mockResolvedValue(failedDoc as never);
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(chunks) as never);
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 'user-001' } as never);
    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(makeDocument() as never);
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);

    await seedChunks(CHUNKS_PATH);

    expect(prisma.aiKnowledgeChunk.deleteMany).toHaveBeenCalledWith({
      where: { documentId: 'failed-doc' },
    });
    expect(prisma.aiKnowledgeDocument.delete).toHaveBeenCalledWith({
      where: { id: 'failed-doc' },
    });
    expect(prisma.aiKnowledgeDocument.create).toHaveBeenCalled();
  });

  it('seeds successfully without calling embedBatch', async () => {
    const chunks = [makeSeedChunk({ id: 'c1', content: 'Content A' })];

    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(null as never);
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(chunks) as never);
    vi.mocked(prisma.user.findFirst)
      .mockResolvedValueOnce({ id: 'admin-001' } as never)
      .mockResolvedValueOnce({ id: 'user-001' } as never);
    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(makeDocument() as never);
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);

    await seedChunks(CHUNKS_PATH);

    expect(embedBatch).not.toHaveBeenCalled();
    expect(prisma.aiKnowledgeDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          uploadedBy: 'admin-001',
          status: 'ready',
          chunkCount: 1,
        }),
      })
    );
  });

  it('falls back to any user when no ADMIN user exists', async () => {
    const chunks = [makeSeedChunk()];

    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(null as never);
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(chunks) as never);
    vi.mocked(prisma.user.findFirst)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce({ id: 'regular-user' } as never);
    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(
      makeDocument({ uploadedBy: 'regular-user' }) as never
    );
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);

    await seedChunks(CHUNKS_PATH);

    expect(prisma.aiKnowledgeDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ uploadedBy: 'regular-user' }),
      })
    );
  });

  it('throws with a descriptive message when no users exist at all', async () => {
    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(null as never);
    vi.mocked(readFile).mockResolvedValue(JSON.stringify([makeSeedChunk()]) as never);
    vi.mocked(prisma.user.findFirst)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce(null as never);

    await expect(seedChunks(CHUNKS_PATH)).rejects.toThrow(/No users/);

    expect(prisma.aiKnowledgeDocument.create).not.toHaveBeenCalled();
  });

  it('computes fileHash as sha256 of joined chunk contents', async () => {
    const chunks = [
      makeSeedChunk({ id: 'c1', content: 'Alpha' }),
      makeSeedChunk({ id: 'c2', content: 'Beta' }),
    ];
    const expectedHash = createHash('sha256').update('AlphaBeta').digest('hex');

    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(null as never);
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(chunks) as never);
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 'user-001' } as never);
    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(makeDocument() as never);
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);

    await seedChunks(CHUNKS_PATH);

    expect(prisma.aiKnowledgeDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ fileHash: expectedHash }),
      })
    );
  });

  it('inserts chunks without embedding column via $executeRawUnsafe', async () => {
    const chunk = makeSeedChunk();
    const doc = makeDocument();

    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(null as never);
    vi.mocked(readFile).mockResolvedValue(JSON.stringify([chunk]) as never);
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 'user-001' } as never);
    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(doc as never);
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);

    await seedChunks(CHUNKS_PATH);

    expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.$executeRawUnsafe).mock.calls[0];
    const sql = call[0];

    // Should NOT include embedding or ::vector
    expect(sql).not.toContain('embedding');
    expect(sql).not.toContain('::vector');

    // Positional params: [sql, $1=chunkKey, $2=docId, $3=content,
    //   $4=chunkType, $5=patternNumber, $6=patternName,
    //   $7=section, $8=keywords, $9=estimatedTokens, $10=metadata]
    expect(call[1]).toBe(chunk.id); // chunkKey
    expect(call[2]).toBe(doc.id); // documentId
    expect(call[3]).toBe(chunk.content); // content
    expect(call[4]).toBe(chunk.metadata.type); // chunkType
    expect(call[5]).toBe(chunk.metadata.pattern_number); // patternNumber
    expect(call[6]).toBe(chunk.metadata.pattern_name); // patternName
    expect(call[7]).toBe(chunk.metadata.section_title); // section
    expect(call[8]).toBe(chunk.metadata.keywords); // keywords
    expect(call[9]).toBe(chunk.estimated_tokens); // estimatedTokens
  });

  it('propagates file read errors', async () => {
    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(null as never);
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT: no such file'));

    await expect(seedChunks('/bad/path/chunks.json')).rejects.toThrow('ENOENT: no such file');
  });

  it('propagates JSON parse errors from malformed file content', async () => {
    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(null as never);
    vi.mocked(readFile).mockResolvedValue('{ this is not valid json' as never);

    await expect(seedChunks(CHUNKS_PATH)).rejects.toThrow();
  });

  it('throws a descriptive error when chunks.json has a valid-JSON but invalid shape', async () => {
    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(null as never);
    // Valid JSON, but `content` field is missing — fails the Zod schema
    const badChunks = [
      { id: 'bad-chunk', chunk_id: 1, metadata: { type: 'overview' }, estimated_tokens: 50 },
    ];
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(badChunks) as never);

    await expect(seedChunks(CHUNKS_PATH)).rejects.toThrow(/Invalid chunks\.json/);
    await expect(seedChunks(CHUNKS_PATH)).rejects.toThrow(CHUNKS_PATH);
  });

  it('passes null for optional metadata fields when they are absent', async () => {
    const minimalChunk = {
      id: 'minimal-chunk',
      chunk_id: 1,
      content: 'Minimal content',
      metadata: { type: 'overview' },
      estimated_tokens: 50,
    };
    const doc = makeDocument();

    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(null as never);
    vi.mocked(readFile).mockResolvedValue(JSON.stringify([minimalChunk]) as never);
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 'user-001' } as never);
    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(doc as never);
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);

    await seedChunks(CHUNKS_PATH);

    const call = vi.mocked(prisma.$executeRawUnsafe).mock.calls[0];
    expect(call[5]).toBeNull(); // patternNumber
    expect(call[6]).toBeNull(); // patternName
    expect(call[7]).toBeNull(); // section
    expect(call[8]).toBeNull(); // keywords
  });
});

// --- Phase 2: embedChunks ---

describe('embedChunks', () => {
  beforeEach(() => vi.resetAllMocks());

  it('returns immediately when all chunks are already embedded', async () => {
    vi.mocked(prisma.aiKnowledgeChunk.count).mockResolvedValue(10 as never);
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([] as never);

    const result = await embedChunks();

    expect(result).toEqual({ processed: 0, total: 10, alreadyEmbedded: 10 });
    expect(embedBatch).not.toHaveBeenCalled();
  });

  it('embeds only chunks with NULL embedding and updates them', async () => {
    const pending = [
      { id: 'c1', content: 'Chunk 1' },
      { id: 'c2', content: 'Chunk 2' },
    ];

    vi.mocked(prisma.aiKnowledgeChunk.count).mockResolvedValue(5 as never);
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue(pending as never);
    vi.mocked(embedBatch).mockResolvedValue(
      mockEmbedResult([
        [0.1, 0.2],
        [0.3, 0.4],
      ])
    );
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);

    const result = await embedChunks();

    expect(result).toEqual({ processed: 2, total: 5, alreadyEmbedded: 3 });
    expect(embedBatch).toHaveBeenCalledWith(['Chunk 1', 'Chunk 2']);
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(2);

    // Verify UPDATE calls
    const call1 = vi.mocked(prisma.$executeRawUnsafe).mock.calls[0];
    expect(call1[0]).toContain('UPDATE');
    expect(call1[1]).toBe('[0.1,0.2]');
    expect(call1[2]).toBe('c1');

    const call2 = vi.mocked(prisma.$executeRawUnsafe).mock.calls[1];
    expect(call2[1]).toBe('[0.3,0.4]');
    expect(call2[2]).toBe('c2');
  });

  it('propagates embedding errors', async () => {
    vi.mocked(prisma.aiKnowledgeChunk.count).mockResolvedValue(3 as never);
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([{ id: 'c1', content: 'text' }] as never);
    vi.mocked(embedBatch).mockRejectedValue(new Error('Provider unavailable'));

    await expect(embedChunks()).rejects.toThrow('Provider unavailable');
  });
});
