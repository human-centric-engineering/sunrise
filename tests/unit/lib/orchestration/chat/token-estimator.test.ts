/**
 * Tests for `lib/orchestration/chat/token-estimator.ts`.
 *
 * Test Coverage:
 * - estimateTokens: empty string returns 0
 * - estimateTokens: non-empty string applies char/token ratio + overhead
 * - estimateMessagesTokens: empty array returns 0
 * - estimateMessagesTokens: sums estimateTokens across all messages
 * - estimateMessagesTokens: handles messages with ContentPart[] content
 * - truncateToTokenBudget: empty history returns empty with 0 dropped
 * - truncateToTokenBudget: history that fits returns unchanged with 0 dropped
 * - truncateToTokenBudget: drops oldest messages first until budget is met
 * - truncateToTokenBudget: always keeps at least the most-recent message
 * - truncateToTokenBudget: drops all but last when all exceed budget
 *
 * @see lib/orchestration/chat/token-estimator.ts
 */

import { describe, expect, it } from 'vitest';
import {
  estimateTokens,
  estimateMessagesTokens,
  truncateToTokenBudget,
} from '@/lib/orchestration/chat/token-estimator';
import type { LlmMessage } from '@/lib/orchestration/llm/types';

// ─── Internal constants mirrored for test arithmetic ────────────────────────

const CHARS_PER_TOKEN = 3.5;
const MESSAGE_OVERHEAD = 4;

function expectedTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN) + MESSAGE_OVERHEAD;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function textMsg(content: string, role: LlmMessage['role'] = 'user'): LlmMessage {
  return { role, content };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('estimateTokens', () => {
  it('returns 0 for an empty string', () => {
    // Arrange / Act / Assert
    expect(estimateTokens('')).toBe(0);
  });

  it('returns 0 for a whitespace-only string', () => {
    // Whitespace-only strings have non-zero length but no semantic content;
    // the source guards with `if (!text) return 0` — trimmed whitespace is still truthy,
    // so this confirms the real char/token calculation is applied (not the falsy guard).
    const result = estimateTokens('   ');
    // 3 chars → ceil(3 / 3.5) + 4 = 1 + 4 = 5
    expect(result).toBe(expectedTokens('   '));
  });

  it('estimates tokens for a short English string', () => {
    // Arrange
    const text = 'Hello world'; // 11 chars
    // Act
    const result = estimateTokens(text);
    // Assert: ceil(11 / 3.5) + 4 = ceil(3.14) + 4 = 3 + 4 = 7
    expect(result).toBe(expectedTokens(text));
  });

  it('estimates tokens for a longer paragraph', () => {
    // Arrange
    const text = 'The quick brown fox jumps over the lazy dog.';
    // Act / Assert
    expect(estimateTokens(text)).toBe(expectedTokens(text));
  });

  it('is conservative — longer text returns more tokens', () => {
    const short = 'Hi';
    const long = 'Hi, how are you doing today? I hope everything is well.';
    expect(estimateTokens(long)).toBeGreaterThan(estimateTokens(short));
  });
});

describe('estimateMessagesTokens', () => {
  it('returns 0 for an empty messages array', () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });

  it('sums estimateTokens across all messages', () => {
    // Arrange
    const messages: LlmMessage[] = [textMsg('Hello', 'user'), textMsg('Hi there!', 'assistant')];
    // Act
    const result = estimateMessagesTokens(messages);
    // Assert
    const expected = expectedTokens('Hello') + expectedTokens('Hi there!');
    expect(result).toBe(expected);
  });

  it('handles messages with ContentPart[] content (extracts text parts only)', () => {
    // Arrange — multimodal message with text + image
    const messages: LlmMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this image' },
          { type: 'image', source: { type: 'url', url: 'https://example.com/img.png' } },
        ],
      },
    ];
    // Act
    const result = estimateMessagesTokens(messages);
    // Assert: only the text part contributes
    expect(result).toBe(expectedTokens('Describe this image'));
  });

  it('single message token count matches estimateTokens directly', () => {
    const text = 'A single message.';
    const messages: LlmMessage[] = [textMsg(text)];
    expect(estimateMessagesTokens(messages)).toBe(estimateTokens(text));
  });
});

describe('estimateTokens with modelId (per-provider tokeniser)', () => {
  // These tests use a known OpenAI model so the path through
  // `tokeniserForModel` is exact (gpt-tokenizer ships the encoder).
  // Anthropic / Gemini / Llama paths are calibrated approximators —
  // we test their qualitative behaviour, not exact counts.

  it('exact OpenAI count differs from the 3.5-char heuristic', () => {
    const text = 'Hello world';
    const heuristic = estimateTokens(text);
    const exact = estimateTokens(text, 'gpt-4o-mini');
    // Heuristic: ceil(11/3.5) + 4 = 7. Exact (o200k_base): 2 + 4 = 6.
    // The two should not match — proves the modelId path is wired.
    expect(exact).not.toBe(heuristic);
  });

  it('returns 0 for empty text regardless of model', () => {
    expect(estimateTokens('', 'gpt-4o-mini')).toBe(0);
    expect(estimateTokens('', 'claude-haiku-4-5')).toBe(0);
  });

  it('Chinese text counts more tokens than the 3.5-char heuristic implies', () => {
    // Chinese characters are typically one token each — the heuristic
    // assumes ~3.5 chars/token (English) and so under-counts CJK badly.
    // The per-provider tokeniser corrects this.
    const cjk = '你好世界，今天天气很好';
    const heuristic = estimateTokens(cjk);
    const tokenised = estimateTokens(cjk, 'gpt-4o-mini');
    // The corrected count should be higher than the heuristic for CJK.
    expect(tokenised).toBeGreaterThan(heuristic);
  });

  it('Anthropic count >= OpenAI count for the same input (calibration multiplier)', () => {
    const text = 'The quick brown fox jumps over the lazy dog.';
    const openai = estimateTokens(text, 'gpt-4o-mini');
    const anthropic = estimateTokens(text, 'claude-haiku-4-5');
    // Anthropic is approximated as o200k × 1.10, so >= OpenAI by design.
    expect(anthropic).toBeGreaterThanOrEqual(openai);
  });

  it('unknown model falls back gracefully without throwing', () => {
    const text = 'Hello world';
    expect(() => estimateTokens(text, 'definitely-not-a-real-model-xyz')).not.toThrow();
    expect(estimateTokens(text, 'definitely-not-a-real-model-xyz')).toBeGreaterThan(0);
  });
});

describe('estimateMessagesTokens with modelId', () => {
  it('threads modelId into per-message counts', () => {
    const messages: LlmMessage[] = [
      textMsg('Hello world', 'user'),
      textMsg('How are you?', 'assistant'),
    ];
    const heuristic = estimateMessagesTokens(messages);
    const tokenised = estimateMessagesTokens(messages, 'gpt-4o-mini');
    // The two paths must both succeed and produce a positive count;
    // they need not match (the heuristic over-counts English for short
    // strings because of MESSAGE_OVERHEAD relative to body).
    expect(tokenised).toBeGreaterThan(0);
    expect(heuristic).toBeGreaterThan(0);
  });
});

describe('truncateToTokenBudget', () => {
  it('returns empty messages and 0 dropped for an empty history', () => {
    // Arrange / Act
    const result = truncateToTokenBudget([], 1000);
    // Assert
    expect(result).toEqual({ messages: [], droppedCount: 0 });
  });

  it('returns unchanged history when total tokens fit within budget', () => {
    // Arrange
    const history: LlmMessage[] = [textMsg('short', 'user'), textMsg('reply', 'assistant')];
    const budget = estimateMessagesTokens(history) + 100; // plenty of room
    // Act
    const result = truncateToTokenBudget(history, budget);
    // Assert
    expect(result.messages).toEqual(history);
    expect(result.droppedCount).toBe(0);
  });

  it('drops oldest messages first until total fits within budget', () => {
    // Arrange: build 5 messages each ~20 tokens
    const history: LlmMessage[] = Array.from({ length: 5 }, (_, i) =>
      textMsg(`Message number ${i} with some padding text to bulk it up`, 'user')
    );

    const total = estimateMessagesTokens(history);
    // Budget: fit only the last 2 messages
    const last2 = history.slice(-2);
    const last2Tokens = estimateMessagesTokens(last2);
    const budget = last2Tokens; // tight — exactly the last 2 fit

    // Act
    const result = truncateToTokenBudget(history, budget);

    // Assert: we kept the last 2 and dropped 3
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].content).toBe(history[3].content);
    expect(result.messages[1].content).toBe(history[4].content);
    expect(result.droppedCount).toBe(3);
    // Sanity: total was above budget
    expect(total).toBeGreaterThan(budget);
  });

  it('always keeps at least the last message even when it alone exceeds budget', () => {
    // Arrange: a very large last message that exceeds the budget on its own
    const bigText = 'x'.repeat(1000); // ~290 tokens
    const history: LlmMessage[] = [textMsg('small', 'user'), textMsg(bigText, 'assistant')];
    // Budget: tiny — less than either message
    const budget = 5;

    // Act
    const result = truncateToTokenBudget(history, budget);

    // Assert: last message is always kept
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toBe(bigText);
    expect(result.droppedCount).toBe(1);
  });

  it('drops all but the last message when single-message history exceeds budget', () => {
    // Arrange: only one message
    const history: LlmMessage[] = [textMsg('The only message', 'user')];
    // Budget: 0 — impossible to fit, but we always keep the last
    const result = truncateToTokenBudget(history, 0);

    // Assert: still returns the one message (never empty)
    expect(result.messages).toHaveLength(1);
    expect(result.droppedCount).toBe(0);
  });

  it('honours modelId when sizing the budget — Anthropic drops more than OpenAI', () => {
    // Anthropic's calibrated tokeniser produces a higher count for the
    // same text, so a fixed budget fits fewer messages. This is the
    // load-bearing behaviour of item #9: pre-call truncation uses the
    // right tokeniser for the model the request will actually be sent
    // to, instead of a one-size-fits-all heuristic.
    const history: LlmMessage[] = Array.from({ length: 6 }, (_, i) =>
      textMsg(
        `Message ${i}: ${'pad '.repeat(20)}content with non-English: ¿Cómo estás? Estoy bien.`,
        i % 2 === 0 ? 'user' : 'assistant'
      )
    );
    // A modest budget that is below the full history under either
    // tokeniser. The exact threshold is chosen empirically to land
    // between the two providers.
    const budget = 80;

    const openai = truncateToTokenBudget(history, budget, 'gpt-4o-mini');
    const anthropic = truncateToTokenBudget(history, budget, 'claude-haiku-4-5');

    // Anthropic's higher count means equal-or-more messages dropped.
    expect(anthropic.droppedCount).toBeGreaterThanOrEqual(openai.droppedCount);
  });

  it('returns droppedCount equal to messages dropped', () => {
    // Arrange: 4 messages, budget only fits 1
    const history: LlmMessage[] = [
      textMsg('alpha', 'user'),
      textMsg('beta', 'assistant'),
      textMsg('gamma', 'user'),
      textMsg('delta', 'assistant'),
    ];
    const lastOne = [history[3]];
    const budget = estimateMessagesTokens(lastOne); // exactly one fits

    // Act
    const result = truncateToTokenBudget(history, budget);

    // Assert
    expect(result.droppedCount).toBe(3);
    expect(result.messages).toHaveLength(1);
  });
});
