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
  CallRestorer,
  mapMessageTexts,
  maskMessages,
  messagePieces,
  messagesHoldingSpans,
  PIECE_SEPARATOR,
  withPlaceholderInstruction,
} from '@/lib/orchestration/privacy/call-masking';
import type {
  ContentPart,
  LlmMessage,
  LlmResponse,
  StreamChunk,
} from '@/lib/orchestration/llm/types';
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

describe('messagesHoldingSpans (t-1017)', () => {
  const sent: LlmMessage[] = [
    { role: 'system', content: 'abc' },
    // An image only: no pieces, and still a position.
    {
      role: 'user',
      content: [{ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'x' } }],
    },
    { role: 'user', content: 'hello Bob' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 't', name: 'f', arguments: { k: 'v' } }],
    },
  ];
  // Joined: 'abc' at 0, 'hello Bob' at 5, '' at 16, 'k' at 18, 'v' at 21.
  const at = (text: string, from = 0): { start: number; end: number } => {
    const joined = messagePieces(sent).join(PIECE_SEPARATOR);
    const start = joined.indexOf(text, from);
    return { start, end: start + text.length };
  };

  it('names the message each span is in, by its position', () => {
    expect(messagesHoldingSpans(sent, [{ type: 'PERSON', ...at('Bob') }])).toEqual([2]);
    expect(messagesHoldingSpans(sent, [{ type: 'PERSON', ...at('v', 20) }])).toEqual([3]);
  });

  it('names both messages a span runs across, each once, in order', () => {
    const across = { type: 'PERSON', start: at('c').start, end: at('hello').end };
    expect(messagesHoldingSpans(sent, [across, { type: 'PERSON', ...at('Bob') }])).toEqual([0, 2]);
  });

  it('names nothing when nothing was found', () => {
    expect(messagesHoldingSpans(sent, [])).toEqual([]);
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

describe('maskMessages and an own __proto__ key', () => {
  it('keeps the key, as JSON parsing gives it, rather than turning it into a prototype', () => {
    const args = JSON.parse('{"__proto__": {"email": "jo@example.com"}, "x": 1}') as Record<
      string,
      unknown
    >;
    const messages: LlmMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 't', name: 'n', arguments: args }] },
    ];
    const out = mapMessageTexts(messages, (t) => t);
    const masked = out[0].toolCalls?.[0].arguments ?? {};
    expect(Object.keys(masked)).toEqual(['__proto__', 'x']);
    expect(Object.getPrototypeOf(masked)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(masked, '__proto__')?.value).toEqual({
      email: 'jo@example.com',
    });
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

describe('CallRestorer', () => {
  /** A session that has issued [PERSON_1] for Priya Sharma. */
  function issued(): TokenSession {
    const sess = session();
    sess.placeholderFor('PERSON', 'Priya Sharma');
    return sess;
  }

  function response(content: string): LlmResponse {
    return {
      content,
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'm',
      finishReason: 'stop',
    };
  }

  async function run(restorer: CallRestorer, ...items: StreamChunk[]): Promise<StreamChunk[]> {
    async function* source() {
      for (const item of items) yield item;
    }
    const out: StreamChunk[] = [];
    for await (const c of restorer.stream(source())) out.push(c);
    return out;
  }

  const done: StreamChunk = {
    type: 'done',
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: 'stop',
  };

  it('hands a structured reply with nothing to restore back byte for byte, not re-serialised', () => {
    const restorer = new CallRestorer(issued(), [], true, () => undefined);
    const text = '{ "a" : 1,\n  "b": [ 2 ] }';
    expect(restorer.response(response(text)).content).toBe(text);
  });

  it('restores a structured reply that does not parse as text', () => {
    const restorer = new CallRestorer(issued(), [], true, () => undefined);
    expect(restorer.response(response('Dear [PERSON_1], {oops')).content).toBe(
      'Dear Priya Sharma, {oops'
    );
  });

  it('reports once, with what it restored and what it could not', () => {
    const report = vi.fn();
    const restorer = new CallRestorer(issued(), [], false, report);
    restorer.response(response('[PERSON_1] and [PERSON_7]'));
    restorer.response(response('[PERSON_1]'));
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith({ restored: 1, unresolved: 1 });
  });

  it('releases reasoning it held back before the text that follows it, in order', async () => {
    const out = await run(
      new CallRestorer(issued(), [], false, () => undefined),
      { type: 'reasoning', text: 'Thinking about [PERS' },
      { type: 'text', content: 'Hello' },
      done
    );
    // The held "[PERS" can no longer become a placeholder once text starts.
    expect(out).toEqual([
      { type: 'reasoning', text: 'Thinking about ' },
      { type: 'reasoning', text: '[PERS' },
      { type: 'text', content: 'Hello' },
      done,
    ]);
  });

  it('releases text it held back before reasoning that follows it, in order', async () => {
    const out = await run(
      new CallRestorer(issued(), [], false, () => undefined),
      { type: 'text', content: 'Hi PERSON_1' },
      { type: 'reasoning', text: 'more thought' },
      done
    );
    expect(out).toEqual([
      { type: 'text', content: 'Hi ' },
      { type: 'text', content: 'Priya Sharma' },
      { type: 'reasoning', text: 'more thought' },
      done,
    ]);
  });

  // The bare form: the stream holds it back, as more digits could follow.
  // (A lone "[" is never consumed: it may be the model's own Markdown.)
  it('releases held text and held reasoning before a done chunk, text first', async () => {
    const out = await run(
      new CallRestorer(issued(), [], false, () => undefined),
      { type: 'reasoning', text: 'see PERSON_1' },
      { type: 'text', content: 'for PERSON_1' },
      done
    );
    expect(out.map((c) => c.type)).toEqual(['reasoning', 'reasoning', 'text', 'text', 'done']);
    expect(out.flatMap((c) => (c.type === 'text' ? [c.content] : [])).join('')).toBe(
      'for Priya Sharma'
    );
    expect(out.flatMap((c) => (c.type === 'reasoning' ? [c.text] : [])).join('')).toBe(
      'see Priya Sharma'
    );
  });

  it('releases held reasoning when a stream ends with no done chunk', async () => {
    const out = await run(new CallRestorer(issued(), [], false, () => undefined), {
      type: 'reasoning',
      text: 'about PERSON_1',
    });
    expect(out.flatMap((c) => (c.type === 'reasoning' ? [c.text] : [])).join('')).toBe(
      'about Priya Sharma'
    );
  });

  it('keeps arguments a restore turned into something other than an object as they were', () => {
    const restorer = new CallRestorer(issued(), [], false, () => undefined);
    const out = restorer.response({
      ...response(''),
      toolCalls: [{ id: 'c', name: 'n', arguments: { who: '[PERSON_1]' } }],
    });
    expect(out.toolCalls?.[0].arguments).toEqual({ who: 'Priya Sharma' });
  });
});
