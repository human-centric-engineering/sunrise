/**
 * Shared core for the "bytes must not reach the database" test guards.
 *
 * ## What this is guarding
 *
 * Chat attachments (`{ name, mediaType, data }`, where `data` is base64) and
 * transcription audio are deliberately **transient**: they go to the model
 * provider and are then dropped. What gets persisted is the user's text.
 * `AiMessage` has no attachment column — see
 * `prisma/schema/orchestration-conversations.prisma`.
 *
 * Nothing enforces that. `metadata` is `Json?`, so it accepts anything: no
 * type error, no Prisma error, no failing test. The invariant holds only
 * because `persistMessage` builds its `data` from a fixed set of fields. One
 * reasonable-sounding line — "keep the attachment in metadata so we can replay
 * the conversation" — breaks it silently, and the consequences are real:
 * `lib/privacy/export-sources.ts` exports conversations as
 * `include: { messages: … }` with no field selection, so persisted bytes ship
 * in every Article 15 subject-access response as an unlabelled blob, and
 * `eraseUser()` has no idea they are there. Conversation history is also
 * re-read on every turn, so one persisted PDF slows every later message in the
 * thread for good.
 *
 * This helper is the tripwire for an invariant the type system cannot express.
 *
 * ## What it detects, and what it deliberately does not
 *
 *   1. Binary types — `Buffer`, `Uint8Array`, `ArrayBuffer`, `Blob`.
 *   2. Keys that name a payload (`attachments`, `audioData`, …). Per-guard.
 *   3. Values whose first bytes identify a real file format, after undoing
 *      the wrappers a payload picks up in transit.
 *
 * It does **not** try to answer "is this string base64?" in general. An
 * earlier version did, with a length + alphabet rule, and it failed in both
 * directions across two review rounds: it missed `data:` URIs, and once that
 * was fixed it flagged ordinary prose (strip the spaces from a long enough
 * sentence and what is left is pure base64 alphabet). The rule was removed
 * rather than tuned again.
 *
 * That is a deliberate trade, not an oversight. What actually gets persisted
 * by accident is a PNG, PDF, JPEG, GIF, WEBP, WAV, MP3, OGG or WebM — every
 * one of which announces itself in its first few bytes. Base64 of something
 * *unrecognisable* is not an attachment shape, while long punctuation-free
 * text is an entirely ordinary chat message. So the heuristic was adding
 * failure modes without adding detection.
 *
 * @see tests/helpers/no-attachment-persistence.ts
 * @see tests/helpers/no-audio-persistence.ts
 */

import { expect } from 'vitest';

/** Bounded recursion, so a circular reference cannot hang the runner. */
const MAX_DEPTH = 8;

/**
 * Undo the wrappers a base64 payload picks up in transit, so a magic-byte
 * prefix is recognisable whichever layer produced the string. Both cases occur
 * in this codebase's own path:
 *
 *   - `data:<mime>;base64,` — what `FileReader.readAsDataURL` returns.
 *     `lib/hooks/use-attachments.ts` strips it on the way in;
 *     `lib/orchestration/llm/openai-compatible.ts` re-adds it on the way out.
 *     Without this, persisting either un-stripped value would evade the guard,
 *     because `:` `;` `,` are outside the base64 alphabet.
 *   - base64url `-` / `_` — URL-safe variants of `+` / `/`. `/9j/` (JPEG)
 *     contains `/`, so this matters for prefix matching.
 *
 * Note there is deliberately no whitespace stripping. It existed only to serve
 * the removed length rule, and it was what turned prose into a false positive.
 * MIME base64 wraps at 76 characters and the longest prefix here is 11, so a
 * wrapped payload's prefix is always intact on the first line regardless.
 */
function normalise(value: string): string {
  return value
    .replace(/^data:[^,]{0,120},/i, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
}

export interface Finding {
  callIndex: number;
  argIndex: number;
  path: string;
  reason: string;
}

export interface GuardSpec {
  /** Lower-cased key names that name a payload outright. */
  suspectKeys: ReadonlySet<string>;
  /** Base64 renderings of each accepted format's magic bytes. */
  magicPrefixes: readonly string[];
  /** Wording for a key hit, e.g. "attachment-shaped key". */
  keyReason: string;
  /** Sentence appended to the assertion failure. */
  failureHint: string;
}

function isBinary(value: unknown): boolean {
  if (value instanceof Uint8Array) return true;
  if (value instanceof ArrayBuffer) return true;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return true;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return true;
  return false;
}

function magicPrefixHit(raw: string, prefixes: readonly string[]): string | null {
  const value = normalise(raw);
  for (const prefix of prefixes) {
    if (value.startsWith(prefix)) {
      return `base64 payload with ${prefix} magic-byte prefix`;
    }
  }
  return null;
}

function walk(
  value: unknown,
  path: string,
  depth: number,
  findings: Finding[],
  spec: GuardSpec
): void {
  if (depth > MAX_DEPTH) return;
  if (value === null || value === undefined) return;

  if (isBinary(value)) {
    findings.push({ callIndex: -1, argIndex: -1, path, reason: 'binary value' });
    return;
  }

  if (typeof value === 'string') {
    const reason = magicPrefixHit(value, spec.magicPrefixes);
    if (reason) findings.push({ callIndex: -1, argIndex: -1, path, reason });
    return;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      walk(value[i], `${path}[${i}]`, depth + 1, findings, spec);
    }
    return;
  }

  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (spec.suspectKeys.has(key.toLowerCase())) {
        findings.push({
          callIndex: -1,
          argIndex: -1,
          path: `${path}.${key}`,
          reason: `${spec.keyReason} "${key}"`,
        });
      }
      walk(child, `${path}.${key}`, depth + 1, findings, spec);
    }
  }
}

/**
 * Assert that no recorded call on `mock` carries file bytes. Shared by the
 * attachment and audio guards; call one of those rather than this directly.
 */
export function assertNoBinaryPersistence(
  mock: { mock: { calls: unknown[][] } },
  label: string,
  spec: GuardSpec
): void {
  const calls = mock.mock.calls;
  const findings: Finding[] = [];

  for (let callIndex = 0; callIndex < calls.length; callIndex++) {
    const args = calls[callIndex];
    if (!args) continue;
    for (let argIndex = 0; argIndex < args.length; argIndex++) {
      const local: Finding[] = [];
      walk(args[argIndex], `arg${argIndex}`, 0, local, spec);
      for (const f of local) findings.push({ ...f, callIndex, argIndex });
    }
  }

  if (findings.length > 0) {
    const detail = findings.map((f) => `  - call ${f.callIndex} ${f.path}: ${f.reason}`).join('\n');
    expect.fail(`${label} ${spec.failureHint}. Findings:\n${detail}`);
  }
}
