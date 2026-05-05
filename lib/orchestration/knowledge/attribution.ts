/**
 * Single source of truth for source attribution displayed in the
 * Learning area and admin Knowledge views. The 21 design patterns and
 * their accompanying content are paraphrased from Antonio Gullí's
 * book "Agentic Design Patterns" — surface this credit consistently
 * everywhere we render that material.
 *
 * The chunks themselves carry the raw string under
 * `metadata.source` in chunks.json; this module is the rendered form.
 */

/** Author and book title used across UI surfaces. */
export const PATTERN_ATTRIBUTION_TEXT = 'Agentic Design Patterns by Antonio Gullí';

/** Canonical short credit line — drop into footers / captions verbatim. */
export const PATTERN_ATTRIBUTION_LINE = `Adapted from ${PATTERN_ATTRIBUTION_TEXT}.`;
