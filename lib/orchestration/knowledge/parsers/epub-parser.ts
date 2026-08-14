/**
 * EPUB document parser.
 *
 * EPUBs are zipped XHTML with explicit chapter structure, making them
 * one of the most reliable formats to parse. Uses `epub2` to extract
 * chapters, then strips HTML tags to get plain text.
 *
 * Requires the EPUB file to be written to a temp path because epub2
 * reads from the filesystem (not from a buffer).
 */

import { writeFile, rm, mkdtemp } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import EPub from 'epub2';
import type { ParsedDocument, ParsedSection } from '@/lib/orchestration/knowledge/parsers/types';

/**
 * Strip HTML tags and decode basic entities to plain text.
 *
 * SECURITY INVARIANT — this is a best-effort *plaintext extractor*, not an
 * XSS-safe HTML sanitiser. The regex passes can be defeated by adversarial
 * markup (nested `<scr<script>ipt>`, `</script >`, double-encoded entities),
 * and that is acceptable here because the output is never rendered as HTML:
 * it is stored as knowledge-base text and rendered downstream by
 * `react-markdown` with no `rehype-raw` plugin, so any surviving tag is inert
 * (same contract as `pdf-parser.ts`). If a future change feeds this output to
 * an HTML sink or enables raw-HTML rendering, replace this with a real
 * sanitiser (e.g. DOMPurify) before doing so.
 */
function stripHtml(html: string): string {
  return (
    html
      // `getChapterRawAsync` returns the whole XHTML file, `<head>` included, so
      // without this every chapter's text opened with its own `<title>` — and
      // then its `<h1>`, giving the same heading twice before a word of prose.
      // Only visible once #606 made the parser return anything at all.
      .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/h[1-6]>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

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
    // only once `end` has fired. A malformed archive still rejects, as it did
    // before — that was never the broken part. What changes is that a VALID
    // archive now comes back with its contents, so rejecting is once again the
    // only way to get an empty result, and "unreadable" stops being
    // indistinguishable from "read fine, contained nothing".
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
        const text = stripHtml(rawHtml);

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
