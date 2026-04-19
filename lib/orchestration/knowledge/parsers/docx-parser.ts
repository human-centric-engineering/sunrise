/**
 * DOCX document parser.
 *
 * Uses `mammoth` to convert DOCX → markdown, then splits on heading
 * markers for section extraction. Mammoth handles styles, lists, tables,
 * and bold/italic reasonably well.
 */

import mammoth from 'mammoth';
import type { ParsedDocument, ParsedSection } from './types';

export async function parseDocx(buffer: Buffer, fileName: string): Promise<ParsedDocument> {
  const warnings: string[] = [];

  const result = await mammoth.convertToMarkdown({ buffer });

  // Collect mammoth conversion warnings
  for (const msg of result.messages) {
    if (msg.type === 'warning') {
      warnings.push(`DOCX: ${msg.message}`);
    }
  }

  const markdown = result.value;
  if (!markdown.trim()) {
    return {
      title: fileName.replace(/\.[^.]+$/, ''),
      sections: [],
      fullText: '',
      metadata: { format: 'docx' },
      warnings: [...warnings, 'Document produced no text content'],
    };
  }

  // Split on markdown headings (## or # at start of line)
  const sections = splitMarkdownSections(markdown);

  const title =
    sections.length > 0 && sections[0].title ? sections[0].title : fileName.replace(/\.[^.]+$/, '');

  const fullText = sections.map((s) => s.content).join('\n\n');

  return {
    title,
    sections,
    fullText,
    metadata: { format: 'docx' },
    warnings,
  };
}

function splitMarkdownSections(markdown: string): ParsedSection[] {
  const lines = markdown.split(/\r?\n/);
  const sections: ParsedSection[] = [];
  let currentTitle = '';
  let currentLines: string[] = [];
  let order = 0;

  function flush(): void {
    const content = currentLines.join('\n').trim();
    if (content.length > 0) {
      sections.push({ title: currentTitle, content, order });
      order++;
    }
    currentLines = [];
    currentTitle = '';
  }

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      flush();
      currentTitle = headingMatch[2].trim();
      continue;
    }
    currentLines.push(line);
  }

  flush();

  return sections;
}
