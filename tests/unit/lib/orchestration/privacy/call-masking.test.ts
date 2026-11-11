/**
 * Tests: mapping and masking one provider call's messages (§127, t-992).
 *
 * The token strategy is the real core one, read through the registry as the
 * stage reads it. Only the app seam is stubbed.
 *
 * @see lib/orchestration/privacy/call-masking.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/app/privacy-adapters', () => ({
  initAppPrivacyAdapters: () => undefined,
}));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  mapMessageTexts,
  maskMessages,
  messagePieces,
  PIECE_SEPARATOR,
  withPlaceholderInstruction,
} from '@/lib/orchestration/privacy/call-masking';
import type { ContentPart, LlmMessage } from '@/lib/orchestration/llm/types';
import {
  __resetPrivacyAdaptersForTests,
  getPrivacyAdapters,
} from '@/lib/privacy/adapters/registry';
import type { TokenSession } from '@/lib/privacy/adapters/types';
import { PLACEHOLDER_INSTRUCTION } from '@/lib/privacy/pii/mask';

function session(): TokenSession {
  const strategy = getPrivacyAdapters().tokenStrategy;
  if (!strategy) throw new Error('core token strategy not installed');
  return strategy.createSession({ scopeId: 'test' });
}

beforeEach(() => {
  __resetPrivacyAdaptersForTests();
});

describe('mapMessageTexts', () => {
  const image: ContentPart = {
    type: 'image',
    source: { type: 'url', url: 'https://example.com/a.png' },
  };

  function input(): LlmMessage[] {
    return [
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'text', text: 'part' }, image] },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 't1', name: 'lookup', arguments: { who: 'bob', nested: { k: ['v'] } } }],
      },
    ];
  }

  it('applies fn to string content, text parts, and tool-call keys and values, leaving images alone', () => {
    const seen: string[] = [];
    const out = mapMessageTexts(input(), (t) => {
      seen.push(t);
      return t.toUpperCase();
    });

    expect(out[0].content).toBe('SYS');
    expect(out[1].content).toEqual([{ type: 'text', text: 'PART' }, image]);
    expect(out[2].toolCalls?.[0].arguments).toEqual({ WHO: 'BOB', NESTED: { K: ['V'] } });
    // Fixed visiting order: content first, then argument keys before values.
    expect(seen).toEqual(['sys', 'part', '', 'who', 'bob', 'nested', 'k', 'v']);
    expect(seen).not.toContain('https://example.com/a.png');
  });

  it('does not mutate its input', () => {
    const original = input();
    const snapshot = structuredClone(original);

    const out = mapMessageTexts(original, (t) => `x${t}`);

    expect(original).toEqual(snapshot);
    expect(out[0]).not.toBe(original[0]);
  });

  it('messagePieces lists the same texts in the same order', () => {
    expect(messagePieces(input())).toEqual(['sys', 'part', '', 'who', 'bob', 'nested', 'k', 'v']);
  });
});

describe('maskMessages', () => {
  it('splits a span that crosses the separator so both pieces are masked', () => {
    const messages: LlmMessage[] = [
      { role: 'user', content: 'call Anna' },
      { role: 'user', content: 'Smith now' },
    ];
    // One span over "Anna" + separator + "Smith", as the joined input finds it.
    const start = 'call '.length;
    const end = 'call Anna'.length + PIECE_SEPARATOR.length + 'Smith'.length;

    const { messages: out, changed } = maskMessages(
      messages,
      [{ type: 'PERSON', start, end }],
      session(),
      [],
      true
    );

    expect(changed).toBe(true);
    const [a, b] = out.map((m) => m.content as string);
    expect(a).toMatch(/^call \[PERSON_\d+\]$/);
    expect(b).toMatch(/^\[PERSON_\d+\] now$/);
    expect(a).not.toContain('Anna');
    expect(b).not.toContain('Smith');
  });

  it('numbers by first appearance across messages with one session, and reports unchanged text', () => {
    const messages: LlmMessage[] = [
      { role: 'user', content: 'plain' },
      { role: 'user', content: 'Ann and Bob' },
      { role: 'user', content: 'Bob' },
    ];
    const base = 'plain'.length + PIECE_SEPARATOR.length;
    const second = base + 'Ann and Bob'.length + PIECE_SEPARATOR.length;
    const { messages: out } = maskMessages(
      messages,
      [
        { type: 'PERSON', start: base, end: base + 3 },
        { type: 'PERSON', start: base + 8, end: base + 11 },
        { type: 'PERSON', start: second, end: second + 3 },
      ],
      session(),
      [],
      true
    );

    expect(out.map((m) => m.content)).toEqual(['plain', '[PERSON_1] and [PERSON_2]', '[PERSON_2]']);
  });

  it('reports changed: false and returns equal messages when nothing was found', () => {
    const messages: LlmMessage[] = [{ role: 'user', content: 'nothing here' }];
    const r = maskMessages(messages, [], session(), [], true);
    expect(r.changed).toBe(false);
    expect(r.messages).toEqual(messages);
  });
});

describe('withPlaceholderInstruction', () => {
  it('appends to the first prompt system message with a string body', () => {
    const out = withPlaceholderInstruction([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'hi' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].content).toBe(`Be brief.${PIECE_SEPARATOR}${PLACEHOLDER_INSTRUCTION}`);
  });

  it('uses the instruction alone when the prompt is empty', () => {
    const out = withPlaceholderInstruction([{ role: 'system', content: '' }]);
    expect(out[0].content).toBe(PLACEHOLDER_INSTRUCTION);
  });

  it('appends a text part when the system content is a part list', () => {
    const out = withPlaceholderInstruction([
      { role: 'system', content: [{ type: 'text', text: 'Be brief.' }] },
    ]);
    expect(out[0].content).toEqual([
      { type: 'text', text: 'Be brief.' },
      { type: 'text', text: PLACEHOLDER_INSTRUCTION },
    ]);
  });

  it('skips a turn instruction and uses the prompt after it', () => {
    const out = withPlaceholderInstruction([
      { role: 'system', content: 'turn', turnInstruction: true },
      { role: 'system', content: 'prompt' },
    ]);
    expect(out[0].content).toBe('turn');
    expect(out[1].content).toBe(`prompt${PIECE_SEPARATOR}${PLACEHOLDER_INSTRUCTION}`);
  });

  it('prepends its own system message when there is no prompt, and does not mutate input', () => {
    const input: LlmMessage[] = [
      { role: 'system', content: 'turn', turnInstruction: true },
      { role: 'user', content: 'hi' },
    ];
    const out = withPlaceholderInstruction(input);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ role: 'system', content: PLACEHOLDER_INSTRUCTION });
    expect(input).toHaveLength(2);
    expect(input[0].content).toBe('turn');
  });
});
