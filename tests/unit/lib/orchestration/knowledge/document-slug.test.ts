import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  buildDocumentSlugBase,
  generateUniqueDocumentSlug,
  isDuplicateSlugError,
} from '@/lib/orchestration/knowledge/document-slug';

// A 64-hex SHA-256-shaped string; only the first 8 chars matter for the slug.
const HASH = 'a3f9c1b2deadbeef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('buildDocumentSlugBase', () => {
  it('is slugify(name) + "-" + first 8 hex of the hash', () => {
    expect(buildDocumentSlugBase('Q3 Report', HASH)).toBe('q3-report-a3f9c1b2');
  });

  it('is deterministic — same name + hash always yields the same slug', () => {
    // This is the whole point of #338: re-ingesting the same document in another
    // environment must reproduce the slug so grants reconnect.
    expect(buildDocumentSlugBase('My Document', HASH)).toBe(
      buildDocumentSlugBase('My Document', HASH)
    );
  });

  it('lowercases and collapses non-alphanumeric runs to single dashes', () => {
    expect(buildDocumentSlugBase('Hello,  World!! (v2)', HASH)).toBe('hello-world-v2-a3f9c1b2');
  });

  it('trims leading/trailing separators before appending the hash', () => {
    expect(buildDocumentSlugBase('***edge***', HASH)).toBe('edge-a3f9c1b2');
  });

  it('falls back to "document" when the name slugifies to empty', () => {
    expect(buildDocumentSlugBase('！！！', HASH)).toBe('document-a3f9c1b2');
    expect(buildDocumentSlugBase('', HASH)).toBe('document-a3f9c1b2');
  });

  it('caps the slugified name at 60 chars before the hash suffix', () => {
    const longName = 'a'.repeat(100);
    const slug = buildDocumentSlugBase(longName, HASH);
    expect(slug).toBe(`${'a'.repeat(60)}-a3f9c1b2`);
  });
});

describe('generateUniqueDocumentSlug', () => {
  function clientReturning(takenSlugs: string[]) {
    const taken = new Set(takenSlugs);
    return {
      aiKnowledgeDocument: {
        findUnique: vi.fn(async ({ where }: { where: { slug: string } }) =>
          taken.has(where.slug) ? { id: `id-${where.slug}` } : null
        ),
      },
    };
  }

  it('returns the deterministic base when the slug is free', async () => {
    const client = clientReturning([]);
    await expect(generateUniqueDocumentSlug(client, 'Q3 Report', HASH)).resolves.toBe(
      'q3-report-a3f9c1b2'
    );
    expect(client.aiKnowledgeDocument.findUnique).toHaveBeenCalledTimes(1);
  });

  it('appends -2, -3, ... until it finds a free slug (matches the migration backfill convention)', async () => {
    const client = clientReturning(['q3-report-a3f9c1b2', 'q3-report-a3f9c1b2-2']);
    await expect(generateUniqueDocumentSlug(client, 'Q3 Report', HASH)).resolves.toBe(
      'q3-report-a3f9c1b2-3'
    );
  });

  it('passes a select of only the id (does not over-fetch)', async () => {
    const client = clientReturning([]);
    await generateUniqueDocumentSlug(client, 'Doc', HASH);
    expect(client.aiKnowledgeDocument.findUnique).toHaveBeenCalledWith({
      where: { slug: 'doc-a3f9c1b2' },
      select: { id: true },
    });
  });

  it('treats a slug already owned by excludeId as free (preview-refresh re-derive)', async () => {
    // The taken slug resolves to id `id-<slug>`; passing that id as excludeId
    // means the row may keep its own slug instead of bumping to -2.
    const client = clientReturning(['q3-report-a3f9c1b2']);
    await expect(
      generateUniqueDocumentSlug(client, 'Q3 Report', HASH, 'id-q3-report-a3f9c1b2')
    ).resolves.toBe('q3-report-a3f9c1b2');
  });

  it('still bumps past a slug owned by a DIFFERENT row even with excludeId set', async () => {
    const client = clientReturning(['q3-report-a3f9c1b2']);
    await expect(
      generateUniqueDocumentSlug(client, 'Q3 Report', HASH, 'some-other-id')
    ).resolves.toBe('q3-report-a3f9c1b2-2');
  });
});

describe('buildDocumentSlugBase — SQL backfill parity', () => {
  // These expectations MUST match the output of the SQL backfill in
  // prisma/migrations/20260629120000_add_knowledge_document_slug/migration.sql
  // for the same (name, fileHash). If a slugify() change breaks one, it breaks
  // the cross-environment round-trip for legacy (backfilled) rows. Update BOTH
  // the helper and the migration together, or this test should fail.
  const cases: Array<[string, string, string]> = [
    // [name, fileHash, expected slug]
    ['Agentic Design Patterns', 'd0eb6ede1122334455', 'agentic-design-patterns-d0eb6ede'],
    ['Q3 Report', 'a3f9c1b2ffffffffff', 'q3-report-a3f9c1b2'],
    ['Hello,  World!! (v2)', 'a3f9c1b200000000', 'hello-world-v2-a3f9c1b2'],
    ['***edge***', 'a3f9c1b200000000', 'edge-a3f9c1b2'],
    ['！！！', 'a3f9c1b200000000', 'document-a3f9c1b2'],
    ['a'.repeat(100), 'a3f9c1b200000000', `${'a'.repeat(60)}-a3f9c1b2`],
  ];

  it.each(cases)('slug(%j) === %j', (name, hash, expected) => {
    expect(buildDocumentSlugBase(name, hash)).toBe(expected);
  });
});

describe('isDuplicateSlugError', () => {
  function p2002(target: string[] | string | undefined) {
    return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: target === undefined ? undefined : { target },
    });
  }

  it('is true for a P2002 whose target array includes "slug"', () => {
    expect(isDuplicateSlugError(p2002(['slug']))).toBe(true);
  });

  it('is true for a P2002 whose target is the string "ai_knowledge_document_slug_key"', () => {
    expect(isDuplicateSlugError(p2002('ai_knowledge_document_slug_key'))).toBe(true);
  });

  it('is false for a P2002 on a different column (e.g. fileHash)', () => {
    expect(isDuplicateSlugError(p2002(['fileHash']))).toBe(false);
  });

  it('is false for a non-P2002 Prisma error and for a plain Error', () => {
    const p2025 = new Prisma.PrismaClientKnownRequestError('Not found', {
      code: 'P2025',
      clientVersion: 'test',
    });
    expect(isDuplicateSlugError(p2025)).toBe(false);
    expect(isDuplicateSlugError(new Error('nope'))).toBe(false);
    expect(isDuplicateSlugError(undefined)).toBe(false);
  });
});
