import { describe, it, expect } from 'vitest';
import { maybeParseJson } from '@/lib/orchestration/engine/maybe-parse-json';

describe('maybeParseJson', () => {
  it('passes objects through unchanged', () => {
    const obj = { a: 1 };
    // Reference equality matters — callers shouldn't pay a serialization
    // round-trip when the input is already structured.
    expect(maybeParseJson(obj)).toBe(obj);
  });

  it('passes arrays through unchanged', () => {
    const arr = [1, 2, 3];
    expect(maybeParseJson(arr)).toBe(arr);
  });

  it('passes primitives through unchanged', () => {
    expect(maybeParseJson(42)).toBe(42);
    expect(maybeParseJson(true)).toBe(true);
    expect(maybeParseJson(null)).toBe(null);
    expect(maybeParseJson(undefined)).toBe(undefined);
  });

  it('parses a JSON object string', () => {
    expect(maybeParseJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses a JSON array string', () => {
    expect(maybeParseJson('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('tolerates leading/trailing whitespace around the JSON token', () => {
    expect(maybeParseJson('   {"a":1}   ')).toEqual({ a: 1 });
  });

  it('returns the original string when JSON.parse throws', () => {
    // Falls back so downstream Zod produces the actionable
    // "expected object, received string" error instead of a SyntaxError.
    expect(maybeParseJson('{this is not valid json')).toBe('{this is not valid json');
  });

  it('passes strings that do not start with { or [ through unchanged', () => {
    // A JSON-encoded primitive like `'"hello"'` would otherwise be
    // silently unwrapped to a plain string, which is rarely what
    // structured-shape consumers want.
    expect(maybeParseJson('"hello"')).toBe('"hello"');
    expect(maybeParseJson('plain text')).toBe('plain text');
    expect(maybeParseJson('42')).toBe('42');
  });

  it('passes the empty string through', () => {
    expect(maybeParseJson('')).toBe('');
  });
});
