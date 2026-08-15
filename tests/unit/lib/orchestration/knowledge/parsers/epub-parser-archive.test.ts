/**
 * Unit Tests: EPUB Parser against a REAL archive (`parseEpub`)
 *
 * Deliberately mocks nothing. `epub-parser.test.ts` next door mocks `epub2`
 * and `fs/promises` to reach the branch cases — near-empty chapters, per-chapter
 * extraction failures, temp-directory lifecycle — and that file is still worth
 * having. What it cannot do is notice that the mock does not match the library:
 * it declared `parse()` as returning a resolved promise, the real one returns
 * `this`, and so 27 green tests sat on top of a parser that returned an **empty
 * document for every EPUB ever ingested**, silently, reporting success (#606).
 *
 * A mock can only confirm the shape its author believed in. These tests feed
 * the parser a spec-valid archive built by `tests/helpers/epub-fixture.ts` —
 * whose ZIP writer is hand-rolled precisely so the input does not come from the
 * library under test — and assert on the text that comes out.
 *
 * If you change the parser's entry points, this file is the one that will
 * notice.
 *
 * @see lib/orchestration/knowledge/parsers/epub-parser.ts
 * @see tests/helpers/epub-fixture.ts
 */

import { describe, it, expect } from 'vitest';

import { parseEpub } from '@/lib/orchestration/knowledge/parsers/epub-parser';
import { buildEpub, DEFAULT_CHAPTERS } from '@/tests/helpers/epub-fixture';

describe('parseEpub — real archive', () => {
  describe('the #606 regression', () => {
    it('returns the book, not an empty document', async () => {
      // The single assertion that would have caught it. Everything below is
      // detail; this is the bug. `await epub.parse()` resolved one microtask
      // into a parse that had not started, so `flow` was empty, no chapter was
      // read, and the result was `{ sections: [], fullText: '' }` — with the
      // filename as the title and `warnings: []`, so nothing downstream could
      // tell the difference between "an empty book" and "a book we failed to
      // read".
      const result = await parseEpub(buildEpub(), 'probe.epub');

      expect(result.sections.length).toBeGreaterThan(0);
      expect(result.fullText.length).toBeGreaterThan(0);
      expect(result.title).not.toBe('probe');
    });
  });

  describe('metadata', () => {
    it('reads title, author, language and publisher off the OPF', async () => {
      const result = await parseEpub(buildEpub(), 'ignored-filename.epub');

      expect(result.title).toBe('Sunrise Probe Book');
      expect(result.author).toBe('A Test Author');
      expect(result.metadata).toEqual({
        format: 'epub',
        title: 'Sunrise Probe Book',
        author: 'A Test Author',
        language: 'en',
        publisher: 'Sunrise Press',
      });
    });

    it('falls back to the filename when the book declares no title', async () => {
      const result = await parseEpub(buildEpub({ title: '' }), 'the-filename.epub');

      expect(result.title).toBe('the-filename');
    });
  });

  describe('chapters', () => {
    it('extracts every spine chapter, in flow order, with its prose', async () => {
      const result = await parseEpub(buildEpub(), 'probe.epub');

      expect(result.sections).toHaveLength(2);
      expect(result.sections[0].order).toBe(0);
      expect(result.sections[1].order).toBe(1);
      expect(result.sections[0].content).toContain('the clocks were striking thirteen');
      expect(result.sections[1].content).toContain('boiled cabbage and old rag mats');
    });

    it('titles each section from the NCX table of contents', async () => {
      const result = await parseEpub(buildEpub(), 'probe.epub');

      expect(result.sections.map((s) => s.title)).toEqual([
        'The First Chapter',
        'The Second Chapter',
      ]);
    });

    it('still extracts the prose when the book has no table of contents', async () => {
      // A TOC is not required to read a book. Titles go empty; the text must
      // not.
      const result = await parseEpub(buildEpub({ omitToc: true }), 'probe.epub');

      expect(result.sections).toHaveLength(2);
      expect(result.sections.map((s) => s.title)).toEqual(['', '']);
      expect(result.sections[0].content).toContain('striking thirteen');
    });

    it('joins the chapters into fullText in order', async () => {
      const result = await parseEpub(buildEpub(), 'probe.epub');

      expect(result.fullText).toBe(result.sections.map((s) => s.content).join('\n\n'));
      expect(result.fullText.indexOf('striking thirteen')).toBeLessThan(
        result.fullText.indexOf('boiled cabbage')
      );
    });

    it('skips a near-empty chapter without warning about it', async () => {
      // Cover pages and blank leaves are ordinary, not failures — the parser
      // drops anything under 10 characters and says nothing.
      const result = await parseEpub(
        buildEpub({
          chapters: [{ id: 'cover', title: 'Cover', bodyHtml: '<p>.</p>' }, ...DEFAULT_CHAPTERS],
        }),
        'probe.epub'
      );

      expect(result.sections).toHaveLength(2);
      expect(result.sections.map((s) => s.title)).not.toContain('Cover');
      expect(result.warnings).toEqual([]);
    });

    it('does not repeat the chapter title from the XHTML <head>', async () => {
      // `getChapterRawAsync` hands back the whole file, `<head>` included, so
      // every chapter's text used to open with its `<title>` and then its
      // `<h1>` — the same heading twice before a word of prose, and twice in
      // whatever gets embedded. Only visible once the parser returned anything.
      const result = await parseEpub(
        buildEpub({
          chapters: [
            {
              id: 'only',
              title: 'A Distinctive Heading',
              bodyHtml: '<h1>A Distinctive Heading</h1><p>Body prose follows the heading here.</p>',
            },
          ],
        }),
        'probe.epub'
      );

      const occurrences = result.sections[0].content.split('A Distinctive Heading').length - 1;
      expect(occurrences).toBe(1);
    });
  });

  describe('an empty result is never silent', () => {
    // Fixing the await left two paths that still return zero sections from a
    // RESOLVED parse, and both looked exactly like the bug they were left
    // behind by: `sections: 0`, `warnings: []`, upload reported ready.
    //
    // Not cosmetic. `uploadDocument` derives `fileHash` from the extracted
    // TEXT, not the file bytes, so every book that extracts to nothing hashes
    // to `sha256('')` — and the second one silently dedups into the first,
    // under a different title.

    it('warns when an image-only book yields no text', async () => {
      const result = await parseEpub(
        buildEpub({
          chapters: [
            { id: 'plate-1', title: 'Plate 1', bodyHtml: '<p><img src="1.jpg"/></p>' },
            { id: 'plate-2', title: 'Plate 2', bodyHtml: '<p><img src="2.jpg"/></p>' },
          ],
        }),
        'comic.epub'
      );

      expect(result.sections).toHaveLength(0);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('No text extracted');
      expect(result.warnings[0]).toContain('2 chapter(s)');
      expect(result.warnings[0]).toContain('OCR');
    });

    it('warns when the book declares no reading order', async () => {
      const result = await parseEpub(buildEpub({ chapters: [] }), 'empty.epub');

      expect(result.sections).toHaveLength(0);
      expect(result.warnings).toEqual([
        'No chapters extracted: the book declares no reading order (an empty or missing spine).',
      ]);
    });

    it('stays quiet on a book that DID yield text', async () => {
      // The warnings must not fire on the ordinary path, or they are noise and
      // will be ignored on the one upload that needed them.
      const result = await parseEpub(buildEpub(), 'probe.epub');

      expect(result.sections.length).toBeGreaterThan(0);
      expect(result.warnings).toEqual([]);
    });
  });

  describe('a file that cannot be read', () => {
    it('REJECTS rather than returning an empty document', async () => {
      // A regression guard, not a fix: measured against the pre-#606 parser,
      // this already rejected. It is pinned because it is now the ONLY thing
      // separating "unreadable" from "readable but empty" — before the fix
      // those two produced identical output for a *valid* archive, and the
      // temptation when a parse fails is to degrade to an empty document
      // rather than fail the upload. Don't.
      await expect(
        parseEpub(Buffer.from('this is not a zip at all'), 'bad.epub')
      ).rejects.toThrow();
    });

    it('rejects promptly rather than hanging on the parse callback', async () => {
      // `createAsync` resolves on an `end` event; a malformed file must reach
      // `error` instead. If this ever regresses into a hang, CI blocks on a
      // 30s timeout rather than reporting a parse failure.
      const started = Date.now();
      await expect(parseEpub(Buffer.from('nope'), 'bad.epub')).rejects.toThrow();

      expect(Date.now() - started).toBeLessThan(5000);
    });
  });
});
