/**
 * Document Manager Unit Tests
 *
 * Tests for all document lifecycle operations:
 * - uploadDocument: create → chunk → embed → store → update status
 * - uploadDocumentFromBuffer: multi-format upload via buffer
 * - previewDocument: parse-only preview for PDF/etc.
 * - confirmPreview: chunk + embed from previewed content
 * - deleteDocument: cascade-delete via Prisma relation
 * - rechunkDocument: load existing chunks, reconstruct content, re-process
 * - listDocuments: ordered list of all knowledge base documents
 * - listMetaTags: category/keyword aggregations grouped by scope
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
  chunkCsvDocument: vi.fn(),
  parseMetadataComments: vi.fn(() => ({})),
  // Mirror the real value so the oversize-row guard's threshold matches what
  // the test fixtures construct (see "drops rows over the embedding-API size
  // limit" — it builds a row at 40_000 chars expecting it to be rejected).
  CSV_MAX_ROW_CHARS: 32_000,
}));

vi.mock('@/lib/orchestration/knowledge/embedder', () => ({
  embedBatch: vi.fn(),
}));

// executeTransaction mock — forwards callback to the prisma mock.
// We import prisma after mocks are set up, so use a lazy reference.
// eslint-disable-next-line prefer-const
let _prismaMock: unknown;
vi.mock('@/lib/db/utils', () => ({
  executeTransaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
    return cb(_prismaMock);
  }),
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@/lib/orchestration/knowledge/parsers', () => ({
  parseDocument: vi.fn(),
  requiresPreview: vi.fn(() => false),
}));

// --- Imports after mocks ---

import { prisma } from '@/lib/db/client';
_prismaMock = prisma;
import {
  chunkCsvDocument,
  chunkMarkdownDocument,
  parseMetadataComments,
} from '@/lib/orchestration/knowledge/chunker';
import { embedBatch } from '@/lib/orchestration/knowledge/embedder';
import type { EmbedBatchResult } from '@/lib/orchestration/knowledge/embedder';
import { parseDocument, requiresPreview } from '@/lib/orchestration/knowledge/parsers';
import {
  uploadDocument,
  uploadDocumentFromBuffer,
  previewDocument,
  confirmPreview,
  deleteDocument,
  rechunkDocument,
  listDocuments,
  listMetaTags,
} from '@/lib/orchestration/knowledge/document-manager';

// --- Helpers ---

/** Wrap raw embeddings in the EmbedBatchResult shape expected by the new API */
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
    vi.mocked(embedBatch).mockResolvedValue(mockEmbedResult([embedding]));
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(updatedDoc as never);

    await uploadDocument(content, fileName, userId);

    expect(prisma.aiKnowledgeDocument.create).toHaveBeenCalledWith({
      data: {
        name: 'hello-world',
        fileName,
        fileHash: expectedHash,
        sourceUrl: null,
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
    vi.mocked(embedBatch).mockResolvedValue(mockEmbedResult([[0.1, 0.2]]));
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(updatedDoc as never);

    await uploadDocument(content, 'doc.md', 'user-001');

    expect(chunkMarkdownDocument).toHaveBeenCalledWith(content, 'doc', 'doc-id-001');
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
    vi.mocked(embedBatch).mockResolvedValue(mockEmbedResult([[0.1], [0.2]]));
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
    vi.mocked(embedBatch).mockResolvedValue(
      mockEmbedResult([
        [0.1, 0.2],
        [0.3, 0.4],
      ])
    );
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
    vi.mocked(embedBatch).mockResolvedValue(mockEmbedResult([[0.1], [0.2]]));
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(updatedDoc as never);

    await uploadDocument('# Doc', 'doc.md', 'user-001');

    expect(prisma.aiKnowledgeDocument.update).toHaveBeenCalledWith({
      where: { id: 'doc-123' },
      data: { status: 'ready', chunkCount: 2, metadata: { rawContent: '# Doc' } },
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
    vi.mocked(embedBatch).mockResolvedValue(mockEmbedResult([[0.1], [0.2]]));
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
    vi.mocked(embedBatch).mockResolvedValue(mockEmbedResult([[0.1, 0.2]]));
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

  it('propagates Prisma rejection when the DB delete fails', async () => {
    // Arrange
    const dbError = new Error('Record to delete does not exist');
    vi.mocked(prisma.aiKnowledgeDocument.delete).mockRejectedValue(dbError);

    // Act & Assert: the error propagates — source has no try/catch around delete
    await expect(deleteDocument('doc-ghost')).rejects.toThrow('Record to delete does not exist');
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
    vi.mocked(embedBatch).mockResolvedValue(mockEmbedResult([[0.1, 0.2]]));
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);

    await rechunkDocument('doc-rechunk');

    // Content reconstructed with \n\n---\n\n separator
    expect(chunkMarkdownDocument).toHaveBeenCalledWith(
      'First section\n\n---\n\nSecond section',
      'My Doc',
      'doc-rechunk'
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
    vi.mocked(embedBatch).mockResolvedValue(mockEmbedResult([[0.1]]));
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

  it('dispatches CSV documents through chunkCsvDocument (not the markdown chunker)', async () => {
    // A CSV document stores rawContent as the joined "Header: Value | …" lines
    // emitted by parseCsv. Re-chunking must split those back into one chunk per
    // row, not pass the whole blob to chunkMarkdownDocument.
    const doc = makeDocument({
      id: 'doc-csv-rechunk',
      name: 'spending',
      fileName: 'spending.csv',
      status: 'ready',
      metadata: {
        format: 'csv',
        rawContent: 'name: Acme | amount: 100\nname: Beta | amount: 200\nname: Gamma | amount: 300',
      },
    });
    const oldChunks = [{ content: 'irrelevant — rebuilt from rawContent', chunkType: 'csv_row' }];
    vi.mocked(prisma.aiKnowledgeDocument.findUniqueOrThrow).mockResolvedValue({
      ...doc,
      chunks: oldChunks,
    } as never);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(
      makeDocument({ id: 'doc-csv-rechunk', status: 'ready', chunkCount: 3 }) as never
    );
    vi.mocked(chunkCsvDocument).mockReturnValue([
      makeChunk({ id: 'r1', chunkType: 'csv_row' }),
      makeChunk({ id: 'r2', chunkType: 'csv_row' }),
      makeChunk({ id: 'r3', chunkType: 'csv_row' }),
    ]);
    vi.mocked(embedBatch).mockResolvedValue(mockEmbedResult([[0.1], [0.2], [0.3]]));
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);

    await rechunkDocument('doc-csv-rechunk');

    expect(chunkCsvDocument).toHaveBeenCalledTimes(1);
    expect(chunkMarkdownDocument).not.toHaveBeenCalled();
    // Verify the rebuilt parsed shape: 3 sections, one per non-empty line in rawContent.
    const callArg = vi.mocked(chunkCsvDocument).mock.calls[0][0];
    expect(callArg.sections).toHaveLength(3);
    expect(callArg.sections[0].content).toBe('name: Acme | amount: 100');
    expect(callArg.sections[2].content).toBe('name: Gamma | amount: 300');
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

  it('does not override existing chunk category when document category is set', async () => {
    const content = '# Hello';
    const createdDoc = makeDocument({ id: 'doc-cat2', status: 'processing' });
    const updatedDoc = makeDocument({ id: 'doc-cat2', status: 'ready', chunkCount: 1 });
    // Chunk already has its own category
    const chunk = makeChunk({ category: 'existing-category' });

    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(createdDoc as never);
    vi.mocked(chunkMarkdownDocument).mockReturnValue([chunk]);
    vi.mocked(embedBatch).mockResolvedValue(mockEmbedResult([[0.1]]));
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(updatedDoc as never);

    await uploadDocument(content, 'test.md', 'user-1', 'override-cat');

    // chunk.category was 'existing-category' — it should NOT be overwritten
    const rawInsertCall = vi.mocked(prisma.$executeRawUnsafe).mock.calls[0];
    expect(rawInsertCall[8]).toBe('existing-category');
  });

  it('propagates document-level category to chunks that have no category', async () => {
    const content = '# Hello';
    const createdDoc = makeDocument({ id: 'doc-cat', status: 'processing' });
    const updatedDoc = makeDocument({ id: 'doc-cat', status: 'ready', chunkCount: 1 });
    const chunk = makeChunk({ category: null as unknown as string });

    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(createdDoc as never);
    vi.mocked(chunkMarkdownDocument).mockReturnValue([chunk]);
    vi.mocked(embedBatch).mockResolvedValue(mockEmbedResult([[0.1, 0.2]]));
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(updatedDoc as never);

    await uploadDocument(content, 'test.md', 'user-1', 'sales');

    // The chunk's category should have been set to 'sales'
    const rawInsertCall = vi.mocked(prisma.$executeRawUnsafe).mock.calls[0];
    // category is the 8th parameter (index 8) in the raw SQL
    expect(rawInsertCall[8]).toBe('sales');
  });
});

// ─── uploadDocumentFromBuffer ─────────────────────────────────────────────────

describe('uploadDocumentFromBuffer', () => {
  beforeEach(() => vi.resetAllMocks());

  it('throws when the format requires a preview step (PDF)', async () => {
    vi.mocked(requiresPreview).mockReturnValue(true);
    const buffer = Buffer.from('fake pdf');

    await expect(uploadDocumentFromBuffer(buffer, 'report.pdf', 'user-1')).rejects.toThrow(
      'requires a preview step'
    );
    expect(parseDocument).not.toHaveBeenCalled();
  });

  it('calls parseDocument and pipes through uploadDocument for non-preview formats', async () => {
    vi.mocked(requiresPreview).mockReturnValue(false);
    vi.mocked(parseDocument as ReturnType<typeof vi.fn>).mockResolvedValue({
      fullText: '# Parsed text',
      title: 'My Doc',
      author: undefined,
      sections: [],
      metadata: { format: 'txt' },
      warnings: [],
    });

    // Mock the DB / chunker / embedder chain for uploadDocument
    const createdDoc = makeDocument({ status: 'processing' });
    const updatedDoc = makeDocument({ status: 'ready', chunkCount: 0 });
    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(createdDoc as never);
    vi.mocked(chunkMarkdownDocument).mockReturnValue([]);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(updatedDoc as never);

    const buffer = Buffer.from('# Parsed text', 'utf-8');
    await uploadDocumentFromBuffer(buffer, 'notes.txt', 'user-1');

    expect(parseDocument).toHaveBeenCalledWith(buffer, 'notes.txt');
    // Document was created with the expected shape — the upload pipeline ran
    expect(prisma.aiKnowledgeDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fileName: 'notes.txt',
          status: 'processing',
        }),
      })
    );
  });

  it('logs warnings when parseDocument returns them', async () => {
    vi.mocked(requiresPreview).mockReturnValue(false);
    vi.mocked(parseDocument as ReturnType<typeof vi.fn>).mockResolvedValue({
      fullText: 'some text',
      title: 'Doc',
      author: undefined,
      sections: [],
      metadata: { format: 'txt' },
      warnings: ['Page 3 garbled'],
    });

    const createdDoc = makeDocument({ status: 'processing' });
    const updatedDoc = makeDocument({ status: 'ready', chunkCount: 0 });
    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(createdDoc as never);
    vi.mocked(chunkMarkdownDocument).mockReturnValue([]);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(updatedDoc as never);

    const { logger } = await import('@/lib/logging');
    await uploadDocumentFromBuffer(Buffer.from('text'), 'doc.txt', 'user-1');

    expect(logger.warn).toHaveBeenCalledWith(
      'Document parsed with warnings',
      expect.objectContaining({ warnings: ['Page 3 garbled'] })
    );
  });

  it('passes raw buffer content (not parsed text) for .md files', async () => {
    vi.mocked(requiresPreview).mockReturnValue(false);
    const rawMarkdown = '# Raw Markdown\n\nContent here.';
    vi.mocked(parseDocument as ReturnType<typeof vi.fn>).mockResolvedValue({
      fullText: 'Parsed version (should be ignored for .md)',
      title: 'Doc',
      author: undefined,
      sections: [],
      metadata: { format: 'markdown' },
      warnings: [],
    });

    const createdDoc = makeDocument({ status: 'processing' });
    const updatedDoc = makeDocument({ status: 'ready', chunkCount: 0 });
    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(createdDoc as never);
    vi.mocked(chunkMarkdownDocument).mockReturnValue([]);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(updatedDoc as never);

    const buffer = Buffer.from(rawMarkdown, 'utf-8');
    await uploadDocumentFromBuffer(buffer, 'doc.md', 'user-1');

    // chunkMarkdownDocument should receive the raw markdown, not the parsed text
    expect(chunkMarkdownDocument).toHaveBeenCalledWith(rawMarkdown, 'doc', 'doc-id-001');
  });

  it('propagates parseDocument errors without creating a document record', async () => {
    // Arrange
    vi.mocked(requiresPreview).mockReturnValue(false);
    const parseError = new Error('Unsupported encoding');
    vi.mocked(parseDocument as ReturnType<typeof vi.fn>).mockRejectedValue(parseError);

    // Act & Assert: the error propagates — source has no try/catch around parseDocument
    await expect(
      uploadDocumentFromBuffer(Buffer.from('data'), 'corrupt.docx', 'user-1')
    ).rejects.toThrow('Unsupported encoding');

    // No document record should have been created
    expect(prisma.aiKnowledgeDocument.create).not.toHaveBeenCalled();
  });
});

// ─── uploadDocumentFromBuffer (CSV path) ──────────────────────────────────────

describe('uploadDocumentFromBuffer — CSV row-level chunking', () => {
  beforeEach(() => vi.resetAllMocks());

  function csvParsed(rowCount = 3) {
    return {
      title: 'spending',
      author: undefined,
      sections: Array.from({ length: rowCount }, (_, i) => ({
        title: `Row ${i + 1}`,
        content: `name: Row ${i + 1} | amount: ${(i + 1) * 100}`,
        order: i,
      })),
      fullText: 'serialized',
      metadata: {
        format: 'csv',
        delimiter: ',',
        rowCount: String(rowCount),
        columnCount: '2',
        hasHeader: 'true',
      },
      warnings: ['Detected header row: yes'],
    };
  }

  it('dispatches CSV uploads through chunkCsvDocument (not the markdown chunker)', async () => {
    vi.mocked(requiresPreview).mockReturnValue(false);
    vi.mocked(parseDocument as ReturnType<typeof vi.fn>).mockResolvedValue(csvParsed(3));
    vi.mocked(chunkCsvDocument).mockReturnValue([makeChunk({ chunkType: 'csv_row' })]);
    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(
      makeDocument({ status: 'processing' }) as never
    );
    vi.mocked(embedBatch).mockResolvedValue(mockEmbedResult([[0.1]]));
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(
      makeDocument({ status: 'ready', chunkCount: 1 }) as never
    );

    await uploadDocumentFromBuffer(Buffer.from('a,b\n1,2\n'), 'spending.csv', 'user-1');

    expect(chunkCsvDocument).toHaveBeenCalled();
    expect(chunkMarkdownDocument).not.toHaveBeenCalled();
  });

  it('returns the existing document when the same CSV is re-uploaded (dedup)', async () => {
    const existing = makeDocument({ id: 'existing-doc', status: 'ready' });
    vi.mocked(requiresPreview).mockReturnValue(false);
    vi.mocked(parseDocument as ReturnType<typeof vi.fn>).mockResolvedValue(csvParsed(2));
    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(existing as never);

    const result = await uploadDocumentFromBuffer(
      Buffer.from('a,b\n1,2\n'),
      'spending.csv',
      'user-1'
    );

    expect(result).toEqual(existing);
    expect(prisma.aiKnowledgeDocument.create).not.toHaveBeenCalled();
    expect(chunkCsvDocument).not.toHaveBeenCalled();
  });

  it('persists CSV structural metadata (delimiter, rowCount, columnCount, hasHeader, warnings)', async () => {
    vi.mocked(requiresPreview).mockReturnValue(false);
    vi.mocked(parseDocument as ReturnType<typeof vi.fn>).mockResolvedValue(csvParsed(3));
    vi.mocked(chunkCsvDocument).mockReturnValue([makeChunk({ chunkType: 'csv_row' })]);
    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(
      makeDocument({ status: 'processing' }) as never
    );
    vi.mocked(embedBatch).mockResolvedValue(mockEmbedResult([[0.1]]));
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(
      makeDocument({ status: 'ready', chunkCount: 1 }) as never
    );

    await uploadDocumentFromBuffer(Buffer.from('a,b\n1,2\n'), 'spending.csv', 'user-1');

    const updateCall = vi.mocked(prisma.aiKnowledgeDocument.update).mock.calls[0][0];
    expect(updateCall.data.metadata).toEqual(
      expect.objectContaining({
        format: 'csv',
        delimiter: ',',
        rowCount: '3',
        columnCount: '2',
        hasHeader: 'true',
      })
    );
  });

  it('marks the document ready with chunkCount 0 when the CSV produces no rows', async () => {
    vi.mocked(requiresPreview).mockReturnValue(false);
    vi.mocked(parseDocument as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...csvParsed(0),
      sections: [],
    });
    vi.mocked(chunkCsvDocument).mockReturnValue([]);
    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(
      makeDocument({ status: 'processing' }) as never
    );
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(
      makeDocument({ status: 'ready', chunkCount: 0 }) as never
    );

    await uploadDocumentFromBuffer(Buffer.from(''), 'empty.csv', 'user-1');

    expect(embedBatch).not.toHaveBeenCalled();
    const updateCall = vi.mocked(prisma.aiKnowledgeDocument.update).mock.calls[0][0];
    expect(updateCall.data.status).toBe('ready');
    expect(updateCall.data.chunkCount).toBe(0);
  });

  it('marks the document failed and rethrows when CSV embedding throws', async () => {
    vi.mocked(requiresPreview).mockReturnValue(false);
    vi.mocked(parseDocument as ReturnType<typeof vi.fn>).mockResolvedValue(csvParsed(1));
    vi.mocked(chunkCsvDocument).mockReturnValue([makeChunk({ chunkType: 'csv_row' })]);
    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(
      makeDocument({ id: 'doc-fail', status: 'processing' }) as never
    );
    vi.mocked(embedBatch).mockRejectedValue(new Error('embedding api down'));
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(
      makeDocument({ id: 'doc-fail', status: 'failed' }) as never
    );

    await expect(
      uploadDocumentFromBuffer(Buffer.from('a,b\n1,2\n'), 'broken.csv', 'user-1')
    ).rejects.toThrow('embedding api down');

    const updateCall = vi.mocked(prisma.aiKnowledgeDocument.update).mock.calls[0][0];
    expect(updateCall.data).toEqual(
      expect.objectContaining({ status: 'failed', errorMessage: 'embedding api down' })
    );
  });

  it('applies a category override to chunks that have no category set', async () => {
    vi.mocked(requiresPreview).mockReturnValue(false);
    vi.mocked(parseDocument as ReturnType<typeof vi.fn>).mockResolvedValue(csvParsed(1));
    const chunk = makeChunk({ chunkType: 'csv_row' });
    chunk.category = '';
    vi.mocked(chunkCsvDocument).mockReturnValue([chunk]);
    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(
      makeDocument({ status: 'processing' }) as never
    );
    vi.mocked(embedBatch).mockResolvedValue(mockEmbedResult([[0.1]]));
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(
      makeDocument({ status: 'ready', chunkCount: 1 }) as never
    );

    await uploadDocumentFromBuffer(Buffer.from('a,b\n1,2\n'), 'data.csv', 'user-1', 'finance');

    expect(chunk.category).toBe('finance');
  });

  it('drops rows over the embedding-API size limit and surfaces a warning naming them', async () => {
    // Three rows: row 1 is fine, row 2 is way over the 32k-char cap, row 3 is fine.
    const huge = 'x'.repeat(40_000);
    const parsed = {
      title: 'mixed',
      author: undefined,
      sections: [
        { title: 'Row 1', content: 'name: Acme | amount: 100', order: 0 },
        { title: 'Row 2', content: `name: Big | blob: ${huge}`, order: 1 },
        { title: 'Row 3', content: 'name: Gamma | amount: 300', order: 2 },
      ],
      fullText: '',
      metadata: { format: 'csv', delimiter: ',', rowCount: '3' },
      warnings: [],
    };
    vi.mocked(parseDocument as ReturnType<typeof vi.fn>).mockResolvedValue(parsed);
    // Chunker is mocked here, but we verify it received the *filtered* sections.
    vi.mocked(chunkCsvDocument).mockReturnValue([
      makeChunk({ id: 'r1', chunkType: 'csv_row' }),
      makeChunk({ id: 'r3', chunkType: 'csv_row' }),
    ]);
    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(
      makeDocument({ status: 'processing' }) as never
    );
    vi.mocked(embedBatch).mockResolvedValue(mockEmbedResult([[0.1], [0.2]]));
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(
      makeDocument({ status: 'ready', chunkCount: 2 }) as never
    );

    await uploadDocumentFromBuffer(Buffer.from('blob csv'), 'mixed.csv', 'user-1');

    // The chunker should have been called with only the two acceptable rows.
    const chunkerArg = vi.mocked(chunkCsvDocument).mock.calls[0][0];
    expect(chunkerArg.sections).toHaveLength(2);
    expect(chunkerArg.sections.map((s) => s.title)).toEqual(['Row 1', 'Row 3']);

    // The persisted warning should name the offending row index.
    const updateCall = vi.mocked(prisma.aiKnowledgeDocument.update).mock.calls[0][0];
    const warnings = (updateCall.data.metadata as { warnings: string[] }).warnings;
    const skipWarning = warnings.find((w) => w.includes('Skipped 1 row'));
    expect(skipWarning).toBeDefined();
    expect(skipWarning).toContain('row 2');
  });

  it('does not warn when every row is within the embedding limit', async () => {
    const parsed = {
      title: 'normal',
      author: undefined,
      sections: [
        { title: 'Row 1', content: 'a: 1', order: 0 },
        { title: 'Row 2', content: 'a: 2', order: 1 },
      ],
      fullText: '',
      metadata: { format: 'csv', delimiter: ',', rowCount: '2' },
      warnings: [],
    };
    vi.mocked(parseDocument as ReturnType<typeof vi.fn>).mockResolvedValue(parsed);
    vi.mocked(chunkCsvDocument).mockReturnValue([
      makeChunk({ id: 'r1', chunkType: 'csv_row' }),
      makeChunk({ id: 'r2', chunkType: 'csv_row' }),
    ]);
    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(
      makeDocument({ status: 'processing' }) as never
    );
    vi.mocked(embedBatch).mockResolvedValue(mockEmbedResult([[0.1], [0.2]]));
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(
      makeDocument({ status: 'ready', chunkCount: 2 }) as never
    );

    await uploadDocumentFromBuffer(Buffer.from('a,b\n1,2\n3,4\n'), 'normal.csv', 'user-1');

    const updateCall = vi.mocked(prisma.aiKnowledgeDocument.update).mock.calls[0][0];
    const warnings = (updateCall.data.metadata as { warnings: string[] }).warnings;
    expect(warnings.some((w) => w.startsWith('Skipped'))).toBe(false);
  });
});

// ─── previewDocument ──────────────────────────────────────────────────────────

describe('previewDocument', () => {
  beforeEach(() => vi.resetAllMocks());

  it('creates a pending_review document record and returns extracted text + metadata', async () => {
    vi.mocked(parseDocument as ReturnType<typeof vi.fn>).mockResolvedValue({
      fullText: 'Extracted PDF text',
      title: 'Annual Report',
      author: 'Finance Team',
      sections: [{ title: 'Summary', content: 'text' }],
      warnings: [],
    });
    const createdDoc = makeDocument({ id: 'doc-preview', status: 'pending_review' });
    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(createdDoc as never);

    const buffer = Buffer.from('fake pdf');
    const result = await previewDocument(buffer, 'annual-report.pdf', 'user-1');

    expect(prisma.aiKnowledgeDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'pending_review' }),
      })
    );
    expect(result.extractedText).toBe('Extracted PDF text');
    expect(result.title).toBe('Annual Report');
    expect(result.author).toBe('Finance Team');
    expect(result.sectionCount).toBe(1);
    expect(result.warnings).toEqual([]);
    expect(result.document.id).toBe('doc-preview');
  });

  it('includes warnings in the preview result', async () => {
    vi.mocked(parseDocument as ReturnType<typeof vi.fn>).mockResolvedValue({
      fullText: 'text',
      title: 'Doc',
      author: undefined,
      sections: [],
      warnings: ['Could not parse page 4'],
    });
    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(makeDocument() as never);

    const result = await previewDocument(Buffer.from('pdf'), 'doc.pdf', 'user-1');

    expect(result.warnings).toEqual(['Could not parse page 4']);
  });

  it('propagates parseDocument errors without creating a document record', async () => {
    // Arrange
    const parseError = new Error('PDF decryption failed');
    vi.mocked(parseDocument as ReturnType<typeof vi.fn>).mockRejectedValue(parseError);

    // Act & Assert: the error propagates — source has no try/catch around parseDocument
    await expect(
      previewDocument(Buffer.from('encrypted pdf'), 'secure.pdf', 'user-1')
    ).rejects.toThrow('PDF decryption failed');

    // No document record should have been created
    expect(prisma.aiKnowledgeDocument.create).not.toHaveBeenCalled();
  });

  it('refreshes the existing pending_review row in place when the same user re-uploads the same file', async () => {
    // The bytes match by hash (same SHA-256), so the second upload should
    // update the existing row rather than create a second pending_review.
    const buffer = Buffer.from('some pdf bytes');
    const existing = makeDocument({
      id: 'doc-existing',
      fileName: 'old-name.pdf',
      status: 'pending_review',
      metadata: { extractedText: 'previous (no tables)', warnings: [] },
    });
    const refreshed = makeDocument({
      id: 'doc-existing',
      fileName: 'spec-v2.pdf',
      status: 'pending_review',
    });

    vi.mocked(parseDocument as ReturnType<typeof vi.fn>).mockResolvedValue({
      fullText: 'fresh text with tables',
      title: 'Spec',
      author: undefined,
      sections: [{ title: 'Page 1', content: '...', order: 0 }],
      metadata: { format: 'pdf' },
      pageInfo: [{ num: 1, charCount: 200, hasText: true }],
      warnings: [],
    });
    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(existing as never);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(refreshed as never);

    const result = await previewDocument(buffer, 'spec-v2.pdf', 'user-1', {
      extractTables: true,
    });

    expect(prisma.aiKnowledgeDocument.create).not.toHaveBeenCalled();
    expect(prisma.aiKnowledgeDocument.update).toHaveBeenCalledWith({
      where: { id: 'doc-existing' },
      data: expect.objectContaining({
        fileName: 'spec-v2.pdf',
        name: 'spec-v2',
        metadata: expect.objectContaining({
          extractedText: 'fresh text with tables',
          pages: [{ num: 1, charCount: 200, hasText: true }],
        }),
      }),
    });
    expect(result.document.id).toBe('doc-existing');
    expect(result.extractedText).toBe('fresh text with tables');
  });

  it('scopes pending_review dedup to the uploading user', async () => {
    // Same fileHash but different user — must look only for rows uploaded by
    // the calling user, otherwise admin A would clobber admin B's preview.
    const buffer = Buffer.from('shared pdf');
    vi.mocked(parseDocument as ReturnType<typeof vi.fn>).mockResolvedValue({
      fullText: 'text',
      title: 'Doc',
      author: undefined,
      sections: [],
      metadata: { format: 'pdf' },
      warnings: [],
    });
    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.aiKnowledgeDocument.create).mockResolvedValue(
      makeDocument({ id: 'new-doc', status: 'pending_review' }) as never
    );

    await previewDocument(buffer, 'shared.pdf', 'user-2');

    expect(prisma.aiKnowledgeDocument.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        uploadedBy: 'user-2',
        status: 'pending_review',
      }),
    });
    expect(prisma.aiKnowledgeDocument.create).toHaveBeenCalled();
  });
});

// ─── confirmPreview ───────────────────────────────────────────────────────────

describe('confirmPreview', () => {
  beforeEach(() => vi.resetAllMocks());

  it('throws when document is not found or not in pending_review status', async () => {
    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(null);

    await expect(confirmPreview('doc-missing', 'user-1')).rejects.toThrow('not found');
  });

  it('throws when content is empty and no correctedContent provided', async () => {
    const doc = makeDocument({
      id: 'doc-empty',
      status: 'pending_review',
      metadata: { extractedText: '   ' }, // whitespace only
    });
    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(doc as never);

    await expect(confirmPreview('doc-empty', 'user-1')).rejects.toThrow('No content available');
  });

  it('uses extractedText from metadata when no correctedContent is provided', async () => {
    const doc = makeDocument({
      id: 'doc-confirm',
      name: 'my-doc',
      fileName: 'my-doc.pdf',
      status: 'pending_review',
      metadata: { extractedText: 'The extracted content here.' },
    });
    const updatedDoc = makeDocument({ id: 'doc-confirm', status: 'ready', chunkCount: 1 });

    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(doc as never);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(updatedDoc as never);
    vi.mocked(chunkMarkdownDocument).mockReturnValue([makeChunk()]);
    vi.mocked(embedBatch).mockResolvedValue(mockEmbedResult([[0.1]]));
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);

    const result = await confirmPreview('doc-confirm', 'user-1');

    expect(chunkMarkdownDocument).toHaveBeenCalledWith(
      'The extracted content here.',
      'my-doc',
      'doc-confirm'
    );
    expect(result.status).toBe('ready');
  });

  it('uses correctedContent when provided, overriding extractedText', async () => {
    const doc = makeDocument({
      id: 'doc-corrected',
      name: 'report',
      fileName: 'report.pdf',
      status: 'pending_review',
      metadata: { extractedText: 'Raw OCR garbage text.' },
    });
    const updatedDoc = makeDocument({ id: 'doc-corrected', status: 'ready', chunkCount: 0 });

    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(doc as never);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(updatedDoc as never);
    vi.mocked(chunkMarkdownDocument).mockReturnValue([]);

    await confirmPreview('doc-corrected', 'user-1', 'The corrected clean text.');

    expect(chunkMarkdownDocument).toHaveBeenCalledWith(
      'The corrected clean text.',
      'report',
      'doc-corrected'
    );
  });

  it('marks document failed and re-throws when embedding fails during confirm', async () => {
    const doc = makeDocument({
      id: 'doc-fail-confirm',
      name: 'doc',
      fileName: 'doc.pdf',
      status: 'pending_review',
      metadata: { extractedText: 'Some content to chunk.' },
    });

    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(doc as never);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(makeDocument() as never);
    vi.mocked(chunkMarkdownDocument).mockReturnValue([makeChunk()]);
    vi.mocked(embedBatch).mockRejectedValue(new Error('Embed failed'));

    await expect(confirmPreview('doc-fail-confirm', 'user-1')).rejects.toThrow('Embed failed');

    // Last update should set status to failed
    const updateCalls = vi.mocked(prisma.aiKnowledgeDocument.update).mock.calls;
    const lastUpdate = updateCalls[updateCalls.length - 1][0];
    expect(lastUpdate.data).toMatchObject({ status: 'failed', errorMessage: 'Embed failed' });
  });

  it('handles empty chunks during confirm (updates to ready with chunkCount 0)', async () => {
    const doc = makeDocument({
      id: 'doc-empty-confirm',
      name: 'empty',
      fileName: 'empty.pdf',
      status: 'pending_review',
      metadata: { extractedText: 'Some content.' },
    });
    const updatedDoc = makeDocument({ id: 'doc-empty-confirm', status: 'ready', chunkCount: 0 });

    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(doc as never);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(updatedDoc as never);
    vi.mocked(chunkMarkdownDocument).mockReturnValue([]);

    const result = await confirmPreview('doc-empty-confirm', 'user-1');

    expect(embedBatch).not.toHaveBeenCalled();
    expect(result.chunkCount).toBe(0);
  });

  it("persists format as 'pdf' (no leading dot) and carries pages metadata forward", async () => {
    const pages = [
      { num: 1, charCount: 200, hasText: true },
      { num: 2, charCount: 0, hasText: false },
    ];
    const doc = makeDocument({
      id: 'doc-meta',
      name: 'manual',
      fileName: 'manual.pdf',
      status: 'pending_review',
      metadata: {
        extractedText: 'Some content to chunk.',
        parsedTitle: 'Manual',
        parsedAuthor: 'Author',
        sectionCount: 2,
        warnings: ['Page 2 of 2 produced no extractable text'],
        pages,
      },
    });
    vi.mocked(prisma.aiKnowledgeDocument.findFirst).mockResolvedValue(doc as never);
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue(
      makeDocument({ id: 'doc-meta', status: 'ready', chunkCount: 1 }) as never
    );
    vi.mocked(chunkMarkdownDocument).mockReturnValue([makeChunk()]);
    vi.mocked(embedBatch).mockResolvedValue(mockEmbedResult([[0.1]]));
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1 as never);

    await confirmPreview('doc-meta', 'user-1');

    const finalUpdate = vi
      .mocked(prisma.aiKnowledgeDocument.update)
      .mock.calls.find((c) => c[0].data.status === 'ready');
    expect(finalUpdate).toBeDefined();
    const md = finalUpdate![0].data.metadata as {
      format: string;
      pages: Array<{ num: number; charCount: number; hasText: boolean }> | null;
    };
    expect(md.format).toBe('pdf');
    expect(md.pages).toEqual(pages);
  });
});
