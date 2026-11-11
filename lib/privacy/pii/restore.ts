/**
 * Putting values back where a model wrote placeholders (§127).
 *
 * Lenient about form, strict about identity. `PERSON_1`, `[PERSON_1`,
 * `[PERSON_1]'s` and a placeholder inside a JSON string all restore, because
 * a model reproduces brackets imperfectly. But only a placeholder this call's
 * session issued is replaced: one it never issued (a model inventing
 * `PERSON_9`) is left visible and reported, never mapped to the nearest real
 * value.
 *
 * @see .context/privacy/llm-privacy-layer.md — *Placeholders*
 */
import {
  CORE_ENTITY_TYPES,
  type EntityType,
  type TokenSession,
} from '@/lib/privacy/adapters/types';
import { canonical, placeholderPattern } from '@/lib/privacy/pii/placeholder-grammar';
import { allMatches } from '@/lib/privacy/pii/text';
import { LITERAL_TYPE } from '@/lib/privacy/pii/token-strategy';

export interface RestoreResult {
  text: string;
  /** Placeholders replaced by their values. */
  restored: number;
  /** Placeholder-shaped text this session never issued, left as written. */
  unresolved: string[];
}

/**
 * The pattern for `session`: the types it issued, plus every core type and
 * every `declaredTypes` entry, so a made-up placeholder of any type a
 * detector could report is counted as unresolved rather than ignored.
 *
 * Built once per restore — per stream, per argument walk — not per chunk or
 * per string.
 */
export function sessionPattern(
  session: TokenSession,
  declaredTypes: Iterable<EntityType> = []
): RegExp | null {
  return placeholderPattern([
    ...CORE_ENTITY_TYPES,
    LITERAL_TYPE,
    ...declaredTypes,
    ...session.entries().map((e) => e.type),
  ]);
}

/**
 * Restore every placeholder in `text` that `session` issued.
 *
 * Values go in as they are. For JSON — tool-call arguments, a structured
 * reply — parse first and use `restoreValue()`: a value containing a quote
 * restored into raw JSON text would break it, or add a key.
 *
 * `declaredTypes` (every type the registered detectors may report) only
 * widens what is counted as unresolved; leaving it out loses a count, never
 * a value.
 */
export function restoreText(
  text: string,
  session: TokenSession,
  declaredTypes: Iterable<EntityType> = []
): RestoreResult {
  return restoreAfter('', text, session, sessionPattern(session, declaredTypes));
}

/**
 * Restore `text`, read as following `context`, with a pattern from
 * `sessionPattern()`. A placeholder needs a word boundary before it, so
 * whether the start of `text` can begin one depends on what came before; the
 * streaming restorer passes the last character it emitted. A match that
 * begins inside `context` is not this text's to restore.
 */
export function restoreAfter(
  context: string,
  text: string,
  session: TokenSession,
  pattern: RegExp | null
): RestoreResult {
  if (!pattern) return { text, restored: 0, unresolved: [] };
  const probe = context + text;
  let out = '';
  let at = context.length;
  let restored = 0;
  const unresolved: string[] = [];
  for (const m of allMatches(pattern, probe)) {
    if (m.index < context.length) continue;
    const value = session.valueFor(canonical(m[1], m[2]));
    if (value === undefined) {
      unresolved.push(m[0]);
      continue;
    }
    out += probe.slice(at, m.index) + value;
    at = m.index + m[0].length;
    restored++;
  }
  out += probe.slice(at);
  return { text: out, restored, unresolved };
}

export interface ValueRestoreResult {
  /** The same shape, with placeholders in its strings restored. */
  value: unknown;
  restored: number;
  unresolved: string[];
}

/**
 * Restore placeholders in every string inside a parsed value: a tool call's
 * arguments, at any depth of objects and arrays. Keys are left alone — a
 * placeholder is a value the model copied, and restoring a key could merge
 * two of them. Run on the parsed arguments, not their JSON text, so a value
 * containing a quote cannot break the JSON.
 *
 * Returns `unknown`: the arguments are model output, and the capability
 * validates them with its own schema after this, as it always does.
 */
export function restoreValue(
  value: unknown,
  session: TokenSession,
  declaredTypes: Iterable<EntityType> = []
): ValueRestoreResult {
  let restored = 0;
  const unresolved: string[] = [];
  const pattern = sessionPattern(session, declaredTypes);
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = restoreAfter('', v, session, pattern);
      restored += r.restored;
      unresolved.push(...r.unresolved);
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, inner]) => [k, walk(inner)]));
    }
    return v;
  };
  return { value: walk(value), restored, unresolved };
}
