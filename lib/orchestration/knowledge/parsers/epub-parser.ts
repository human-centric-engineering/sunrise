/**
 * EPUB document parser.
 *
 * EPUBs are zipped XHTML with explicit chapter structure, making them
 * one of the most reliable formats to parse. Uses `epub2` to extract
 * chapters, then `dom-text.ts` to turn each one's markup into plain text.
 *
 * Requires the EPUB file to be written to a temp path because epub2
 * reads from the filesystem (not from a buffer).
 */

import { writeFile, rm, mkdtemp } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import EPub from 'epub2';
import { extractTextFromHtml } from '@/lib/orchestration/knowledge/parsers/dom-text';
import type { ParsedDocument, ParsedSection } from '@/lib/orchestration/knowledge/parsers/types';

export async function parseEpub(buffer: Buffer, fileName: string): Promise<ParsedDocument> {
  const warnings: string[] = [];

  // epub2 reads from a file path, so write the upload into a private temp
  // directory created with mkdtemp (mode 0700, unpredictable name) — this
  // avoids the predictable-name / symlink races a shared os.tmpdir() path
  // would invite. The write lives inside the try so the finally cleans up
  // the directory even if writeFile fails.
  const tempDir = await mkdtemp(join(tmpdir(), 'sunrise-epub-'));

  try {
    const tempPath = join(tempDir, 'book.epub');
    await writeFile(tempPath, buffer);

    // `EPub.createAsync()`, NOT `new EPub()` + `await parse()`.
    //
    // `parse()` returns `this`, not a promise — parsing is callback-driven and
    // finishes on an `end` event. Awaiting it resolves on the next microtask
    // with `metadata`, `flow` and `toc` all still empty, so every EPUB ever
    // ingested became a document with the filename as its title, zero sections
    // and empty text — reported as a successful upload, with no warning (#606).
    //
    // `createAsync` is the library's own entry point for this: it resolves
    // only once `end` has fired. What changes is that a VALID archive now
    // comes back with its contents.
    //
    // Two things this does NOT fix, both verified rather than assumed:
    //
    // - An unreadable archive rejected before this change and still does. That
    //   was never the broken part.
    // - A malformed OPF (valid zip, valid container.xml, broken package XML)
    //   makes `createAsync` reject AND then throws an uncatchable
    //   `TypeError: Cannot read properties of null` from inside epub2's own
    //   inflate callback — xml2js emits `error` and `end`, and `parseRootFile`
    //   runs on the null result. No try/catch here can reach it; in Node it
    //   surfaces as an `uncaughtException`. Tracked in #614.
    //
    // Worth knowing if you reproduce this: with a STORED (uncompressed)
    // archive `parse()` completes synchronously and the bug does not appear.
    // Real books are deflated, which is where it bites. See
    // `tests/helpers/epub-fixture.ts`.
    const epub = await EPub.createAsync(tempPath);

    const metadata: Record<string, string> = { format: 'epub' };
    if (epub.metadata.title) metadata.title = epub.metadata.title;
    if (epub.metadata.creator) metadata.author = epub.metadata.creator;
    if (epub.metadata.language) metadata.language = epub.metadata.language;
    if (epub.metadata.publisher) metadata.publisher = epub.metadata.publisher;

    const sections: ParsedSection[] = [];

    // Build a title lookup from TOC
    const tocTitles = new Map<string, string>();
    for (const entry of epub.toc) {
      tocTitles.set(entry.id, entry.title);
    }

    // Extract each chapter in flow order
    for (let i = 0; i < epub.flow.length; i++) {
      const chapter = epub.flow[i];
      try {
        // `getChapterRawAsync`, not `getChapterRaw` — the latter is
        // callback-style and returns `void`, so awaiting it yielded
        // `undefined` and `stripHtml` threw on it. The `catch` below turned
        // that into a "extraction failed" warning for every chapter, which is
        // what the empty-document symptom looked like from the inside on the
        // rare file that got this far.
        const rawHtml = await epub.getChapterRawAsync(chapter.id);
        // A real parse, not a regex strip. `<head>` is excluded structurally
        // (it is not in `document.body`), so a chapter no longer opens with its
        // own `<title>` followed by the same text as its `<h1>` — and CodeQL's
        // five findings against the old replacement chain no longer have
        // anything to describe. Headings come out as markdown, which
        // `chunkMarkdownDocument()` splits on. See `dom-text.ts`.
        const text = extractTextFromHtml(rawHtml);

        if (text.length < 10) {
          // Skip near-empty chapters (cover pages, blank pages)
          continue;
        }

        const title = tocTitles.get(chapter.id) || chapter.title || '';
        sections.push({ title, content: text, order: i });
      } catch {
        warnings.push(`Skipped chapter "${chapter.id}": extraction failed`);
      }
    }

    // An empty result must never be silent. #606 was silent-data-loss, and
    // fixing the await left two paths that still return zero sections from a
    // RESOLVED parse — a book with no spine, and a book whose every chapter
    // strips to nothing (an image-only comic or photo book, where the text
    // lives in the images). Both looked exactly like the bug: `sections: 0`,
    // `warnings: []`, upload reported ready.
    //
    // It is worse than cosmetic downstream. `uploadDocument` derives
    // `fileHash` from the extracted TEXT, not the file bytes
    // (`document-manager.ts:228`), so every book that extracts to nothing
    // hashes to `sha256('')` — and the second one silently dedups into the
    // first, as a different title. A warning here is persisted into the
    // document's metadata and logged, so the operator has something to see.
    // The `warnings.length === 0` guard keeps this to the case where it adds
    // something: if every chapter already failed loudly above, the operator has
    // a warning per chapter and a summary claiming they were "under 10
    // characters" would be both redundant and wrong about why.
    if (epub.flow.length === 0) {
      warnings.push(
        'No chapters extracted: the book declares no reading order (an empty or missing spine).'
      );
    } else if (sections.length === 0 && warnings.length === 0) {
      warnings.push(
        `No text extracted: all ${epub.flow.length} chapter(s) were empty or shorter than 10 characters. ` +
          'If this is an image-only book the text is inside the images and needs OCR before upload.'
      );
    }

    const docTitle = epub.metadata.title || fileName.replace(/\.[^.]+$/, '');
    const fullText = sections.map((s) => s.content).join('\n\n');

    return {
      title: docTitle,
      author: epub.metadata.creator,
      sections,
      fullText,
      metadata,
      warnings,
    };
  } finally {
    // Clean up the temp directory and its contents
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
