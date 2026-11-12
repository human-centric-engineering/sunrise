/**
 * Tier C — names, addresses and companies found from word lists and cues
 * (§127).
 *
 * The weakest tier, and the one that finds what no rule can: other people's
 * names, street addresses, the companies a conversation mentions. Everything
 * here is a guess, scored as one — between 0.5 for a lone first name and 0.85
 * for a name ending in "Ltd" — so a rule or a known value covering the same
 * text names the merged span.
 *
 * It works on capitalised words, so a name typed in lower case is missed;
 * tier B catches the names the layer already knows, whatever the case.
 * English only.
 *
 * What it learns, it learns from the text it is given and forgets after: a
 * company found with its suffix ("Halden Logistics Ltd") marks its short form
 * ("Halden") elsewhere in the same text, and a full name marks its parts.
 *
 * Reached only through the registry (`core-defaults.ts`).
 *
 * @see .context/privacy/llm-privacy-layer.md — *Detection*
 */
import type {
  AttributedSpan,
  DetectedSpan,
  EntityType,
  PrivacyDetector,
} from '@/lib/privacy/adapters/types';
import {
  ALLOWLIST,
  COMMON_WORDS,
  isFirstName,
  isSurname,
  ORG_CONNECTORS,
  ORG_SUFFIXES,
  PLACES,
  STREET_SUFFIXES,
  TITLES,
} from '@/lib/privacy/pii/lexicon';
import { allMatches, coverage, createYielder, escapeRegExp, span } from '@/lib/privacy/pii/text';

export const LISTS_DETECTOR_ID = 'core.lists';

export const LISTS_ENTITY_TYPES = [
  'PERSON',
  'ORG',
  'ADDRESS',
] as const satisfies readonly EntityType[];

/** Confidence by how the guess was made. */
export const LIST_CONFIDENCE = {
  orgWithSuffix: 0.85,
  orgShortForm: 0.75,
  orgHead: 0.7,
  address: 0.8,
  titledName: 0.8,
  fullName: 0.75,
  signature: 0.75,
  learnedName: 0.7,
  cuedName: 0.7,
  cuedUnknownName: 0.6,
  loneFirstName: 0.5,
} as const;

interface Token {
  text: string;
  lower: string;
  start: number;
  end: number;
  capitalised: boolean;
}

const TOKEN = /[\p{L}\p{N}](?:[\p{L}\p{N}]|['’-](?=[\p{L}\p{N}]))*|&/gu;
const CAPITALISED = /^\p{Lu}/u;
const NAME_LIKE = /^\p{Lu}[\p{L}'’-]*$/u;
const HOUSE_NUMBER = /^\d{1,4}[A-Za-z]?$/;
const POSSESSIVE = /^.{2,}['’]s$/i;

/**
 * Words that start sentences and phrases but are never part of a name or a
 * company: dropped from the front of a candidate ("Contact Halden Ltd").
 */
const STARTERS: ReadonlySet<string> = new Set([
  'a',
  'about',
  'after',
  'also',
  'an',
  'and',
  'any',
  'as',
  'ask',
  'at',
  'attn',
  'before',
  'but',
  'by',
  'call',
  'called',
  'cc',
  'contact',
  'dear',
  'did',
  'do',
  'does',
  'email',
  'for',
  'from',
  'fwd',
  'had',
  'has',
  'have',
  'he',
  'hello',
  'her',
  'hey',
  'hi',
  'his',
  'how',
  'i',
  'if',
  'in',
  'invoice',
  'is',
  'it',
  'its',
  'let',
  'many',
  'my',
  'no',
  'not',
  'of',
  'ok',
  'on',
  'or',
  'order',
  'our',
  'please',
  're',
  'regards',
  'she',
  'so',
  'thank',
  'thanks',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'to',
  'today',
  'tomorrow',
  'via',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'with',
  'yes',
  'yesterday',
  'you',
  'your',
]);

/**
 * A cue just before a capitalised word that makes it likely a person. The
 * strong ones ("Dear", "my name is") are enough on their own; the weak ones
 * ("from", "with") need the word to be in a name list as well.
 */
const STRONG_CUE =
  /(?:\b(?:hi|hello|hey|dear|my\s+name\s+is|i\s+am|i'm|this\s+is|spoke\s+(?:to|with)|speak\s+(?:to|with)|talk(?:ed)?\s+to|named|called)[\s,:]+)$/i;
const WEAK_CUE =
  /(?:\b(?:thanks|thank\s+you|cheers|ask|asked|cc|attn|from|with|by|for|via|tell|told|meet|met|colleague|manager|husband|wife|partner|son|daughter|mum|mom|dad|mother|father|brother|sister|friend|boss|customer|patient|client|tenant|employee|nurse|doctor|consultant|contact|emailed|messaged)[\s,:]+)$/i;
const CUE_WINDOW = 30;

/** A closing line; the line after it is usually the writer's name. */
const CLOSING =
  /^\s*(?:kind\s+|best\s+|warm\s+|many\s+)?(?:regards|thanks|thank\s+you|cheers|best|best\s+wishes|wishes|sincerely|yours\s+sincerely|yours\s+faithfully|faithfully|love|ta)[,!.]?\s*$/i;
const SIGNATURE = /^[ \t]*(\p{Lu}[\p{L}'’-]+(?:[ \t]+\p{Lu}[\p{L}'’-]+){0,2})[ \t]*[,.]?[ \t]*$/u;

/**
 * Words with their offsets. A possessive is cut off ("Priya Sharma's" →
 * "Priya Sharma"): otherwise one person would be two values, and get two
 * placeholders.
 */
function tokenise(text: string): Token[] {
  return allMatches(TOKEN, text).map((m) => {
    const word = POSSESSIVE.test(m[0]) ? m[0].slice(0, -2) : m[0];
    return {
      text: word,
      lower: word.toLowerCase(),
      start: m.index,
      end: m.index + word.length,
      capitalised: CAPITALISED.test(word),
    };
  });
}

/** True when only spaces or tabs separate two tokens: same line, nothing between. */
function joined(text: string, a: Token, b: Token): boolean {
  return /^[ \t]+$/.test(text.slice(a.end, b.start));
}

/** "I've", "We'll", "Don't": capitalised, apostrophised, never a name. */
const CONTRACTION = /['’](?:ve|ll|re|d|m|t)$/i;

/**
 * Two to four capitals ("NINO", "BG"): an acronym, not a name. One capital is
 * an initial ("J. Hart").
 */
function acronym(t: Token): boolean {
  return t.text.length >= 2 && t.text.length <= 4 && t.text === t.text.toUpperCase();
}

/** A capitalised word that could be part of a name. */
function nameLike(t: Token): boolean {
  return (
    NAME_LIKE.test(t.text) &&
    !CONTRACTION.test(t.text) &&
    !acronym(t) &&
    // A street word that is also a common surname (Green, Hill, Park) can be
    // part of a name; a numbered or cued street is still found as an address.
    (!STREET_SUFFIXES.has(t.lower) || isSurname(t.lower)) &&
    !ORG_SUFFIXES.has(t.lower) &&
    !ALLOWLIST.has(t.lower) &&
    !STARTERS.has(t.lower)
  );
}

/** True when `t` starts a sentence or a line, where every word is capitalised. */
function sentenceInitial(text: string, t: Token): boolean {
  // Walk back over spaces to the previous character, rather than slicing the
  // whole text before the word: that made tier C quadratic in text length.
  let i = t.start - 1;
  while (i >= 0 && (text[i] === ' ' || text[i] === '\t')) i--;
  if (i < 0) return true;
  return /[.!?:\r\n"“]/.test(text[i]);
}

/** A word that is never a name on its own. */
function neverAlone(lower: string): boolean {
  return (
    COMMON_WORDS.has(lower) ||
    PLACES.has(lower) ||
    ALLOWLIST.has(lower) ||
    STARTERS.has(lower) ||
    TITLES.has(lower)
  );
}

interface Found {
  spans: DetectedSpan[];
  /** Short forms of companies, learned from their full names. */
  orgForms: Map<string, number>;
  /** Parts of people's names, learned from full names. */
  nameParts: Set<string>;
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

function companies(text: string, tokens: Token[], found: Found): void {
  for (let i = 1; i < tokens.length; i++) {
    const suffix = tokens[i];
    if (!ORG_SUFFIXES.has(suffix.lower)) continue;
    // "Co" only capitalised: "co" is also a prefix and an abbreviation.
    if (suffix.lower === 'co' && suffix.text[0] !== 'C') continue;
    // "Acme Ltd" or "Acme, Inc.": the suffix follows a space, or a comma and a space.
    const gapBefore = text.slice(tokens[i - 1].end, suffix.start);
    if (!/^,?[ \t]+$/.test(gapBefore)) continue;
    let first = i;
    for (let j = i - 1; j >= 0 && i - j <= 6; j--) {
      const t = tokens[j];
      const ok =
        (t.capitalised && !STREET_SUFFIXES.has(t.lower)) ||
        /^\d+$/.test(t.text) ||
        ORG_CONNECTORS.has(t.lower);
      // Every word before the one next to the suffix must be on the same line.
      if (!ok || (j < i - 1 && !joined(text, t, tokens[j + 1]))) break;
      first = j;
    }
    // Drop leading sentence starters and connectors ("Contact Acme Ltd", "The Acme Ltd").
    while (
      first < i &&
      (STARTERS.has(tokens[first].lower) || ORG_CONNECTORS.has(tokens[first].lower))
    ) {
      first++;
    }
    if (first === i || !tokens.slice(first, i).some((t) => t.capitalised)) continue;
    // "Acme & Co": the name is "Acme", the "&" belongs to the suffix.
    let last = i;
    while (last > first && ORG_CONNECTORS.has(tokens[last - 1].lower)) last--;
    if (last === first) continue;
    const nameTokens = tokens.slice(first, last);
    const base = text.slice(nameTokens[0].start, nameTokens[nameTokens.length - 1].end);
    if (ALLOWLIST.has(base.toLowerCase()) || ALLOWLIST.has(nameTokens[0].lower)) continue;
    // "Ltd." and "Inc." are abbreviations; "LLP." is a sentence ending.
    const abbreviated = /^(?:ltd|inc|corp|co)$/.test(suffix.lower);
    const end = abbreviated && text[suffix.end] === '.' ? suffix.end + 1 : suffix.end;
    found.spans.push(span('ORG', nameTokens[0].start, end, LIST_CONFIDENCE.orgWithSuffix));
    if (base.length >= 3) found.orgForms.set(base, LIST_CONFIDENCE.orgShortForm);
    const head = nameTokens[0];
    if (
      nameTokens.length > 1 &&
      head.text.length >= 4 &&
      head.capitalised &&
      !neverAlone(head.lower) &&
      !isFirstName(head.lower)
    ) {
      if (!found.orgForms.has(head.text)) found.orgForms.set(head.text, LIST_CONFIDENCE.orgHead);
    }
  }
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/**
 * Words that introduce somebody's address. A bare "on" or "at" is not one:
 * "the bus stops on Station Road" names a street, not where anyone lives.
 */
const ADDRESS_CUE =
  /(?:\b(?:lives?|living|moved|based|staying|resides?|delivered|deliver|send\s+it)\s+(?:at|on|in|to)\s+|\baddress(?:\s+is)?\s*:?\s+)$/i;
const UNIT_WORDS: ReadonlySet<string> = new Set(['flat', 'apartment', 'apt', 'unit', 'suite']);

/**
 * Where a street name ends, starting at `from`: one to four capitalised words
 * and a street suffix, all on one line. Returns the suffix's index.
 */
function streetEnd(text: string, tokens: Token[], from: number): number | null {
  for (let k = from; k < tokens.length && k < from + 5; k++) {
    const t = tokens[k];
    if (k > from && !joined(text, tokens[k - 1], t)) return null;
    if (!t.capitalised) return null;
    if (k > from && STREET_SUFFIXES.has(t.lower)) return k;
  }
  return null;
}

/** Extend over up to two ", Town" segments after the street. */
function extendOverLocality(text: string, tokens: Token[], last: number): number {
  let end = tokens[last].end;
  let k = last + 1;
  for (let segment = 0; segment < 2 && k < tokens.length; segment++) {
    if (!/^,[ \t]*$/.test(text.slice(tokens[k - 1].end, tokens[k].start))) break;
    let m = k;
    while (
      m < tokens.length &&
      m < k + 3 &&
      NAME_LIKE.test(tokens[m].text) &&
      !STARTERS.has(tokens[m].lower) &&
      (m === k || joined(text, tokens[m - 1], tokens[m]))
    ) {
      m++;
    }
    if (m === k) break;
    end = tokens[m - 1].end;
    k = m;
  }
  return end;
}

function addresses(text: string, tokens: Token[], found: Found): void {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    let start: number | null = null;
    let suffixAt: number | null = null;
    if (HOUSE_NUMBER.test(t.text)) {
      suffixAt = streetEnd(text, tokens, i + 1);
      if (suffixAt !== null && !joined(text, t, tokens[i + 1])) suffixAt = null;
      if (suffixAt !== null) {
        start = t.start;
        // "Flat 3, 12 High Street": include the flat.
        const unit = tokens[i - 2];
        if (unit && UNIT_WORDS.has(unit.lower) && HOUSE_NUMBER.test(tokens[i - 1].text)) {
          start = unit.start;
        }
      }
    } else if (t.capitalised && ADDRESS_CUE.test(text.slice(Math.max(0, t.start - 25), t.start))) {
      suffixAt = streetEnd(text, tokens, i);
      if (suffixAt !== null) start = t.start;
    }
    if (start === null || suffixAt === null) continue;
    let end = tokens[suffixAt].end;
    if (text[end] === '.' && /^(?:st|rd|ave|dr|ln|ct|pl|sq|tce)$/.test(tokens[suffixAt].lower)) {
      end += 1;
    }
    end = Math.max(end, extendOverLocality(text, tokens, suffixAt));
    found.spans.push(span('ADDRESS', start, end, LIST_CONFIDENCE.address));
    i = suffixAt;
  }
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/**
 * The run of name-like words starting at `from`, joined on one line, at most
 * `max` long; an initial with a full stop ("J.") counts as a word. Returns the
 * index after the run.
 */
function nameRun(text: string, tokens: Token[], from: number, max: number): number {
  let k = from;
  while (k < tokens.length && k < from + max) {
    const t = tokens[k];
    if (!nameLike(t)) break;
    if (k > from) {
      const gap = text.slice(tokens[k - 1].end, t.start);
      const afterInitial = tokens[k - 1].text.length === 1 && /^\.[ \t]*$/.test(gap);
      if (!/^[ \t]+$/.test(gap) && !afterInitial) break;
    }
    k++;
  }
  return k;
}

/**
 * Whether a part of a full name is worth marking elsewhere in the text. A
 * part that is also a word ("Will", "Jordan") is learned too: it is matched
 * capitalised only, and once the text has named a Will Patel, a capitalised
 * "Will" in it is more likely him than the verb.
 */
function learnable(word: string): boolean {
  const lower = word.toLowerCase();
  return word.length >= 3 && !ALLOWLIST.has(lower) && !STARTERS.has(lower) && !TITLES.has(lower);
}

/**
 * Record a person's name, and learn its parts when one of them is in a name
 * list: "Dear Customer Services" is masked, but teaching "Customer" as a name
 * would mask every later "Customer" in the conversation.
 */
function addPerson(found: Found, tokens: Token[], from: number, to: number, confidence: number) {
  found.spans.push(span('PERSON', tokens[from].start, tokens[to - 1].end, confidence));
  if (to - from < 2) return;
  const run = tokens.slice(from, to);
  if (!run.some((t) => isFirstName(t.lower) || isSurname(t.lower))) return;
  for (const t of run) {
    if (learnable(t.text)) found.nameParts.add(t.text);
  }
}

function people(text: string, tokens: Token[], found: Found): void {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // A title: "Dr Okafor", "Mrs J. Hart". The title stays visible.
    if (TITLES.has(t.lower) && t.capitalised && i + 1 < tokens.length) {
      const gap = text.slice(t.end, tokens[i + 1].start);
      if (/^\.?[ \t]+$/.test(gap)) {
        const end = nameRun(text, tokens, i + 1, 3);
        if (end > i + 1) {
          addPerson(found, tokens, i + 1, end, LIST_CONFIDENCE.titledName);
          i = end - 1;
          continue;
        }
      }
    }
    if (!nameLike(t)) continue;

    // A full name: a known first name and one to three more name words.
    if (isFirstName(t.lower)) {
      const end = nameRun(text, tokens, i, 4);
      if (end - i >= 2) {
        const last = tokens[end - 1];
        // A street or company name next means these are its words, not a person's.
        const next = tokens[end];
        const partOfSomethingElse =
          next !== undefined &&
          joined(text, last, next) &&
          (STREET_SUFFIXES.has(next.lower) || ORG_SUFFIXES.has(next.lower));
        // A first name that is also a word ("Grace") needs a known surname, or
        // must be mid-sentence before a capitalised word that is not a word.
        const plausible =
          isSurname(last.lower) ||
          !neverAlone(t.lower) ||
          (!sentenceInitial(text, t) && !neverAlone(last.lower));
        if (!partOfSomethingElse && plausible) {
          addPerson(found, tokens, i, end, LIST_CONFIDENCE.fullName);
          i = end - 1;
          continue;
        }
      }
    }

    // A cue before it: "Dear Siobhan", "spoke to Priya".
    const before = text.slice(Math.max(0, t.start - CUE_WINDOW), t.start);
    const knownFirst = isFirstName(t.lower);
    if (!neverAlone(t.lower)) {
      const strong = STRONG_CUE.test(before);
      // A weak cue needs a first name: the surname list is full of words
      // ("from Sales", "with Rivers").
      if (strong || (knownFirst && WEAK_CUE.test(before))) {
        const end = nameRun(text, tokens, i, 3);
        const confidence =
          knownFirst || isSurname(t.lower)
            ? LIST_CONFIDENCE.cuedName
            : LIST_CONFIDENCE.cuedUnknownName;
        addPerson(found, tokens, i, end, confidence);
        i = end - 1;
        continue;
      }
    }

    // A first name alone. The weakest guess; the stoplists keep "May" and
    // "Reading" out of it.
    if (isFirstName(t.lower) && t.text.length >= 3 && !neverAlone(t.lower)) {
      const next = tokens[i + 1];
      const nextIsSuffix =
        next !== undefined &&
        joined(text, t, next) &&
        (STREET_SUFFIXES.has(next.lower) || ORG_SUFFIXES.has(next.lower));
      // (An acronym never gets here: nameLike() turned it away.)
      if (!nextIsSuffix) {
        found.spans.push(span('PERSON', t.start, t.end, LIST_CONFIDENCE.loneFirstName));
      }
    }
  }
}

/** The line after a closing ("Kind regards,") is the writer's name. */
function signatures(text: string, found: Found): void {
  let offset = 0;
  let previous: string | null = null;
  for (const raw of text.split('\n')) {
    // A CRLF line keeps its \r after the split; the name patterns end at $.
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (previous !== null && CLOSING.test(previous)) {
      const m = SIGNATURE.exec(line);
      if (m) {
        const start = offset + line.indexOf(m[1]);
        const name = m[1];
        const parts = name.split(/[ \t]+/);
        const lowers = parts.map((p) => p.toLowerCase());
        // "The Support Team" signs off too: a signature needs a word from a
        // name list, and nothing that cannot be part of a name.
        const isName =
          lowers.some((p) => isFirstName(p) || isSurname(p)) &&
          !lowers.some((p) => STARTERS.has(p) || ALLOWLIST.has(p) || p === 'team');
        if (isName) {
          found.spans.push(span('PERSON', start, start + name.length, LIST_CONFIDENCE.signature));
          if (parts.length > 1) {
            for (const p of parts) if (learnable(p)) found.nameParts.add(p);
          }
        }
      }
    }
    if (line.trim() !== '') previous = line;
    offset += raw.length + 1;
  }
}

/**
 * Mark every other occurrence of what was learned: short forms and name
 * parts. An occurrence inside something already found (the full name it was
 * learned from) adds nothing, so it is skipped. Each is marked `learned`: it
 * is personal only because of what was found elsewhere, so a refusal under
 * `block` places the full name, not this (t-1018).
 */
function learned(text: string, tokens: Token[], found: Found): void {
  const alreadyFound = coverage(found.spans);
  const push = (type: EntityType, start: number, end: number, confidence: number) => {
    if (!alreadyFound(start, end)) {
      found.spans.push({ ...span(type, start, end, confidence), learned: true });
    }
  };
  // One-word forms and name parts by token lookup, and every longer company
  // form in one pattern: a scan of the whole text per learned word made this
  // tier cost (names × text length).
  // Keyed with runs of whitespace collapsed, as the pattern matches them.
  const collapse = (form: string) => form.split(/\s+/).join(' ');
  const longForms = new Map<string, number>();
  for (const [form, confidence] of found.orgForms) {
    if (/\s/.test(form)) longForms.set(collapse(form), confidence);
  }
  for (const t of tokens) {
    const orgConfidence = found.orgForms.get(t.text);
    if (orgConfidence !== undefined) push('ORG', t.start, t.end, orgConfidence);
    else if (found.nameParts.has(t.text)) {
      push('PERSON', t.start, t.end, LIST_CONFIDENCE.learnedName);
    }
  }
  if (longForms.size === 0) return;
  const alternatives = [...longForms.keys()]
    .sort((a, b) => b.length - a.length)
    .map((form) => form.split(' ').map(escapeRegExp).join('\\s+'));
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}])`,
    'gu'
  );
  for (const m of allMatches(pattern, text)) {
    const confidence = longForms.get(collapse(m[0])) ?? LIST_CONFIDENCE.orgShortForm;
    push('ORG', m.index, m.index + m[0].length, confidence);
  }
}

/**
 * Find names, addresses and companies in `text`.
 *
 * Every word is examined, including words an earlier tier already covered,
 * because a prior span can cover part of a name that is not the one it
 * found: with the user's own "James" masked by tier B, skipping it would
 * leave a colleague's "James Patel" with nothing to start from, and "Patel"
 * would go out. Only a span that prior spans already cover entirely is
 * dropped afterwards, as one that adds nothing: every character of it is
 * masked anyway.
 */
export function findListSpans(
  text: string,
  priorSpans: readonly Pick<AttributedSpan, 'start' | 'end'>[] = []
): DetectedSpan[] {
  const tokens = tokenise(text);
  const found: Found = { spans: [], orgForms: new Map(), nameParts: new Set() };
  companies(text, tokens, found);
  addresses(text, tokens, found);
  people(text, tokens, found);
  signatures(text, found);
  learned(text, tokens, found);
  const covered = coverage(priorSpans);
  return found.spans.filter((s) => !covered(s.start, s.end));
}

/** Tier C as a detector adapter. */
export function listsDetector(): PrivacyDetector {
  return {
    id: LISTS_DETECTOR_ID,
    egress: 'in_process',
    entityTypes: LISTS_ENTITY_TYPES,
    languages: ['en'],
    // Synchronous work: the turn given to the event loop after it lets an
    // expired timeout abort the signal, so an overrun rejects (see text.ts).
    detect: async ({ text }, ctx) => {
      ctx.signal.throwIfAborted();
      const maybeYield = createYielder();
      const spans = findListSpans(text, ctx.priorSpans);
      await maybeYield();
      ctx.signal.throwIfAborted();
      return spans;
    },
  };
}
