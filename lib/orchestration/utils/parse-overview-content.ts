import { stripEmbeddingPrefix } from '@/lib/orchestration/utils/strip-embedding-prefix';

/**
 * Parse the body of a `pattern_overview` chunk into its two surface elements:
 * a bold list of software-engineering parallels and an optional italic
 * example sentence. Returns nulls for either part when not present.
 *
 * Used by the Learn pattern detail page and the workflow-builder
 * "learn more" dialog to render the parallels as a labelled caption
 * beneath the page heading rather than as a hero card.
 */
export function parseOverviewContent(content: string): {
  parallels: string | null;
  example: string | null;
} {
  const stripped = stripEmbeddingPrefix(content);
  const lines = stripped
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  let parallels: string | null = null;
  let example: string | null = null;

  for (const line of lines) {
    const boldOnly = line.match(/^\*\*(.+)\*\*$/);
    if (boldOnly && !parallels) {
      parallels = boldOnly[1].trim();
      continue;
    }
    const italicOnly = line.match(/^\*([^*].*?)\*$/);
    if (italicOnly && !example) {
      example = italicOnly[1].trim();
    }
  }

  return { parallels, example };
}
