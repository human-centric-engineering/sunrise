/**
 * Unit tests for parse-structured — the LLM-as-judge JSON parse helpers.
 *
 * Covers:
 *  - tryParseJson tolerates code-fenced output
 *  - tryParseJson returns null when validate rejects every candidate
 *  - stripCodeFence strips ```json ... ``` and ``` ... ``` wrappers
 *
 * (The structured-completion runner these helpers once shipped alongside now
 * lives at `@/lib/orchestration/llm/structured-completion`, tested separately.)
 */

import { describe, it, expect } from 'vitest';

const { tryParseJson, stripCodeFence } =
  await import('@/lib/orchestration/evaluations/parse-structured');

describe('tryParseJson', () => {
  it('returns null when validate rejects every candidate', () => {
    const result = tryParseJson<{ ok: true }>('{"ok":false}', (p) => {
      if (p && typeof p === 'object' && (p as { ok?: unknown }).ok === true) return { ok: true };
      return null;
    });
    expect(result).toBeNull();
  });

  it('strips a ```json ... ``` fence before parsing', () => {
    const result = tryParseJson<{ ok: true }>('```json\n{"ok":true}\n```', (p) => {
      if (p && typeof p === 'object' && (p as { ok?: unknown }).ok === true) return { ok: true };
      return null;
    });
    expect(result).toEqual({ ok: true });
  });

  it('returns null on completely unparseable input', () => {
    const result = tryParseJson<{ ok: true }>('not json at all', () => null);
    expect(result).toBeNull();
  });
});

describe('stripCodeFence', () => {
  it('strips ```json wrappers', () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('strips bare ``` wrappers', () => {
    expect(stripCodeFence('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('returns input unchanged when no fence is present', () => {
    expect(stripCodeFence('{"a":1}')).toBe('{"a":1}');
  });
});
