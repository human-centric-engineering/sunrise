/**
 * Strip the embedding prefix ("PatternName — SectionName\n\n" or "PatternName\n\n")
 * that the chunker prepends for vector search context. The detail page already
 * displays the pattern name and section heading separately.
 */
export function stripEmbeddingPrefix(content: string): string {
  const withDash = content.match(/^.+ — .+\n\n([\s\S]*)$/);
  if (withDash) return withDash[1];
  const plain = content.match(/^[^\n]+\n\n([\s\S]*)$/);
  if (plain) return plain[1];
  return content;
}
