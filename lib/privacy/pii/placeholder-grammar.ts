/**
 * What a placeholder looks like to the code that finds one in text (§127).
 *
 * Restoring is lenient: a model may drop a bracket or add a possessive, so
 * `PERSON_1`, `[PERSON_1`, `PERSON_1]` and `[PERSON_1]'s` all name the same
 * placeholder. Masking uses the same grammar the other way round: any text
 * that already looks like a placeholder is masked too, so that restoring can
 * never turn something the user wrote into a value they did not.
 *
 * @see .context/privacy/llm-privacy-layer.md — *Placeholders*
 */
import { escapeRegExp } from '@/lib/privacy/pii/text';
import { PLACEHOLDER_FORMAT } from '@/lib/privacy/pii/token-strategy';

/**
 * A pattern for placeholders of `types`, bracketed or not. Groups: 1 the
 * opening bracket, 2 the type, 3 the number, 4 the closing bracket. Longer types come first so `UK_NINO` is not read
 * as `UK` and `NINO_…`. Word boundaries keep `MY_PERSON_1` and `PERSON_12`
 * from matching `PERSON_1`.
 */
export function placeholderPattern(types: Iterable<string>): RegExp {
  const list = [...new Set(types)].sort((a, b) => b.length - a.length).map(escapeRegExp);
  // Every caller includes core's types; an empty list is a bug, not a case.
  if (list.length === 0) throw new Error('placeholderPattern: no types');
  const open = escapeRegExp(PLACEHOLDER_FORMAT.open);
  const close = escapeRegExp(PLACEHOLDER_FORMAT.close);
  return new RegExp(`(${open})?\\b(${list.join('|')})_(\\d+)\\b(${close})?`, 'g');
}

/**
 * The characters of an entity type, as character classes: a capital, then
 * capitals, digits and underscores (ENTITY_TYPE_PATTERN). The stream's
 * hold-back is built from these, so it and restore read the same grammar.
 */
export const TYPE_FIRST_CHAR = '[A-Z]';
export const TYPE_CHAR = '[A-Z0-9_]';
/** A word character, as the placeholder pattern's `\b` counts one. */
export const WORD_CHAR = '[A-Za-z0-9_]';
