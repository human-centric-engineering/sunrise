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
import { formatPlaceholder, PLACEHOLDER_FORMAT } from '@/lib/privacy/pii/token-strategy';

/**
 * A pattern for placeholders of `types`, bracketed or not. Group 1 is the
 * type, group 2 the number. Longer types come first so `UK_NINO` is not read
 * as `UK` and `NINO_…`. Word boundaries keep `MY_PERSON_1` and `PERSON_12`
 * from matching `PERSON_1`.
 */
export function placeholderPattern(types: Iterable<string>): RegExp | null {
  const list = [...new Set(types)].sort((a, b) => b.length - a.length).map(escapeRegExp);
  if (list.length === 0) return null;
  const open = escapeRegExp(PLACEHOLDER_FORMAT.open);
  const close = escapeRegExp(PLACEHOLDER_FORMAT.close);
  return new RegExp(`${open}?\\b(${list.join('|')})_(\\d+)\\b${close}?`, 'g');
}

/**
 * The canonical placeholder a match names. The number is taken as written:
 * `PERSON_01` is not `PERSON_1`, because reading it so would be a guess.
 */
export function canonical(type: string, n: string): string {
  return formatPlaceholder(type, n);
}
