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
  return html
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
    .trim();
}

export async function parseEpub(buffer: Buffer, fileName: string): Promise<ParsedDocument> {
  const warnings: string[] = [];

  // epub2 reads from a file path, so write the upload into a private temp
  // directory created with mkdtemp (mode 0700, unpredictable name) — this
  // avoids the predictable-name / symlink races a shared os.tmpdir() path
  // would invite.
  const tempDir = await mkdtemp(join(tmpdir(), 'sunrise-epub-'));
  const tempPath = join(tempDir, 'book.epub');
  await writeFile(tempPath, buffer);

  try {
    const epub = new EPub(tempPath);
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
        const rawHtml = await epub.getChapterRaw(chapter.id);
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
