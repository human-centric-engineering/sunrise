/**
 * Document Manager Unit Tests
 *
 * Tests for all document lifecycle operations:
 * - uploadDocument: create → chunk → embed → store → update status
 * - deleteDocument: cascade-delete via Prisma relation
 * - rechunkDocument: load existing chunks, reconstruct content, re-process
 * - listDocuments: ordered list of all knowledge base documents
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';

// --- Mocks (must be declared before any imports that touch the mocked modules) ---

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiKnowledgeDocument: {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      findFirst: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findMany: vi.fn(),
    },
    aiKnowledgeChunk: { deleteMany: vi.fn() },
    $executeRawUnsafe: vi.fn(),
    $queryRaw: vi.fn(),
  },
}));

vi.mock('@/lib/orchestration/knowledge/chunker', () => ({
  chunkMarkdownDocument: vi.fn(),
  parseMetadataComments: vi.fn(() => ({})),
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

import { prisma } from '@/lib/db/client';
import {
  chunkMarkdownDocument,
  parseMetadataComments,
} from '@/lib/orchestration/knowledge/chunker';
import { embedBatch } from '@/lib/orchestration/knowledge/embedder';
import {
  uploadDocument,
  deleteDocument,
  rechunkDocument,
  listDocuments,
  listMetaTags,
} from '@/lib/orchestration/knowledge/document-manager';

// --- Helpers ---

interface ChunkShape {
  id: string;
  chunkType: string;
  patternNumber: number;
  patternName: string;
  category: string;
  section: string;
  keywords: string;
  estimatedTokens: number;
  content: string;
}

function makeChunk(overrides: Partial<ChunkShape> = {}): ChunkShape {
  return {
    id: 'chunk-key-001',
    chunkType: 'pattern',
    patternNumber: 1,
    patternName: 'Test Pattern',
    category: 'orchestration',
    section: 'Overview',
    keywords: 'ai,agent',
    estimatedTokens: 120,
    content: 'Some chunk content',
    ...overrides,
  };
}

function makeDocument(overrides = {}) {
  return {
    id: 'doc-id-001',
    name: 'Test Document',
    fileName: 'test-document.md',
    fileHash: 'abc123',
    status: 'ready',
    chunkCount: 1,
    uploadedBy: 'user-id-001',
    errorMessage: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    ...overrides,
  };
}

// --- Tests ---

describe('uploadDocument', () => {
  beforeEach(() => vi.resetAllMocks());

  it('creates document record with status processing, correct fileHash, and name without extension', async () => {
    const content = '# Hello World\n\nSome markdown content.';
    const fileName = 'hello-world.md';
    const userId = 'user-001';

    const expectedHash = createHash('sha256').update(content).digest('hex');
    const createdDoc = makeDocument({
      id: 'new-doc',
      name: 'hello-world',
      fileHash: expectedHash,
      status: 'processing',
    });
    const updatedDoc = makeDocument({
      id: 'new-doc',
      name: 'hello-world',
      status: 'ready',
      chunkCount: 1,
    });
    const chunk = makeChunk();
    const embedding = [0.1, 0.2, 0.3];

    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(createdDoc as never);
    vi.mocked(chunkMarkdownDocument).mockReturnValue([chunk]);
    vi.mocked(embedBatch).mockResolvedValue([embedding]);
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(updatedDoc as never);

    await uploadDocument(content, fileName, userId);

    expect(prisma.aiKnowledgeDocument.create).toHaveBeenCalledWith({
      data: {
        name: 'hello-world',
        fileName,
        fileHash: expectedHash,
        status: 'processing',
        uploadedBy: userId,
        scope: 'app',
        category: null,
      },
    });
  });

  it('calls chunkMarkdownDocument with the raw content', async () => {
    const content = '# Doc\n\nContent here.';
    const createdDoc = makeDocument({ status: 'processing' });
    const updatedDoc = makeDocument({ status: 'ready', chunkCount: 1 });

    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(createdDoc as never);
    vi.mocked(chunkMarkdownDocument).mockReturnValue([makeChunk()]);
    vi.mocked(embedBatch).mockResolvedValue([[0.1, 0.2]]);
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(updatedDoc as never);

    await uploadDocument(content, 'doc.md', 'user-001');

    expect(chunkMarkdownDocument).toHaveBeenCalledWith(content, 'doc');
  });

  it('calls embedBatch with the text content of every chunk', async () => {
    const content = '# Doc\n\nContent here.';
    const chunks = [
      makeChunk({ id: 'c1', content: 'First chunk' }),
      makeChunk({ id: 'c2', content: 'Second chunk' }),
    ];
    const createdDoc = makeDocument({ status: 'processing' });
    const updatedDoc = makeDocument({ status: 'ready', chunkCount: 2 });

    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(createdDoc as never);
    vi.mocked(chunkMarkdownDocument).mockReturnValue(chunks);
    vi.mocked(embedBatch).mockResolvedValue([[0.1], [0.2]]);
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(updatedDoc as never);

    await uploadDocument(content, 'doc.md', 'user-001');

    expect(embedBatch).toHaveBeenCalledWith(['First chunk', 'Second chunk']);
  });

  it('calls $executeRawUnsafe once per chunk with ::vector cast SQL', async () => {
    const chunks = [makeChunk({ id: 'c1' }), makeChunk({ id: 'c2' })];
    const createdDoc = makeDocument({ status: 'processing' });
    const updatedDoc = makeDocument({ status: 'ready', chunkCount: 2 });

    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(createdDoc as never);
    vi.mocked(chunkMarkdownDocument).mockReturnValue(chunks);
    vi.mocked(embedBatch).mockResolvedValue([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(updatedDoc as never);

    await uploadDocument('# Doc', 'doc.md', 'user-001');

    expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(2);
    const [sql] = vi.mocked(prisma.$executeRawUnsafe).mock.calls[0] as [string, ...unknown[]];
    expect(sql).toContain('::vector');
    expect(sql).toContain('$1');
  });

  it('updates document to status ready with correct chunkCount after successful upload', async () => {
    const chunks = [makeChunk({ id: 'c1' }), makeChunk({ id: 'c2' })];
    const createdDoc = makeDocument({ id: 'doc-123', status: 'processing' });
    const updatedDoc = makeDocument({ id: 'doc-123', status: 'ready', chunkCount: 2 });

    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(createdDoc as never);
    vi.mocked(chunkMarkdownDocument).mockReturnValue(chunks);
    vi.mocked(embedBatch).mockResolvedValue([[0.1], [0.2]]);
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(updatedDoc as never);

    await uploadDocument('# Doc', 'doc.md', 'user-001');

    expect(prisma.aiKnowledgeDocument.update).toHaveBeenCalledWith({
      where: { id: 'doc-123' },
      data: { status: 'ready', chunkCount: 2 },
    });
  });

  it('skips embed and raw inserts when chunker returns empty array, updates to ready with chunkCount 0', async () => {
    const createdDoc = makeDocument({ id: 'doc-empty', status: 'processing' });
    const updatedDoc = makeDocument({ id: 'doc-empty', status: 'ready', chunkCount: 0 });

    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(createdDoc as never);
    vi.mocked(chunkMarkdownDocument).mockReturnValue([]);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(updatedDoc as never);

    await uploadDocument('', 'empty.md', 'user-001');

    expect(embedBatch).not.toHaveBeenCalled();
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(prisma.aiKnowledgeDocument.update).toHaveBeenCalledWith({
      where: { id: 'doc-empty' },
      data: { status: 'ready', chunkCount: 0 },
    });
  });

  it('marks document failed and re-throws when embedBatch rejects', async () => {
    const createdDoc = makeDocument({ id: 'doc-fail', status: 'processing' });
    const embedError = new Error('Embedding service unavailable');

    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(createdDoc as never);
    vi.mocked(chunkMarkdownDocument).mockReturnValue([makeChunk()]);
    vi.mocked(embedBatch).mockRejectedValue(embedError);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(makeDocument() as never);

    await expect(uploadDocument('# Doc', 'doc.md', 'user-001')).rejects.toThrow(
      'Embedding service unavailable'
    );

    expect(prisma.aiKnowledgeDocument.update).toHaveBeenCalledWith({
      where: { id: 'doc-fail' },
      data: { status: 'failed', errorMessage: 'Embedding service unavailable' },
    });
  });

  it('marks document failed and re-throws when a raw insert rejects mid-loop', async () => {
    const chunks = [makeChunk({ id: 'c1' }), makeChunk({ id: 'c2' })];
    const createdDoc = makeDocument({ id: 'doc-insert-fail', status: 'processing' });
    const insertError = new Error('DB constraint violation');

    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(createdDoc as never);
    vi.mocked(chunkMarkdownDocument).mockReturnValue(chunks);
    vi.mocked(embedBatch).mockResolvedValue([[0.1], [0.2]]);
    // First insert succeeds, second fails
    vi.mocked(prisma.$executeRawUnsafe)
      .mockResolvedValueOnce(1 as never)
      .mockRejectedValueOnce(insertError);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(makeDocument() as never);

    await expect(uploadDocument('# Doc', 'doc.md', 'user-001')).rejects.toThrow(
      'DB constraint violation'
    );

    expect(prisma.aiKnowledgeDocument.update).toHaveBeenCalledWith({
      where: { id: 'doc-insert-fail' },
      data: { status: 'failed', errorMessage: 'DB constraint violation' },
    });
  });

  it('uses "Unknown error" as errorMessage when a non-Error value is thrown during upload', async () => {
    const createdDoc = makeDocument({ id: 'doc-non-error', status: 'processing' });

    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(createdDoc as never);
    vi.mocked(chunkMarkdownDocument).mockReturnValue([makeChunk()]);
    vi.mocked(embedBatch).mockRejectedValue('string rejection'); // non-Error throw
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(makeDocument() as never);

    await expect(uploadDocument('# Doc', 'doc.md', 'user-001')).rejects.toBe('string rejection');

    expect(prisma.aiKnowledgeDocument.update).toHaveBeenCalledWith({
      where: { id: 'doc-non-error' },
      data: { status: 'failed', errorMessage: 'Unknown error' },
    });
  });

  it('deduplicates: returns an existing "ready" document when fileHash matches, without creating a new one', async () => {
    const content = '# Same Content';
    const expectedHash = createHash('sha256').update(content).digest('hex');
    const existing = makeDocument({
      id: 'doc-existing',
      fileHash: expectedHash,
      status: 'ready',
      chunkCount: 3,
    });

    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(existing as never);

    const result = await uploadDocument(content, 'same.md', 'user-001');

    expect(prisma.aiKnowledgeDocument.findFirst).toHaveBeenCalledWith({
      where: { fileHash: expectedHash, status: 'ready' },
    });
    expect(result).toEqual(existing);
    // No new record created, no chunking or embedding triggered
    expect(prisma.aiKnowledgeDocument.create).not.toHaveBeenCalled();
    expect(chunkMarkdownDocument).not.toHaveBeenCalled();
    expect(embedBatch).not.toHaveBeenCalled();
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('does NOT dedup against failed uploads: proceeds to create a new record when previous upload had status failed', async () => {
    // findFirst filters on status:'ready', so a previous failure returns null and upload proceeds.
    const content = '# Retry Me';
    const createdDoc = makeDocument({ id: 'doc-retry', status: 'processing' });
    const updatedDoc = makeDocument({ id: 'doc-retry', status: 'ready', chunkCount: 1 });

    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(createdDoc as never);
    vi.mocked(chunkMarkdownDocument).mockReturnValue([makeChunk()]);
    vi.mocked(embedBatch).mockResolvedValue([[0.1, 0.2]]);
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(updatedDoc as never);

    await uploadDocument(content, 'retry.md', 'user-001');

    expect(prisma.aiKnowledgeDocument.create).toHaveBeenCalledTimes(1);
  });
});

describe('deleteDocument', () => {
  beforeEach(() => vi.resetAllMocks());

  it('calls aiKnowledgeDocument.delete with the given documentId', async () => {
    vi.mocked(prisma.aiKnowledgeDocument.delete).mockResolvedValue(makeDocument() as never);

    await deleteDocument('doc-to-delete');

    expect(prisma.aiKnowledgeDocument.delete).toHaveBeenCalledWith({
      where: { id: 'doc-to-delete' },
    });
  });
});

describe('rechunkDocument', () => {
  beforeEach(() => vi.resetAllMocks());

  it('loads existing document with chunks, reconstructs content, and re-processes successfully', async () => {
    const existingDoc = {
      ...makeDocument({ id: 'doc-rechunk', name: 'My Doc', status: 'ready' }),
      chunks: [
        { chunkKey: 'a', content: 'First section' },
        { chunkKey: 'b', content: 'Second section' },
      ],
    };
    const updatedDoc = makeDocument({ id: 'doc-rechunk', status: 'ready', chunkCount: 1 });

    vi.mocked(prisma.aiKnowledgeDocument.findUniqueOrThrow).mockResolvedValue(existingDoc as never);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(updatedDoc as never);
    vi.mocked(prisma.aiKnowledgeChunk.deleteMany).mockResolvedValue({ count: 2 } as never);
    vi.mocked(chunkMarkdownDocument).mockReturnValue([makeChunk()]);
    vi.mocked(embedBatch).mockResolvedValue([[0.1, 0.2]]);
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);

    await rechunkDocument('doc-rechunk');

    // Content reconstructed with \n\n---\n\n separator
    expect(chunkMarkdownDocument).toHaveBeenCalledWith(
      'First section\n\n---\n\nSecond section',
      'My Doc'
    );
    // Old chunks deleted
    expect(prisma.aiKnowledgeChunk.deleteMany).toHaveBeenCalledWith({
      where: { documentId: 'doc-rechunk' },
    });
    // Raw inserts called for new chunks
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    // Final update to ready
    expect(prisma.aiKnowledgeDocument.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'ready', chunkCount: 1 },
      })
    );
  });

  it('sets status to processing before deleting old chunks', async () => {
    const existingDoc = {
      ...makeDocument({ id: 'doc-rechunk', name: 'Doc', status: 'ready' }),
      chunks: [{ chunkKey: 'a', content: 'Content' }],
    };

    vi.mocked(prisma.aiKnowledgeDocument.findUniqueOrThrow).mockResolvedValue(existingDoc as never);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(makeDocument() as never);
    vi.mocked(prisma.aiKnowledgeChunk.deleteMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(chunkMarkdownDocument).mockReturnValue([makeChunk()]);
    vi.mocked(embedBatch).mockResolvedValue([[0.1]]);
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);

    await rechunkDocument('doc-rechunk');

    const updateCalls = vi.mocked(prisma.aiKnowledgeDocument.update).mock.calls;
    // First update call should set status to processing
    expect(updateCalls[0][0]).toEqual({
      where: { id: 'doc-rechunk' },
      data: { status: 'processing' },
    });
  });

  it('returns early without touching the chunker when the document has zero existing chunks', async () => {
    const existingDoc = {
      ...makeDocument({ id: 'doc-no-chunks', name: 'Doc', status: 'ready', chunkCount: 0 }),
      chunks: [],
    };

    vi.mocked(prisma.aiKnowledgeDocument.findUniqueOrThrow).mockResolvedValue(existingDoc as never);

    const result = await rechunkDocument('doc-no-chunks');

    expect(chunkMarkdownDocument).not.toHaveBeenCalled();
    expect(embedBatch).not.toHaveBeenCalled();
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(prisma.aiKnowledgeChunk.deleteMany).not.toHaveBeenCalled();
    expect(prisma.aiKnowledgeDocument.update).not.toHaveBeenCalled();
    // Result is the document record without the `chunks` relation attached
    expect(result).not.toHaveProperty('chunks');
    expect(result.id).toBe('doc-no-chunks');
  });

  it('returns document with chunkCount 0 and skips embed when re-chunker returns empty array', async () => {
    const existingDoc = {
      ...makeDocument({ id: 'doc-empty-rechunk', name: 'Empty', status: 'ready' }),
      chunks: [{ chunkKey: 'a', content: 'Old content' }],
    };
    const updatedDoc = makeDocument({ id: 'doc-empty-rechunk', status: 'ready', chunkCount: 0 });

    vi.mocked(prisma.aiKnowledgeDocument.findUniqueOrThrow).mockResolvedValue(existingDoc as never);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(updatedDoc as never);
    vi.mocked(prisma.aiKnowledgeChunk.deleteMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(chunkMarkdownDocument).mockReturnValue([]);

    const result = await rechunkDocument('doc-empty-rechunk');

    expect(embedBatch).not.toHaveBeenCalled();
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(result.chunkCount).toBe(0);
    expect(result.status).toBe('ready');
  });

  it('marks document failed and re-throws when embedBatch rejects during rechunk', async () => {
    const existingDoc = {
      ...makeDocument({ id: 'doc-rechunk-fail', name: 'Doc', status: 'ready' }),
      chunks: [{ chunkKey: 'a', content: 'Content' }],
    };
    const embedError = new Error('Embed service down');

    vi.mocked(prisma.aiKnowledgeDocument.findUniqueOrThrow).mockResolvedValue(existingDoc as never);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(makeDocument() as never);
    vi.mocked(prisma.aiKnowledgeChunk.deleteMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(chunkMarkdownDocument).mockReturnValue([makeChunk()]);
    vi.mocked(embedBatch).mockRejectedValue(embedError);

    await expect(rechunkDocument('doc-rechunk-fail')).rejects.toThrow('Embed service down');

    expect(prisma.aiKnowledgeDocument.update).toHaveBeenCalledWith({
      where: { id: 'doc-rechunk-fail' },
      data: { status: 'failed', errorMessage: 'Embed service down' },
    });
  });

  it('uses "Unknown error" as errorMessage when a non-Error value is thrown during rechunk', async () => {
    const existingDoc = {
      ...makeDocument({ id: 'doc-rechunk-non-error', name: 'Doc', status: 'ready' }),
      chunks: [{ chunkKey: 'a', content: 'Content' }],
    };

    vi.mocked(prisma.aiKnowledgeDocument.findUniqueOrThrow).mockResolvedValue(existingDoc as never);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(makeDocument() as never);
    vi.mocked(prisma.aiKnowledgeChunk.deleteMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(chunkMarkdownDocument).mockReturnValue([makeChunk()]);
    vi.mocked(embedBatch).mockRejectedValue(42); // non-Error throw

    await expect(rechunkDocument('doc-rechunk-non-error')).rejects.toBe(42);

    expect(prisma.aiKnowledgeDocument.update).toHaveBeenCalledWith({
      where: { id: 'doc-rechunk-non-error' },
      data: { status: 'failed', errorMessage: 'Unknown error' },
    });
  });
});

describe('listDocuments', () => {
  beforeEach(() => vi.resetAllMocks());

  it('calls findMany with orderBy createdAt desc and returns the result', async () => {
    const docs = [
      makeDocument({ id: 'doc-2', createdAt: new Date('2024-02-01') }),
      makeDocument({ id: 'doc-1', createdAt: new Date('2024-01-01') }),
    ];
    vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue(docs as never);

    const result = await listDocuments();

    expect(prisma.aiKnowledgeDocument.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: 'desc' },
    });
    expect(result).toEqual(docs);
  });

  it('returns an empty array when there are no documents', async () => {
    vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([] as never);

    const result = await listDocuments();

    expect(result).toEqual([]);
  });
});

describe('listMetaTags', () => {
  beforeEach(() => vi.resetAllMocks());

  it('returns categories and keywords grouped by scope', async () => {
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([
        { scope: 'app', value: 'sales', chunk_count: BigInt(10), doc_count: BigInt(2) },
        { scope: 'system', value: 'patterns', chunk_count: BigInt(5), doc_count: BigInt(1) },
      ] as never)
      .mockResolvedValueOnce([
        { scope: 'app', value: 'pricing', chunk_count: BigInt(3), doc_count: BigInt(1) },
        { scope: 'system', value: 'reasoning', chunk_count: BigInt(7), doc_count: BigInt(1) },
      ] as never);

    const result = await listMetaTags();

    expect(result.app.categories).toEqual([{ value: 'sales', chunkCount: 10, documentCount: 2 }]);
    expect(result.system.categories).toEqual([
      { value: 'patterns', chunkCount: 5, documentCount: 1 },
    ]);
    expect(result.app.keywords).toEqual([{ value: 'pricing', chunkCount: 3, documentCount: 1 }]);
    expect(result.system.keywords).toEqual([
      { value: 'reasoning', chunkCount: 7, documentCount: 1 },
    ]);
  });

  it('returns empty arrays for both scopes when no meta-tags exist', async () => {
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never);

    const result = await listMetaTags();

    expect(result.app).toEqual({ categories: [], keywords: [] });
    expect(result.system).toEqual({ categories: [], keywords: [] });
  });

  it('trims whitespace from tag values', async () => {
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([
        { scope: 'app', value: '  sales  ', chunk_count: BigInt(1), doc_count: BigInt(1) },
      ] as never)
      .mockResolvedValueOnce([] as never);

    const result = await listMetaTags();

    expect(result.app.categories[0].value).toBe('sales');
  });
});

describe('uploadDocument with category', () => {
  beforeEach(() => vi.resetAllMocks());

  it('stores explicit category on the document record', async () => {
    const content = '# Hello';
    const createdDoc = makeDocument({ status: 'processing' });
    const updatedDoc = makeDocument({ status: 'ready', chunkCount: 0 });

    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(createdDoc as never);
    vi.mocked(chunkMarkdownDocument).mockReturnValue([]);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(updatedDoc as never);

    await uploadDocument(content, 'test.md', 'user-1', 'sales');

    expect(prisma.aiKnowledgeDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ category: 'sales' }),
      })
    );
  });

  it('extracts category from document metadata when not provided explicitly', async () => {
    const content = '<!-- metadata: category=engineering -->\n# Hello';
    const createdDoc = makeDocument({ status: 'processing' });
    const updatedDoc = makeDocument({ status: 'ready', chunkCount: 0 });

    vi.mocked(parseMetadataComments).mockReturnValue({ category: 'engineering' });
    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(createdDoc as never);
    vi.mocked(chunkMarkdownDocument).mockReturnValue([]);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(updatedDoc as never);

    await uploadDocument(content, 'test.md', 'user-1');

    expect(prisma.aiKnowledgeDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ category: 'engineering' }),
      })
    );
  });

  it('sets category to null when no explicit category and no document metadata', async () => {
    const content = '# No metadata here';
    const createdDoc = makeDocument({ status: 'processing' });
    const updatedDoc = makeDocument({ status: 'ready', chunkCount: 0 });

    vi.mocked(parseMetadataComments).mockReturnValue({});
    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(createdDoc as never);
    vi.mocked(chunkMarkdownDocument).mockReturnValue([]);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(updatedDoc as never);

    await uploadDocument(content, 'test.md', 'user-1');

    expect(prisma.aiKnowledgeDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ category: null }),
      })
    );
  });

  it('propagates document-level category to chunks that have no category', async () => {
    const content = '# Hello';
    const createdDoc = makeDocument({ id: 'doc-cat', status: 'processing' });
    const updatedDoc = makeDocument({ id: 'doc-cat', status: 'ready', chunkCount: 1 });
    const chunk = makeChunk({ category: null as unknown as string });

    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(createdDoc as never);
    vi.mocked(chunkMarkdownDocument).mockReturnValue([chunk]);
    vi.mocked(embedBatch).mockResolvedValue([[0.1, 0.2]]);
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(updatedDoc as never);

    await uploadDocument(content, 'test.md', 'user-1', 'sales');

    // The chunk's category should have been set to 'sales'
    const rawInsertCall = vi.mocked(prisma.$executeRawUnsafe).mock.calls[0];
    // category is the 8th parameter (index 8) in the raw SQL
    expect(rawInsertCall[8]).toBe('sales');
  });
});
