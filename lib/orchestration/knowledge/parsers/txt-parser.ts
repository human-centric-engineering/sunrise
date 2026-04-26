/**
 * Plain text document parser.
 *
 * Splits text on blank-line-separated sections. If the text contains
 * lines that look like headings (ALL CAPS lines, or lines followed by
 * === / --- underlines), those are used as section boundaries.
 */

import type { ParsedDocument, ParsedSection } from '@/lib/orchestration/knowledge/parsers/types';

/** Detect a line that looks like a heading (ALL CAPS, 3+ chars, no punctuation-heavy). */
function isHeadingLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 3 || trimmed.length > 200) return false;
  // ALL CAPS line (at least 60% letters)
  const letters = trimmed.replace(/[^a-zA-Z]/g, '');
  if (letters.length / trimmed.length < 0.6) return false;
  return trimmed === trimmed.toUpperCase();
}

/** Detect underline-style headings (=== or ---). */
function isUnderline(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= 3 && (/^={3,}$/.test(trimmed) || /^-{3,}$/.test(trimmed));
}

export function parseTxt(buffer: Buffer, fileName: string): ParsedDocument {
  const text = buffer.toString('utf-8');
  const lines = text.split(/\r?\n/);
  const sections: ParsedSection[] = [];
  const warnings: string[] = [];

  let currentTitle = '';
  let currentLines: string[] = [];
  let order = 0;

  function flushSection(): void {
    const content = currentLines.join('\n').trim();
    if (content.length > 0) {
      sections.push({ title: currentTitle, content, order });
      order++;
    }
    currentLines = [];
    currentTitle = '';
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nextLine = i + 1 < lines.length ? lines[i + 1] : undefined;

    // Underline-style heading: previous line is the title, next line is ===
    if (nextLine !== undefined && isUnderline(nextLine)) {
      flushSection();
      currentTitle = line.trim();
      i++; // skip the underline
      continue;
    }

    // ALL CAPS heading
    if (isHeadingLine(line) && currentLines.length > 0) {
      flushSection();
      currentTitle = line.trim();
      continue;
    }

    currentLines.push(line);
  }

  flushSection();

  // If we got no sections from heading detection, treat the whole text as one section
  if (sections.length === 0 && text.trim().length > 0) {
    sections.push({ title: '', content: text.trim(), order: 0 });
  }

  const title = fileName.replace(/\.[^.]+$/, '');
  const fullText = sections.map((s) => s.content).join('\n\n');

  return {
    title,
    sections,
    fullText,
    metadata: { format: 'txt' },
    warnings,
  };
}
