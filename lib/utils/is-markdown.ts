/**
 * Heuristic detector for markdown-formatted text.
 *
 * Returns true when the string contains at least one clear markdown
 * signal: a fenced code block, ATX heading, list item, blockquote,
 * inline link, bold/italic emphasis, inline code span, or table row.
 *
 * Used by the admin executions UI to decide whether an input/output
 * summary should offer a rendered view alongside the raw text.
 */
export function isMarkdown(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (text.length === 0) return false;

  // Fenced code block.
  if (/^```/m.test(text)) return true;
  // ATX heading (`# ` … `###### `).
  if (/^#{1,6}\s+\S/m.test(text)) return true;
  // Bullet or numbered list item.
  if (/^\s*([-*+]|\d+\.)\s+\S/m.test(text)) return true;
  // Blockquote.
  if (/^>\s+\S/m.test(text)) return true;
  // Inline link `[text](url)`.
  if (/\[[^\]\n]+\]\([^)\n]+\)/.test(text)) return true;
  // Bold (`**x**` or `__x__`).
  if (/(\*\*|__)[^\s*_][^*_\n]*\1/.test(text)) return true;
  // Inline code span (avoid matching a single stray backtick).
  if (/`[^`\n]+`/.test(text)) return true;
  // GFM table — a header row above a `|---|---|` separator row.
  if (/^\s*\|?[^\n]*\|[^\n]*\n\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/m.test(text)) {
    return true;
  }

  return false;
}
