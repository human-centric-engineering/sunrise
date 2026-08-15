/**
 * Unit Tests: EPUB Parser (parseEpub) — mocked branch cases
 *
 * Covers the branches that are awkward to reach with a real archive: a chapter
 * whose extraction rejects, individual metadata fields absent, and the HTML
 * stripping rules in isolation.
 *
 * **This file cannot catch a wrong belief about the library, and it once
 * enshrined one.** Its mock declared `parse()` returning a resolved promise
 * while `epub2`'s returned `this` — 27 tests green over a parser that produced
 * an empty document for every book (#606). `epub-parser-archive.test.ts` is the
 * file that can catch that: it mocks nothing and feeds `parseEpub` a real
 * archive. When the library was swapped for `epub` (#601/#614), that suite
 * passed unchanged and this one had to be rewritten — which is the difference
 * between the two, demonstrated.
 *
 * So: keep the assertions here about `parseEpub`'s own logic, and put anything
 * that depends on how the library behaves in the archive suite.
 *
 * Mocking strategy: `epub`'s default export only. There is no `fs` mock because
 * there is no temp file — `epub` reads the Buffer directly.
 *
 * @see lib/orchestration/knowledge/parsers/epub-parser.ts
 * @see tests/unit/lib/orchestration/knowledge/parsers/epub-parser-archive.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mock helpers ────────────────────────────────────────────────────
// vi.hoisted runs before vi.mock factories, so variables declared here are
// available inside mock factories without hoisting issues.

const mocks = vi.hoisted(() => {
  // Copy any addition's shape from `node_modules/epub/dist/epub.d.ts` — the
  // library ships its own types now, so there is no hand-written declaration
  // left to get this wrong in. `parse()` and `getChapterRaw()` really are
  // promise-returning here; under `epub2` neither was, and inventing that in
  // this mock is what hid #606.
  const epubInstance = {
    metadata: {
      title: 'Test Book',
      creator: 'Test Author',
      language: 'en',
      publisher: 'Test Publisher',
    },
    toc: [] as Array<{ id: string; title: string }>,
    flow: [] as Array<{ id: string; title?: string }>,
    parse: vi.fn(),
    getChapterRaw: vi.fn(),
  };

  // `new EPub(buffer)` — a real constructor function, not an arrow, or the
  // `new` fails.
  function MockEPubConstructor(this: unknown) {
    return epubInstance;
  }

  return { epubInstance, EPub: MockEPubConstructor };
});

// ─── Module mocks ────────────────────────────────────────────────────────────

vi.mock('epub', () => ({
  default: mocks.EPub,
}));

// ─── Imports ─────────────────────────────────────────────────────────────────

import { parseEpub } from '@/lib/orchestration/knowledge/parsers/epub-parser';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fakeBuffer(): Buffer {
  return Buffer.from('fake epub binary content');
}

function resetEpubInstance(): void {
  mocks.epubInstance.parse.mockResolvedValue(undefined);
  mocks.epubInstance.metadata = {
    title: 'Test Book',
    creator: 'Test Author',
    language: 'en',
    publisher: 'Test Publisher',
  };
  mocks.epubInstance.toc = [];
  mocks.epubInstance.flow = [];
  mocks.epubInstance.getChapterRaw.mockResolvedValue('<p>Chapter content.</p>');
}

// =============================================================================
// Test Suite
// =============================================================================

describe('parseEpub', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetEpubInstance();
  });

  // ---------------------------------------------------------------------------
  // Metadata extraction
  // ---------------------------------------------------------------------------

  describe('metadata extraction', () => {
    it('should extract title, author, language and publisher into metadata', async () => {
      // Arrange
      mocks.epubInstance.flow = [];

      // Act
      const result = await parseEpub(fakeBuffer(), 'book.epub');

      // Assert
      expect(result.metadata.title).toBe('Test Book');
      expect(result.metadata.author).toBe('Test Author');
      expect(result.metadata.language).toBe('en');
      expect(result.metadata.publisher).toBe('Test Publisher');
    });

    it('should set result.author from epub.metadata.creator', async () => {
      // Arrange
      mocks.epubInstance.flow = [];
      mocks.epubInstance.metadata = { ...mocks.epubInstance.metadata, creator: 'Jane Doe' };

      // Act
      const result = await parseEpub(fakeBuffer(), 'book.epub');

      // Assert
      expect(result.author).toBe('Jane Doe');
    });

    it('should omit metadata keys that are empty or falsy', async () => {
      // Arrange: no creator/language/publisher
      mocks.epubInstance.flow = [];
      mocks.epubInstance.metadata = {
        title: 'Some Title',
        creator: '',
        language: '',
        publisher: '',
      };

      // Act
      const result = await parseEpub(fakeBuffer(), 'book.epub');

      // Assert: only title key present
      expect(result.metadata.title).toBe('Some Title');
      expect(result.metadata.author).toBeUndefined();
      expect(result.metadata.language).toBeUndefined();
      expect(result.metadata.publisher).toBeUndefined();
    });

    it('should use filename (without extension) as title when epub has no metadata title', async () => {
      // Arrange
      mocks.epubInstance.flow = [];
      mocks.epubInstance.metadata = { title: '', creator: '', language: '', publisher: '' };

      // Act
      const result = await parseEpub(fakeBuffer(), 'my-great-book.epub');

      // Assert
      expect(result.title).toBe('my-great-book');
    });

    it('should prefer epub metadata title over filename', async () => {
      // Arrange
      mocks.epubInstance.flow = [];
      mocks.epubInstance.metadata = { ...mocks.epubInstance.metadata, title: 'Metadata Title' };

      // Act
      const result = await parseEpub(fakeBuffer(), 'file.epub');

      // Assert
      expect(result.title).toBe('Metadata Title');
    });
  });

  // ---------------------------------------------------------------------------
  // Chapter extraction and ordering
  // ---------------------------------------------------------------------------

  describe('chapter extraction', () => {
    it('should return empty sections when there are no flow entries', async () => {
      // Arrange
      mocks.epubInstance.flow = [];

      // Act
      const result = await parseEpub(fakeBuffer(), 'empty.epub');

      // Assert
      expect(result.sections).toHaveLength(0);
      expect(result.fullText).toBe('');
    });

    it('should extract a single chapter and preserve its content', async () => {
      // Arrange
      mocks.epubInstance.flow = [{ id: 'ch1', title: 'Chapter One' }];
      mocks.epubInstance.getChapterRaw.mockResolvedValue('<p>Hello world content.</p>');

      // Act
      const result = await parseEpub(fakeBuffer(), 'book.epub');

      // Assert
      expect(result.sections).toHaveLength(1);
      expect(result.sections[0].content).toBe('Hello world content.');
      expect(result.sections[0].order).toBe(0);
    });

    it('should assign ascending order values matching flow index', async () => {
      // Arrange: three chapters
      mocks.epubInstance.flow = [{ id: 'ch1' }, { id: 'ch2' }, { id: 'ch3' }];
      mocks.epubInstance.getChapterRaw.mockResolvedValue('<p>Content here.</p>');

      // Act
      const result = await parseEpub(fakeBuffer(), 'book.epub');

      // Assert
      expect(result.sections.map((s) => s.order)).toEqual([0, 1, 2]);
    });

    it('should skip chapters with fewer than 10 characters after stripping HTML', async () => {
      // Arrange: cover page (near-empty) + real chapter
      mocks.epubInstance.flow = [{ id: 'cover' }, { id: 'ch1' }];
      mocks.epubInstance.getChapterRaw
        .mockResolvedValueOnce('<p> </p>') // 1 char after stripping — too short
        .mockResolvedValueOnce('<p>Proper chapter content here.</p>');

      // Act
      const result = await parseEpub(fakeBuffer(), 'book.epub');

      // Assert: only the real chapter is included
      expect(result.sections).toHaveLength(1);
      expect(result.sections[0].content).toContain('Proper chapter content');
    });

    it('should use TOC title for section when a matching TOC entry exists', async () => {
      // Arrange: TOC and flow both have ch1 but with different titles
      mocks.epubInstance.toc = [{ id: 'ch1', title: 'TOC Chapter One' }];
      mocks.epubInstance.flow = [{ id: 'ch1', title: 'Flow Title' }];
      mocks.epubInstance.getChapterRaw.mockResolvedValue('<p>Chapter content here.</p>');

      // Act
      const result = await parseEpub(fakeBuffer(), 'book.epub');

      // Assert: TOC title wins
      expect(result.sections[0].title).toBe('TOC Chapter One');
    });

    it('should fall back to flow chapter title when no TOC entry exists', async () => {
      // Arrange: no TOC entries
      mocks.epubInstance.toc = [];
      mocks.epubInstance.flow = [{ id: 'ch1', title: 'Flow Chapter Title' }];
      mocks.epubInstance.getChapterRaw.mockResolvedValue('<p>Chapter content here.</p>');

      // Act
      const result = await parseEpub(fakeBuffer(), 'book.epub');

      // Assert
      expect(result.sections[0].title).toBe('Flow Chapter Title');
    });

    it('should use an empty string as title when neither TOC nor flow has a title', async () => {
      // Arrange: no TOC, no flow title
      mocks.epubInstance.toc = [];
      mocks.epubInstance.flow = [{ id: 'ch1' }]; // no title field
      mocks.epubInstance.getChapterRaw.mockResolvedValue('<p>Content here at least.</p>');

      // Act
      const result = await parseEpub(fakeBuffer(), 'book.epub');

      // Assert
      expect(result.sections[0].title).toBe('');
    });

    it('should join all section content into fullText', async () => {
      // Arrange: two chapters
      mocks.epubInstance.flow = [{ id: 'ch1' }, { id: 'ch2' }];
      mocks.epubInstance.getChapterRaw
        .mockResolvedValueOnce('<p>First chapter content.</p>')
        .mockResolvedValueOnce('<p>Second chapter content.</p>');

      // Act
      const result = await parseEpub(fakeBuffer(), 'book.epub');

      // Assert
      expect(result.fullText).toContain('First chapter content.');
      expect(result.fullText).toContain('Second chapter content.');
    });
  });

  // ---------------------------------------------------------------------------
  // Per-chapter error handling
  // ---------------------------------------------------------------------------

  describe('per-chapter error handling', () => {
    it('should skip a chapter and add a warning when getChapterRaw throws', async () => {
      // Arrange: ch1 fails, ch2 succeeds
      mocks.epubInstance.flow = [{ id: 'ch1' }, { id: 'ch2' }];
      mocks.epubInstance.getChapterRaw
        .mockRejectedValueOnce(new Error('Chapter extraction failed'))
        .mockResolvedValueOnce('<p>Second chapter content here.</p>');

      // Act
      const result = await parseEpub(fakeBuffer(), 'book.epub');

      // Assert: ch1 skipped, ch2 included
      expect(result.sections).toHaveLength(1);
      expect(result.sections[0].content).toContain('Second chapter content');
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('ch1');
      expect(result.warnings[0]).toContain('extraction failed');
    });

    it('should collect multiple warnings for multiple failed chapters', async () => {
      // Arrange: first two chapters fail, third succeeds
      mocks.epubInstance.flow = [{ id: 'ch1' }, { id: 'ch2' }, { id: 'ch3' }];
      mocks.epubInstance.getChapterRaw
        .mockRejectedValueOnce(new Error('Failed'))
        .mockRejectedValueOnce(new Error('Failed'))
        .mockResolvedValueOnce('<p>Third chapter content here.</p>');

      // Act
      const result = await parseEpub(fakeBuffer(), 'book.epub');

      // Assert
      expect(result.sections).toHaveLength(1);
      expect(result.warnings).toHaveLength(2);
    });

    it('should return empty sections with all warnings when all chapters fail', async () => {
      // Arrange: all chapters fail
      mocks.epubInstance.flow = [{ id: 'ch1' }, { id: 'ch2' }];
      mocks.epubInstance.getChapterRaw.mockRejectedValue(new Error('Extraction failed'));

      // Act
      const result = await parseEpub(fakeBuffer(), 'book.epub');

      // Assert
      expect(result.sections).toHaveLength(0);
      expect(result.warnings).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // HTML stripping
  // ---------------------------------------------------------------------------

  describe('HTML stripping', () => {
    it('should strip HTML tags from chapter content', async () => {
      // Arrange
      mocks.epubInstance.flow = [{ id: 'ch1' }];
      mocks.epubInstance.getChapterRaw.mockResolvedValue(
        '<div><h1>Title here</h1><p>Body text here.</p></div>'
      );

      // Act
      const result = await parseEpub(fakeBuffer(), 'book.epub');

      // Assert: no angle brackets remain
      expect(result.sections[0].content).not.toContain('<');
      expect(result.sections[0].content).not.toContain('>');
      expect(result.sections[0].content).toContain('Title here');
      expect(result.sections[0].content).toContain('Body text here.');
    });

    it('should strip style blocks from chapter content', async () => {
      // Arrange
      mocks.epubInstance.flow = [{ id: 'ch1' }];
      mocks.epubInstance.getChapterRaw.mockResolvedValue(
        '<style>body { color: red; }</style><p>Actual content here.</p>'
      );

      // Act
      const result = await parseEpub(fakeBuffer(), 'book.epub');

      // Assert: CSS not in output
      expect(result.sections[0].content).not.toContain('color: red');
      expect(result.sections[0].content).toContain('Actual content here.');
    });

    it('should strip script blocks from chapter content', async () => {
      // Arrange
      mocks.epubInstance.flow = [{ id: 'ch1' }];
      mocks.epubInstance.getChapterRaw.mockResolvedValue(
        '<script>alert("xss")</script><p>Safe content here.</p>'
      );

      // Act
      const result = await parseEpub(fakeBuffer(), 'book.epub');

      // Assert: script content removed
      expect(result.sections[0].content).not.toContain('alert');
      expect(result.sections[0].content).toContain('Safe content here.');
    });

    it('should decode HTML entities in content', async () => {
      // Arrange
      mocks.epubInstance.flow = [{ id: 'ch1' }];
      mocks.epubInstance.getChapterRaw.mockResolvedValue(
        '<p>5 &amp; 3, &lt;value&gt;, &quot;quoted&quot;, it&#39;s here&nbsp;now.</p>'
      );

      // Act
      const result = await parseEpub(fakeBuffer(), 'book.epub');

      // Assert: entities decoded
      expect(result.sections[0].content).toContain('5 & 3');
      expect(result.sections[0].content).toContain('<value>');
      expect(result.sections[0].content).toContain('"quoted"');
      expect(result.sections[0].content).toContain("it's");
    });

    it('should convert <br> tags to newlines', async () => {
      // Arrange
      mocks.epubInstance.flow = [{ id: 'ch1' }];
      mocks.epubInstance.getChapterRaw.mockResolvedValue(
        '<p>Line one.<br/>Line two.<br />Line three.</p>'
      );

      // Act
      const result = await parseEpub(fakeBuffer(), 'book.epub');

      // Assert: newlines from br tags
      expect(result.sections[0].content).toContain('Line one.\nLine two.');
    });

    it('should convert </p> to double newlines for paragraph separation', async () => {
      // Arrange
      mocks.epubInstance.flow = [{ id: 'ch1' }];
      mocks.epubInstance.getChapterRaw.mockResolvedValue(
        '<p>First paragraph.</p><p>Second paragraph.</p>'
      );

      // Act
      const result = await parseEpub(fakeBuffer(), 'book.epub');

      // Assert: double newlines separate paragraphs
      expect(result.sections[0].content).toContain('First paragraph.\n\nSecond paragraph.');
    });
  });
});
