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

import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import EPub from 'epub2';
import type { ParsedDocument, ParsedSection } from '@/lib/orchestration/knowledge/parsers/types';

/** Strip HTML tags and decode basic entities. */
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

  // Write buffer to temp file (epub2 requires a file path)
  const tempPath = join(tmpdir(), `sunrise-epub-${randomUUID()}.epub`);
  await writeFile(tempPath, buffer);

  try {
    const epub = new EPub(tempPath);
    await epub.parse();

    const metadata: Record<string, string> = {};
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
    // Clean up temp file
    await unlink(tempPath).catch(() => {});
  }
}
