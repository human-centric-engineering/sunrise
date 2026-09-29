/**
 * Knowledge Base Seeder Unit Tests
 *
 * materialisePatternsKnowledge (Phase 1, §116 t-726):
 * - Writes the calling org's copy into that org's own default knowledge base
 * - Idempotent by slug; an earlier or failed copy is left in place; a lost race reports 'present'
 * - Document, chunks and tag link in one transaction, through the caller's client
 * - Uploader: service account, then any user, else a descriptive error
 * - Chunks written in one createMany, stamped by the chokepoint, with no embedding
 *
 * loadPatternsChunks / PATTERNS_DOCUMENT_SLUG:
 * - The bundled chunk file parses, and the constant is the slug it produces
 *
 * seedChunks:
 * - Reads and validates the file, materialises in the caller's org, records lastSeededAt
 * - File read / JSON parse / shape errors propagate
 *
 * embedChunks (Phase 2):
 * - Skips when all chunks already embedded
 * - Embeds only NULL-embedding chunks
 * - Propagates embedding errors
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';

// --- Mocks ---

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'multi' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

vi.mock('fs/promises', () => {
  const mockReadFile = vi.fn();
  return {
    readFile: mockReadFile,
    default: { readFile: mockReadFile },
  };
});

/** A client's delegates: the default client and a transaction client each get their own. */
function makeClient() {
  return {
    aiKnowledgeDocument: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    aiKnowledgeChunk: {
      count: vi.fn(),
      createMany: vi.fn(),
    },
    knowledgeTag: {
      upsert: vi.fn(),
    },
    aiKnowledgeDocumentTag: {
      create: vi.fn(),
    },
    user: {
      findFirst: vi.fn(),
    },
    aiOrchestrationSettings: {
      upsert: vi.fn(),
    },
    $executeRawUnsafe: vi.fn(),
    $queryRawUnsafe: vi.fn(),
    $transaction: vi.fn(),
  };
}

vi.mock('@/lib/db/client', () => ({ prisma: makeClient() }));

vi.mock('@/lib/orchestration/knowledge/document-manager', () => ({
  getOrCreateDefaultKnowledgeBase: vi.fn(),
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
import { logger } from '@/lib/logging';
import { getOrCreateDefaultKnowledgeBase } from '@/lib/orchestration/knowledge/document-manager';
import { buildDocumentSlugBase } from '@/lib/orchestration/knowledge/document-slug';
import { embedBatch } from '@/lib/orchestration/knowledge/embedder';
import type { EmbedBatchResult } from '@/lib/orchestration/knowledge/embedder';
import {
  PATTERNS_DOCUMENT_NAME,
  PATTERNS_DOCUMENT_SLUG,
  PATTERNS_TAG_SLUG,
} from '@/lib/orchestration/knowledge/patterns-knowledge';
import {
  embedChunks,
  loadPatternsChunks,
  materialisePatternsKnowledge,
  parseSeedChunks,
  seedChunks,
  type SeedChunk,
} from '@/lib/orchestration/knowledge/seeder';
import { runAsOrg } from '@/lib/tenancy/context';

type Client = ReturnType<typeof makeClient>;
const db = prisma as unknown as Client;

// --- Helpers ---

const ORG_B = 'cmorg00000000000000000orgb';

function mockEmbedResult(embeddings: number[][]): EmbedBatchResult {
  return {
    embeddings,
    provenance: {
      model: 'test-model',
      provider: 'test-provider',
      dimensions: 1536,
      embeddedAt: new Date('2026-01-01'),
    },
  };
}

function makeSeedChunk(overrides: Partial<SeedChunk> = {}): SeedChunk {
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

function slugFor(chunks: SeedChunk[]): string {
  const hash = createHash('sha256')
    .update(chunks.map((c) => c.content).join(''))
    .digest('hex');
  return buildDocumentSlugBase(PATTERNS_DOCUMENT_NAME, hash);
}

/**
 * Arm `client` for a first copy: nothing held, a service account, a tag.
 * The transaction runs its callback against a SEPARATE client, so a test can
 * tell a write made inside it from one made outside.
 */
function armFirstCopy(client: Client): Client {
  const tx = makeClient();
  client.aiKnowledgeDocument.findMany.mockResolvedValue([]);
  client.user.findFirst.mockResolvedValue({ id: 'service-account' });
  client.knowledgeTag.upsert.mockResolvedValue({ id: 'tag-patterns', slug: PATTERNS_TAG_SLUG });
  client.$transaction.mockImplementation(async (fn: (t: Client) => Promise<unknown>) => fn(tx));
  tx.aiKnowledgeDocument.create.mockResolvedValue({ id: 'doc-b' });
  tx.aiKnowledgeChunk.createMany.mockResolvedValue({ count: 1 });
  tx.aiKnowledgeDocumentTag.create.mockResolvedValue({});
  vi.mocked(getOrCreateDefaultKnowledgeBase).mockResolvedValue('kb-org-b');
  return tx;
}

const inOrgB = <T>(fn: () => Promise<T>) => runAsOrg(ORG_B, fn);

// --- Phase 1: materialisePatternsKnowledge ---

describe('materialisePatternsKnowledge', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockEnv.TENANCY_MODE = 'multi';
  });

  it('writes the calling org’s copy into that org’s own default knowledge base', async () => {
    const chunks = [makeSeedChunk({ id: 'c1', content: 'Alpha' })];
    const tx = armFirstCopy(db);

    const result = await inOrgB(() => materialisePatternsKnowledge(chunks));

    expect(result).toEqual({ outcome: 'created', documentId: 'doc-b' });
    // Not the install org's `kb_default`: the org's own, resolved in its scope.
    expect(getOrCreateDefaultKnowledgeBase).toHaveBeenCalledWith(db);
    expect(tx.aiKnowledgeDocument.create).toHaveBeenCalledWith({
      data: {
        slug: slugFor(chunks),
        name: PATTERNS_DOCUMENT_NAME,
        fileName: 'agentic-design-patterns.md',
        fileHash: createHash('sha256').update('Alpha').digest('hex'),
        scope: 'system',
        status: 'ready',
        uploadedBy: 'service-account',
        chunkCount: 1,
        knowledgeBaseId: 'kb-org-b',
      },
    });
    expect(tx.aiKnowledgeDocumentTag.create).toHaveBeenCalledWith({
      data: { documentId: 'doc-b', tagId: 'tag-patterns' },
    });
    expect(embedBatch).not.toHaveBeenCalled();
  });

  it('looks for the org’s copy by its slug, and for any earlier one by the scope only the platform writes', async () => {
    const chunks = [makeSeedChunk()];
    armFirstCopy(db);

    await inOrgB(() => materialisePatternsKnowledge(chunks));

    // Not by name: an admin can rename a copy, and an earlier copy missed
    // here would meet this one's fixed chunk keys on every run.
    expect(db.aiKnowledgeDocument.findMany).toHaveBeenCalledWith({
      where: { orgId: ORG_B, OR: [{ slug: slugFor(chunks) }, { scope: 'system' }] },
      select: { id: true, slug: true },
      orderBy: { createdAt: 'asc' },
    });
  });

  it('is idempotent by slug: an org holding this version is left alone', async () => {
    const chunks = [makeSeedChunk()];
    db.aiKnowledgeDocument.findMany.mockResolvedValue([
      { id: 'doc-held', slug: slugFor(chunks), status: 'ready' },
    ]);

    const result = await inOrgB(() => materialisePatternsKnowledge(chunks));

    expect(result).toEqual({ outcome: 'present', documentId: 'doc-held' });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.knowledgeTag.upsert).not.toHaveBeenCalled();
    expect(getOrCreateDefaultKnowledgeBase).not.toHaveBeenCalled();
  });

  it('leaves an earlier version in place and says so, rather than colliding with its keys', async () => {
    const chunks = [makeSeedChunk()];
    db.aiKnowledgeDocument.findMany.mockResolvedValue([
      { id: 'doc-old', slug: 'agentic-design-patterns-00000000', status: 'ready' },
    ]);

    const result = await inOrgB(() => materialisePatternsKnowledge(chunks));

    expect(result).toEqual({ outcome: 'outdated', documentId: 'doc-old' });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.aiKnowledgeDocument.deleteMany).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/earlier copy/),
      expect.objectContaining({
        orgId: ORG_B,
        heldSlug: 'agentic-design-patterns-00000000',
        currentSlug: slugFor(chunks),
      })
    );
  });

  it('leaves a copy whose re-chunk failed in place — it still holds its embedded chunks', async () => {
    const chunks = [makeSeedChunk()];
    armFirstCopy(db);
    db.aiKnowledgeDocument.findMany.mockResolvedValue([
      { id: 'doc-failed', slug: slugFor(chunks), status: 'failed' },
    ]);

    const result = await inOrgB(() => materialisePatternsKnowledge(chunks));

    expect(result).toEqual({ outcome: 'present', documentId: 'doc-failed' });
    expect(db.aiKnowledgeDocument.deleteMany).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('reports a copy another run wrote first as present, not as an error', async () => {
    armFirstCopy(db);
    db.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      })
    );
    db.aiKnowledgeDocument.findFirst.mockResolvedValue({ id: 'doc-winner' });
    const chunks = [makeSeedChunk()];

    const result = await inOrgB(() => materialisePatternsKnowledge(chunks));

    expect(result).toEqual({ outcome: 'present', documentId: 'doc-winner' });
    expect(db.aiKnowledgeDocument.findFirst).toHaveBeenCalledWith({
      where: { orgId: ORG_B, slug: slugFor(chunks) },
      select: { id: true },
    });
  });

  it('throws a unique violation that left no copy — another document holds the keys', async () => {
    armFirstCopy(db);
    const violation = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
    });
    db.$transaction.mockRejectedValue(violation);
    db.aiKnowledgeDocument.findFirst.mockResolvedValue(null);

    await expect(inOrgB(() => materialisePatternsKnowledge([makeSeedChunk()]))).rejects.toBe(
      violation
    );
  });

  it('throws any other failure without looking for a winner', async () => {
    armFirstCopy(db);
    db.$transaction.mockRejectedValue(new Error('connection reset'));

    await expect(inOrgB(() => materialisePatternsKnowledge([makeSeedChunk()]))).rejects.toThrow(
      'connection reset'
    );
    expect(db.aiKnowledgeDocument.findFirst).not.toHaveBeenCalled();
  });

  it('writes the document, its chunks and its tag link in one transaction', async () => {
    const chunks = [makeSeedChunk({ id: 'c1' }), makeSeedChunk({ id: 'c2' })];
    const tx = armFirstCopy(db);

    await inOrgB(() => materialisePatternsKnowledge(chunks));

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 30_000 });
    // One statement for every chunk, not one per chunk.
    expect(tx.aiKnowledgeChunk.createMany).toHaveBeenCalledTimes(1);
    expect(tx.aiKnowledgeChunk.createMany.mock.calls[0][0].data).toHaveLength(2);
    // Nothing written on the outer client, where a failure would strand it.
    expect(db.aiKnowledgeDocument.create).not.toHaveBeenCalled();
    expect(db.aiKnowledgeChunk.createMany).not.toHaveBeenCalled();
    expect(db.aiKnowledgeDocumentTag.create).not.toHaveBeenCalled();
  });

  it('reads and writes through the client it is given', async () => {
    const own = makeClient();
    const tx = armFirstCopy(own);

    await inOrgB(() =>
      materialisePatternsKnowledge([makeSeedChunk()], { db: own as unknown as never })
    );

    expect(own.aiKnowledgeDocument.findMany).toHaveBeenCalled();
    expect(getOrCreateDefaultKnowledgeBase).toHaveBeenCalledWith(own);
    expect(tx.aiKnowledgeDocument.create).toHaveBeenCalled();
    expect(db.aiKnowledgeDocument.findMany).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('throws outside any org scope rather than writing a copy with no org', async () => {
    armFirstCopy(db);

    await expect(materialisePatternsKnowledge([makeSeedChunk()])).rejects.toThrow();

    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('falls back to any user when there is no service account', async () => {
    const tx = armFirstCopy(db);
    db.user.findFirst.mockReset();
    db.user.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'regular-user' });

    await inOrgB(() => materialisePatternsKnowledge([makeSeedChunk()]));

    expect(tx.aiKnowledgeDocument.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ uploadedBy: 'regular-user' }),
    });
  });

  it('throws with a descriptive message when no users exist at all', async () => {
    armFirstCopy(db);
    db.user.findFirst.mockReset();
    db.user.findFirst.mockResolvedValue(null);

    await expect(inOrgB(() => materialisePatternsKnowledge([makeSeedChunk()]))).rejects.toThrow(
      /No users/
    );

    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('writes each chunk under its fixed key with no embedding, leaving the org to the chokepoint', async () => {
    const chunk = makeSeedChunk();
    const tx = armFirstCopy(db);

    await inOrgB(() => materialisePatternsKnowledge([chunk]));

    expect(tx.aiKnowledgeChunk.createMany).toHaveBeenCalledWith({
      data: [
        {
          chunkKey: chunk.id,
          documentId: 'doc-b',
          content: chunk.content,
          chunkType: chunk.metadata.type,
          patternNumber: chunk.metadata.pattern_number,
          patternName: chunk.metadata.pattern_name,
          section: chunk.metadata.section_title,
          keywords: chunk.metadata.keywords,
          estimatedTokens: chunk.estimated_tokens,
          metadata: {
            complexity: 'medium',
            relatedPatterns: ['pattern-2'],
            patternId: 'tp-001',
            source: 'handbook',
          },
        },
      ],
    });
  });

  it('passes null for optional metadata fields when they are absent', async () => {
    const tx = armFirstCopy(db);
    const minimal: SeedChunk = {
      id: 'minimal-chunk',
      chunk_id: 1,
      content: 'Minimal content',
      metadata: { type: 'overview' },
      estimated_tokens: 50,
    };

    await inOrgB(() => materialisePatternsKnowledge([minimal]));

    expect(tx.aiKnowledgeChunk.createMany.mock.calls[0][0].data[0]).toMatchObject({
      patternNumber: null,
      patternName: null,
      section: null,
      keywords: null,
    });
  });
});

// --- The committed chunk file ---

describe('loadPatternsChunks', () => {
  it('parses the bundled chunk file, and PATTERNS_DOCUMENT_SLUG is the slug it produces', async () => {
    const chunks = await loadPatternsChunks();

    expect(chunks.length).toBeGreaterThan(100);
    // Editing chunks.json fails this until the constant follows — and the
    // constant is what makes the maintenance job reconcile every org for it.
    expect(slugFor(chunks)).toBe(PATTERNS_DOCUMENT_SLUG);
  });
});

describe('parseSeedChunks', () => {
  it('names the source and the path of the first bad field', () => {
    const bad = [{ id: 'bad', chunk_id: 1, metadata: { type: 'overview' }, estimated_tokens: 5 }];

    expect(() => parseSeedChunks(bad, '/data/chunks.json')).toThrow(
      /Invalid chunks\.json at \/data\/chunks\.json: .* \(at 0\.content\)/
    );
  });
});

// --- seedChunks ---

const CHUNKS_PATH = '/data/chunks.json';

describe('seedChunks', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockEnv.TENANCY_MODE = 'multi';
  });

  it('seeds the file into the caller’s org and records when', async () => {
    const chunks = [makeSeedChunk({ id: 'c1', content: 'Content A' })];
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(chunks));
    const tx = armFirstCopy(db);

    await inOrgB(() => seedChunks(CHUNKS_PATH));

    expect(readFile).toHaveBeenCalledWith(CHUNKS_PATH, 'utf-8');
    expect(tx.aiKnowledgeDocument.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ slug: slugFor(chunks), knowledgeBaseId: 'kb-org-b' }),
    });
    expect(db.aiOrchestrationSettings.upsert).toHaveBeenCalledWith({
      where: { slug: 'global' },
      create: { slug: 'global', defaultModels: {}, lastSeededAt: expect.any(Date) },
      update: { lastSeededAt: expect.any(Date) },
    });
  });

  it('records nothing when the org already holds the copy', async () => {
    const chunks = [makeSeedChunk()];
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(chunks));
    db.aiKnowledgeDocument.findMany.mockResolvedValue([
      { id: 'doc-held', slug: slugFor(chunks), status: 'ready' },
    ]);

    await inOrgB(() => seedChunks(CHUNKS_PATH));

    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.aiOrchestrationSettings.upsert).not.toHaveBeenCalled();
  });

  it('propagates file read errors', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT: no such file'));

    await expect(inOrgB(() => seedChunks('/bad/path/chunks.json'))).rejects.toThrow(
      'ENOENT: no such file'
    );
  });

  it('propagates JSON parse errors from malformed file content', async () => {
    vi.mocked(readFile).mockResolvedValue('{ this is not valid json');

    await expect(inOrgB(() => seedChunks(CHUNKS_PATH))).rejects.toThrow(SyntaxError);
  });

  it('throws a descriptive error when chunks.json has a valid-JSON but invalid shape', async () => {
    const badChunks = [
      { id: 'bad-chunk', chunk_id: 1, metadata: { type: 'overview' }, estimated_tokens: 50 },
    ];
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(badChunks));

    await expect(inOrgB(() => seedChunks(CHUNKS_PATH))).rejects.toThrow(
      `Invalid chunks.json at ${CHUNKS_PATH}`
    );
    expect(db.aiKnowledgeDocument.findMany).not.toHaveBeenCalled();
  });
});

// --- Phase 2: embedChunks ---

describe('embedChunks', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockEnv.TENANCY_MODE = 'multi';
  });

  it('returns immediately when all chunks are already embedded', async () => {
    db.aiKnowledgeChunk.count.mockResolvedValue(10);
    db.$queryRawUnsafe.mockResolvedValue([]);

    const result = await inOrgB(() => embedChunks());

    expect(result).toEqual({ processed: 0, total: 10, alreadyEmbedded: 10 });
    expect(embedBatch).not.toHaveBeenCalled();
  });

  it('embeds only chunks with NULL embedding and updates them', async () => {
    const pending = [
      { id: 'c1', content: 'Chunk 1' },
      { id: 'c2', content: 'Chunk 2' },
    ];

    db.aiKnowledgeChunk.count.mockResolvedValue(5);
    db.$queryRawUnsafe.mockResolvedValue(pending);
    vi.mocked(embedBatch).mockResolvedValue(
      mockEmbedResult([
        [0.1, 0.2],
        [0.3, 0.4],
      ])
    );
    db.$executeRawUnsafe.mockResolvedValue(1);

    const result = await inOrgB(() => embedChunks());

    expect(result).toEqual({ processed: 2, total: 5, alreadyEmbedded: 3 });
    expect(String(db.$queryRawUnsafe.mock.calls[0][0])).toContain('WHERE embedding IS NULL');
    expect(embedBatch).toHaveBeenCalledWith(
      ['Chunk 1', 'Chunk 2'],
      undefined,
      undefined,
      expect.objectContaining({
        metadata: expect.objectContaining({ kind: 'knowledge_seed', chunkCount: 2 }),
      })
    );
    expect(db.$executeRawUnsafe).toHaveBeenCalledTimes(2);

    // Verify UPDATE calls
    const call1 = db.$executeRawUnsafe.mock.calls[0];
    expect(call1[0]).toContain('UPDATE');
    expect(call1[1]).toBe('[0.1,0.2]');
    expect(call1[2]).toBe('c1');

    const call2 = db.$executeRawUnsafe.mock.calls[1];
    expect(call2[1]).toBe('[0.3,0.4]');
    expect(call2[2]).toBe('c2');
  });

  it('propagates embedding errors', async () => {
    db.aiKnowledgeChunk.count.mockResolvedValue(3);
    db.$queryRawUnsafe.mockResolvedValue([{ id: 'c1', content: 'text' }]);
    vi.mocked(embedBatch).mockRejectedValue(new Error('Provider unavailable'));

    await expect(inOrgB(() => embedChunks())).rejects.toThrow('Provider unavailable');
  });
});
