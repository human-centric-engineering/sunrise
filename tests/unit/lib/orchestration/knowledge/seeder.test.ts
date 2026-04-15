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
    user: {
      findFirst: vi.fn(),
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
import { seedChunks, embedChunks } from '@/lib/orchestration/knowledge/seeder';

// --- Helpers ---

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
  beforeEach(() => vi.resetAllMocks());

  it('returns early without reading file or writing when document already exists', async () => {
    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(
      makeDocument({ status: 'ready' }) as never
    );

    await seedChunks(CHUNKS_PATH);

    expect(vi.mocked(readFile)).not.toHaveBeenCalled();
    expect(prisma.aiKnowledgeDocument.create).not.toHaveBeenCalled();
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('checks for existing doc by the exact document name', async () => {
    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(
      makeDocument({ status: 'ready' }) as never
    );

    await seedChunks(CHUNKS_PATH);

    expect(prisma.aiKnowledgeDocument.findFirst).toHaveBeenCalledWith({
      where: { name: 'Agentic Design Patterns' },
    });
  });

  it('cleans up a failed document before re-seeding', async () => {
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
    //   $4=chunkType, $5=patternNumber, $6=patternName, $7=category,
    //   $8=section, $9=keywords, $10=estimatedTokens, $11=metadata]
    expect(call[1]).toBe(chunk.id); // chunkKey
    expect(call[2]).toBe(doc.id); // documentId
    expect(call[3]).toBe(chunk.content); // content
    expect(call[4]).toBe(chunk.metadata.type); // chunkType
    expect(call[5]).toBe(chunk.metadata.pattern_number); // patternNumber
    expect(call[6]).toBe(chunk.metadata.pattern_name); // patternName
    expect(call[7]).toBe(chunk.metadata.category); // category
    expect(call[8]).toBe(chunk.metadata.section_title); // section
    expect(call[9]).toBe(chunk.metadata.keywords); // keywords
    expect(call[10]).toBe(chunk.estimated_tokens); // estimatedTokens
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
    expect(call[7]).toBeNull(); // category
    expect(call[8]).toBeNull(); // section
    expect(call[9]).toBeNull(); // keywords
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
    vi.mocked(embedBatch).mockResolvedValue([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
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
