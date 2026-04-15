/**
 * Unit tests for parseSseBlock — the shared SSE frame parser.
 *
 * Covers:
 *  - Valid block returns typed { type, data }
 *  - Comment/keepalive lines (starting with `:`) are skipped
 *  - Missing event type returns null
 *  - Missing data lines returns null
 *  - Malformed JSON in data returns null (catch branch)
 *  - Multi-line data concatenated with \n before JSON.parse
 */

import { describe, it, expect } from 'vitest';
import { parseSseBlock } from '@/lib/api/sse-parser';

describe('parseSseBlock', () => {
  it('parses a valid event block into { type, data }', () => {
    const block = 'event: message\ndata: {"foo":"bar"}';
    const result = parseSseBlock(block);
    expect(result).toEqual({ type: 'message', data: { foo: 'bar' } });
  });

  it('skips comment/keepalive lines starting with ":" and still parses the block', () => {
    const block = ':keepalive\nevent: ping\ndata: {}';
    const result = parseSseBlock(block);
    expect(result).toEqual({ type: 'ping', data: {} });
  });

  it('returns null when block has data but no event type', () => {
    const block = 'data: {"foo":"bar"}';
    expect(parseSseBlock(block)).toBeNull();
  });

  it('returns null when block has event but no data lines', () => {
    const block = 'event: message';
    expect(parseSseBlock(block)).toBeNull();
  });

  it('returns null when data payload is malformed JSON', () => {
    const block = 'event: message\ndata: {not valid json}';
    expect(parseSseBlock(block)).toBeNull();
  });

  it('concatenates multiple data lines with \\n before parsing', () => {
    const block = 'event: x\ndata: {"a":\ndata: 1}';
    const result = parseSseBlock(block);
    expect(result).toEqual({ type: 'x', data: { a: 1 } });
  });
});
