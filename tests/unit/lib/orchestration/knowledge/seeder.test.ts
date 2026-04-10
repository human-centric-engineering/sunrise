/**
 * Knowledge Base Seeder Unit Tests
 *
 * Tests for seedFromChunksJson:
 * - Idempotency: skips seeding if document already exists
 * - Happy path: reads file, resolves uploader, creates doc, embeds, inserts chunks
 * - ADMIN user fallback to any user
 * - No users: throws with descriptive message
 * - File read error propagation
 * - JSON parse error propagation
 * - Embed failure: marks document failed, re-throws
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
    },
    user: {
      findFirst: vi.fn(),
    },
    $executeRawUnsafe: vi.fn(),
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
import { seedFromChunksJson } from '@/lib/orchestration/knowledge/seeder';

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
    status: 'processing',
    chunkCount: 0,
    uploadedBy: 'user-001',
    errorMessage: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    ...overrides,
  };
}

const CHUNKS_PATH = '/data/chunks.json';

// --- Tests ---

describe('seedFromChunksJson', () => {
  beforeEach(() => vi.resetAllMocks());

  it('returns early without reading file or writing when document already exists', async () => {
    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(
      makeDocument({ status: 'ready' }) as never
    );

    await seedFromChunksJson(CHUNKS_PATH);

    expect(vi.mocked(readFile)).not.toHaveBeenCalled();
    expect(prisma.aiKnowledgeDocument.create).not.toHaveBeenCalled();
    expect(embedBatch).not.toHaveBeenCalled();
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('checks for existing doc by the exact document name', async () => {
    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(
      makeDocument({ status: 'ready' }) as never
    );

    await seedFromChunksJson(CHUNKS_PATH);

    expect(prisma.aiKnowledgeDocument.findFirst).toHaveBeenCalledWith({
      where: { name: 'Agentic Design Patterns' },
    });
  });

  it('seeds successfully using an ADMIN user as uploader', async () => {
    const chunks = [makeSeedChunk({ id: 'c1', content: 'Content A' })];
    const doc = makeDocument();

    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(null as never);
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(chunks) as never);
    vi.mocked(prisma.user.findFirst)
      .mockResolvedValueOnce({ id: 'admin-001' } as never) // ADMIN query
      .mockResolvedValueOnce({ id: 'user-001' } as never); // fallback query (not called in this path)
    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(doc as never);
    vi.mocked(embedBatch).mockResolvedValue([[0.1, 0.2]]);
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(
      makeDocument({ status: 'ready', chunkCount: 1 }) as never
    );

    await seedFromChunksJson(CHUNKS_PATH);

    expect(prisma.aiKnowledgeDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          uploadedBy: 'admin-001',
          status: 'processing',
        }),
      })
    );
  });

  it('falls back to any user when no ADMIN user exists', async () => {
    const chunks = [makeSeedChunk()];
    const doc = makeDocument({ uploadedBy: 'regular-user' });

    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(null as never);
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(chunks) as never);
    vi.mocked(prisma.user.findFirst)
      .mockResolvedValueOnce(null as never) // ADMIN query returns null
      .mockResolvedValueOnce({ id: 'regular-user' } as never); // fallback query
    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(doc as never);
    vi.mocked(embedBatch).mockResolvedValue([[0.5]]);
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(
      makeDocument({ status: 'ready', chunkCount: 1 }) as never
    );

    await seedFromChunksJson(CHUNKS_PATH);

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
      .mockResolvedValueOnce(null as never) // ADMIN
      .mockResolvedValueOnce(null as never); // fallback

    await expect(seedFromChunksJson(CHUNKS_PATH)).rejects.toThrow(/No users/);

    expect(prisma.aiKnowledgeDocument.create).not.toHaveBeenCalled();
  });

  it('computes fileHash as sha256 of joined chunk contents', async () => {
    const chunks = [
      makeSeedChunk({ id: 'c1', content: 'Alpha' }),
      makeSeedChunk({ id: 'c2', content: 'Beta' }),
    ];
    const expectedHash = createHash('sha256').update('AlphaBeta').digest('hex');
    const doc = makeDocument({ fileHash: expectedHash });

    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(null as never);
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(chunks) as never);
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 'user-001' } as never);
    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(doc as never);
    vi.mocked(embedBatch).mockResolvedValue([[0.1], [0.2]]);
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(
      makeDocument({ status: 'ready', chunkCount: 2 }) as never
    );

    await seedFromChunksJson(CHUNKS_PATH);

    expect(prisma.aiKnowledgeDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ fileHash: expectedHash }),
      })
    );
  });

  it('inserts each chunk via $executeRawUnsafe with mapped metadata fields', async () => {
    const chunk = makeSeedChunk();
    const doc = makeDocument();

    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(null as never);
    vi.mocked(readFile).mockResolvedValue(JSON.stringify([chunk]) as never);
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 'user-001' } as never);
    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(doc as never);
    vi.mocked(embedBatch).mockResolvedValue([[0.1, 0.2, 0.3]]);
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(
      makeDocument({ status: 'ready', chunkCount: 1 }) as never
    );

    await seedFromChunksJson(CHUNKS_PATH);

    expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.$executeRawUnsafe).mock.calls[0];
    const [
      sql,
      chunkKey,
      documentId,
      content,
      embeddingStr,
      chunkType,
      patternNumber,
      patternName,
      category,
      section,
      keywords,
      estimatedTokens,
      metadata,
    ] = call as [string, ...unknown[]];

    expect(sql).toContain('::vector');
    expect(chunkKey).toBe(chunk.id);
    expect(documentId).toBe(doc.id);
    expect(content).toBe(chunk.content);
    expect(embeddingStr).toBe('[0.1,0.2,0.3]');
    expect(chunkType).toBe(chunk.metadata.type);
    expect(patternNumber).toBe(chunk.metadata.pattern_number);
    expect(patternName).toBe(chunk.metadata.pattern_name);
    expect(category).toBe(chunk.metadata.category);
    // section_title takes precedence over section
    expect(section).toBe(chunk.metadata.section_title);
    expect(keywords).toBe(chunk.metadata.keywords);
    expect(estimatedTokens).toBe(chunk.estimated_tokens);
    const parsedMeta = JSON.parse(metadata as string);
    expect(parsedMeta.complexity).toBe(chunk.metadata.complexity);
    expect(parsedMeta.relatedPatterns).toEqual(chunk.metadata.related_patterns);
    expect(parsedMeta.patternId).toBe(chunk.metadata.pattern_id);
    expect(parsedMeta.source).toBe(chunk.metadata.source);
  });

  it('uses section when section_title is absent', async () => {
    const chunk = makeSeedChunk();
    // Remove section_title so source falls back to section
    const chunkWithoutTitle = {
      ...chunk,
      metadata: { ...chunk.metadata, section_title: undefined },
    };
    const doc = makeDocument();

    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(null as never);
    vi.mocked(readFile).mockResolvedValue(JSON.stringify([chunkWithoutTitle]) as never);
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 'user-001' } as never);
    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(doc as never);
    vi.mocked(embedBatch).mockResolvedValue([[0.1]]);
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(
      makeDocument({ status: 'ready', chunkCount: 1 }) as never
    );

    await seedFromChunksJson(CHUNKS_PATH);

    const call = vi.mocked(prisma.$executeRawUnsafe).mock.calls[0];
    // section is positional param $9 (index 9 in the call = index 8 after sql)
    const section = call[9];
    expect(section).toBe(chunk.metadata.section);
  });

  it('updates document to ready with correct chunkCount after successful seed', async () => {
    const chunks = [makeSeedChunk({ id: 'c1' }), makeSeedChunk({ id: 'c2' })];
    const doc = makeDocument({ id: 'seed-doc' });

    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(null as never);
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(chunks) as never);
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 'user-001' } as never);
    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(doc as never);
    vi.mocked(embedBatch).mockResolvedValue([[0.1], [0.2]]);
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(
      makeDocument({ status: 'ready', chunkCount: 2 }) as never
    );

    await seedFromChunksJson(CHUNKS_PATH);

    expect(prisma.aiKnowledgeDocument.update).toHaveBeenCalledWith({
      where: { id: 'seed-doc' },
      data: { status: 'ready', chunkCount: 2 },
    });
  });

  it('propagates file read errors', async () => {
    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(null as never);
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT: no such file'));

    await expect(seedFromChunksJson('/bad/path/chunks.json')).rejects.toThrow(
      'ENOENT: no such file'
    );
  });

  it('propagates JSON parse errors from malformed file content', async () => {
    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(null as never);
    vi.mocked(readFile).mockResolvedValue('{ this is not valid json' as never);

    await expect(seedFromChunksJson(CHUNKS_PATH)).rejects.toThrow();
  });

  it('marks document failed and re-throws when embedBatch rejects', async () => {
    const chunks = [makeSeedChunk()];
    const doc = makeDocument({ id: 'seed-fail-doc' });
    const embedError = new Error('Embed quota exceeded');

    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(null as never);
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(chunks) as never);
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 'user-001' } as never);
    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(doc as never);
    vi.mocked(embedBatch).mockRejectedValue(embedError);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(makeDocument() as never);

    await expect(seedFromChunksJson(CHUNKS_PATH)).rejects.toThrow('Embed quota exceeded');

    expect(prisma.aiKnowledgeDocument.update).toHaveBeenCalledWith({
      where: { id: 'seed-fail-doc' },
      data: { status: 'failed', errorMessage: 'Embed quota exceeded' },
    });
  });

  it('uses "Unknown error" as errorMessage when a non-Error value is thrown during seeding', async () => {
    const chunks = [makeSeedChunk()];
    const doc = makeDocument({ id: 'seed-non-error-doc' });

    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(null as never);
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(chunks) as never);
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 'user-001' } as never);
    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(doc as never);
    vi.mocked(embedBatch).mockRejectedValue('non-error string'); // non-Error throw
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(makeDocument() as never);

    await expect(seedFromChunksJson(CHUNKS_PATH)).rejects.toBe('non-error string');

    expect(prisma.aiKnowledgeDocument.update).toHaveBeenCalledWith({
      where: { id: 'seed-non-error-doc' },
      data: { status: 'failed', errorMessage: 'Unknown error' },
    });
  });

  it('passes null for optional metadata fields when they are absent', async () => {
    // Test the ?? null branches: chunk with no optional metadata fields
    const minimalChunk = {
      id: 'minimal-chunk',
      chunk_id: 1,
      content: 'Minimal content',
      metadata: {
        type: 'overview',
        // all optional fields absent
      },
      estimated_tokens: 50,
    };
    const doc = makeDocument();

    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(null as never);
    vi.mocked(readFile).mockResolvedValue(JSON.stringify([minimalChunk]) as never);
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 'user-001' } as never);
    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(doc as never);
    vi.mocked(embedBatch).mockResolvedValue([[0.5]]);
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(
      makeDocument({ status: 'ready', chunkCount: 1 }) as never
    );

    await seedFromChunksJson(CHUNKS_PATH);

    const call = vi.mocked(prisma.$executeRawUnsafe).mock.calls[0];
    // Positional params: [sql, $1=chunkKey, $2=docId, $3=content, $4=embedding,
    //   $5=chunkType, $6=patternNumber, $7=patternName, $8=category,
    //   $9=section, $10=keywords, $11=estimatedTokens, $12=metadata]
    expect(call[6]).toBeNull(); // patternNumber
    expect(call[7]).toBeNull(); // patternName
    expect(call[8]).toBeNull(); // category
    expect(call[9]).toBeNull(); // section (section_title ?? section ?? null)
    expect(call[10]).toBeNull(); // keywords

    const parsedMeta = JSON.parse(call[12] as string);
    expect(parsedMeta.complexity).toBeNull();
    expect(parsedMeta.relatedPatterns).toBeNull();
    expect(parsedMeta.patternId).toBeNull();
    expect(parsedMeta.source).toBeNull();
  });
});
