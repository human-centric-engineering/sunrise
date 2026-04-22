/**
 * Shared types for document parsers.
 *
 * Every parser converts a raw file buffer into a `ParsedDocument`
 * containing plain text (or markdown) content with structural metadata.
 */

/** A single section extracted from a document (e.g., a chapter or heading). */
export interface ParsedSection {
  /** Section title (chapter name, heading text, etc.). Empty for untitled sections. */
  title: string;
  /** Section content as plain text or markdown. */
  content: string;
  /** Optional ordering hint (chapter number, page number, etc.). */
  order?: number;
}

/** Result of parsing a document file. */
export interface ParsedDocument {
  /** Document title extracted from metadata, or derived from the file name. */
  title: string;
  /** Author name if available. */
  author?: string;
  /** All sections in document order. */
  sections: ParsedSection[];
  /** Full text content (all sections joined). Used for chunking. */
  fullText: string;
  /** Format-specific metadata. */
  metadata: Record<string, string>;
  /** Warnings encountered during parsing (e.g., skipped images, encoding issues). */
  warnings: string[];
}
