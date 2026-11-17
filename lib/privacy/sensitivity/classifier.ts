/**
 * Core's sensitivity classifier: a maintained phrase list (§130, t-1036).
 *
 * Reads the `user` parts of a call and its `embedding` inputs only, never the
 * system prompt, tool results or tool-call arguments (spec § Confidential
 * content, *What is classified*). For each category it blanks the category's
 * exclusions out of that text, then looks for any of its phrases as whole
 * words. It returns the categories found, never where or what.
 *
 * Synchronous work behind an async contract, like core's detectors. The
 * regular expressions are compiled once, at first use, and each is linear in
 * the text, so a long history costs a pass per category and no more.
 *
 * @see lib/privacy/sensitivity/phrases.ts — the list, and how to add to it
 * @see .context/privacy/llm-privacy-layer.md — *Confidential content*
 */
import {
  CORE_SENSITIVITY_CATEGORIES,
  type CoreSensitivityCategory,
  type SensitivityClassifier,
  type SensitivityFinding,
  type SensitivityInput,
  type SensitivityPartRole,
} from '@/lib/privacy/adapters/types';
import { SENSITIVITY_PHRASES } from '@/lib/privacy/sensitivity/phrases';

export const SENSITIVITY_PHRASES_CLASSIFIER_ID = 'core.sensitivity-phrases';

/** The parts core's classifier reads. */
const CLASSIFIED_ROLES: ReadonlySet<SensitivityPartRole> = new Set(['user', 'embedding']);

/** Not a letter, digit or underscore on either side: a whole word. */
const BEFORE = '(?<![\\p{L}\\p{N}_])';
const AFTER = '(?![\\p{L}\\p{N}_])';

/**
 * A phrase's source as the list writes it, as a regular expression: a space
 * then `?` matches no separator or any run, a space matches a run of
 * whitespace or hyphens.
 */
export function phraseSource(phrase: string): string {
  return phrase.replaceAll(' ?', '[\\s\\-]*').replaceAll(' ', '[\\s\\-]+');
}

function compile(phrases: readonly string[], flags: string): RegExp {
  return new RegExp(`${BEFORE}(?:${phrases.map(phraseSource).join('|')})${AFTER}`, flags);
}

interface CompiledCategory {
  category: CoreSensitivityCategory;
  phrases: RegExp;
  exclude: RegExp | null;
}

let compiled: CompiledCategory[] | null = null;

function categories(): CompiledCategory[] {
  compiled ??= (Object.keys(SENSITIVITY_PHRASES) as CoreSensitivityCategory[]).map((category) => {
    const { phrases, exclude } = SENSITIVITY_PHRASES[category];
    return {
      category,
      phrases: compile(phrases, 'iu'),
      // Global: every exclusion in the text is blanked, not the first.
      exclude: exclude && exclude.length > 0 ? compile(exclude, 'giu') : null,
    };
  });
  return compiled;
}

/** Curly apostrophes as straight ones, so "can’t" reads as "can't". */
function normalise(text: string): string {
  return text.replace(/[‘’ʼ]/g, "'");
}

/** The categories `text` discloses, in the list's order. */
export function classifyText(text: string): CoreSensitivityCategory[] {
  const normalised = normalise(text);
  const found: CoreSensitivityCategory[] = [];
  for (const { category, phrases, exclude } of categories()) {
    // Blanked with spaces, not removed, so the words either side of an
    // exclusion stay apart and are not read as one.
    const target = exclude ? normalised.replace(exclude, (m) => ' '.repeat(m.length)) : normalised;
    if (phrases.test(target)) found.push(category);
  }
  return found;
}

/**
 * Between parts: neither whitespace nor a hyphen, so no phrase matches across
 * two parts ("…in" at the end of one, "hospital…" at the start of the next).
 */
const PART_SEPARATOR = '\n\u241E\n';

/** The text core's classifier reads from a call: its user parts and embedding inputs. */
function classifiedText(input: SensitivityInput): string {
  return input.parts
    .filter((p) => CLASSIFIED_ROLES.has(p.role))
    .map((p) => p.text)
    .join(PART_SEPARATOR);
}

export function sensitivityPhrasesClassifier(): SensitivityClassifier {
  return {
    id: SENSITIVITY_PHRASES_CLASSIFIER_ID,
    egress: 'in_process',
    categories: CORE_SENSITIVITY_CATEGORIES,
    classify(input: SensitivityInput): Promise<readonly SensitivityFinding[]> {
      const text = classifiedText(input);
      if (text.length === 0) return Promise.resolve([]);
      return Promise.resolve(classifyText(text).map((category) => ({ category })));
    },
  };
}
