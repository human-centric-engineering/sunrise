/**
 * EPUB document parser.
 *
 * EPUBs are zipped XHTML with an explicit spine and table of contents, so the
 * chapter structure is declared rather than inferred. Reads chapters with
 * `epub`, then `dom-text.ts` turns each one's markup into plain text.
 *
 * **On the library.** This used `epub2` until #613. That fork has not published
 * since Sept 2023, pins `adm-zip ^0.5.10` with the patch for its high advisory
 * at 0.6.0 and therefore permanently out of reach (#601), drives everything
 * through callbacks while returning `this` from `parse()` (#606), and throws an
 * uncatchable `TypeError` out of its own inflate callback on a malformed OPF
 * (#614). `epub` — the package `epub2` was forked FROM — has since been
 * modernised: real promises, `fast-xml-parser` + `jszip` in place of
 * `adm-zip`/`xml2js`/`bluebird`, its own TypeScript types, and a `Buffer`
 * constructor. Swapping to it closed all three issues and deleted this file's
 * temp-file dance; nothing chose `epub2` deliberately, it arrived inside a
 * large feature commit with no comparison recorded.
 */

import EPub from 'epub';
import { extractTextFromHtml } from '@/lib/orchestration/knowledge/parsers/dom-text';
import type { ParsedDocument, ParsedSection } from '@/lib/orchestration/knowledge/parsers/types';

export async function parseEpub(buffer: Buffer, fileName: string): Promise<ParsedDocument> {
  const warnings: string[] = [];

  // Straight from the Buffer — no temp file. `epub2` could only read a path,
  // so this used to mkdtemp/writeFile/rm around every parse; that whole dance
  // (and the symlink-race surface it was carefully written to avoid) is gone
  // with the library that required it.
  //
  // `parse()` genuinely returns a promise here, and `getChapterRaw()` below
  // genuinely resolves to the chapter's XHTML. Under `epub2` neither did, which
  // is #606 — and the repo's hand-written `types/epub2.d.ts` claimed exactly
  // these two signatures, so the code was always written against THIS library's
  // API. It just wasn't installed.
  //
  // A malformed archive rejects, and so does a malformed OPF — verified against
  // both, including the case that made `epub2` throw an uncatchable TypeError
  // out of its own inflate callback (#614).
  const epub = new EPub(buffer);

  await epub.parse();

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
      // Raw, not `getChapter()` — the latter rewrites links and image srcs for
      // a reader UI, which is work we would only strip off again.
      const rawHtml = await epub.getChapterRaw(chapter.id);
      // A real parse, not a regex strip — `<head>` is excluded structurally
      // rather than by a rule, and headings come out as markdown, which
      // `chunkMarkdownDocument()` splits on. See `dom-text.ts` for which of
      // CodeQL's findings against the old chain were real and which were not.
      const text = extractTextFromHtml(rawHtml);

      if (text.length < 10) {
        // Skip near-empty chapters (cover pages, blank pages)
        continue;
      }

      // `flow` entries are manifest items, which carry no declared `title` —
      // the NCX is where chapter titles live. Read it defensively rather than
      // asserting a shape the library does not promise.
      const flowTitle = typeof chapter.title === 'string' ? chapter.title : '';
      const title = tocTitles.get(chapter.id) || flowTitle;
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
}
