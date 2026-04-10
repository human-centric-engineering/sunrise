/**
 * Tests for buildMessages — the pure LlmMessage[] composer used by the
 * streaming chat handler.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { logger } = await import('@/lib/logging');
const { buildMessages } = await import('@/lib/orchestration/chat/message-builder');
const { MAX_HISTORY_MESSAGES } = await import('@/lib/orchestration/chat/types');

const loggerWarn = logger.warn as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildMessages', () => {
  it('places system instructions first and new user message last', () => {
    const messages = buildMessages({
      systemInstructions: 'You are a helpful agent.',
      contextBlock: null,
      history: [],
      newUserMessage: 'Hello',
    });

    expect(messages[0]).toEqual({ role: 'system', content: 'You are a helpful agent.' });
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('appends the context block as a second system message when present', () => {
    const messages = buildMessages({
      systemInstructions: 'System.',
      contextBlock: '=== LOCKED CONTEXT ===\nfoo\n=== END LOCKED CONTEXT ===',
      history: [],
      newUserMessage: 'Hi',
    });

    expect(messages[0].role).toBe('system');
    expect(messages[1]).toEqual({
      role: 'system',
      content: '=== LOCKED CONTEXT ===\nfoo\n=== END LOCKED CONTEXT ===',
    });
    expect(messages[2]).toEqual({ role: 'user', content: 'Hi' });
  });

  it('omits the context block entirely when null', () => {
    const messages = buildMessages({
      systemInstructions: 'System.',
      contextBlock: null,
      history: [],
      newUserMessage: 'Hi',
    });

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
  });

  it('includes history verbatim when under the cap', () => {
    const history = Array.from({ length: 5 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `msg ${i}`,
    }));

    const messages = buildMessages({
      systemInstructions: 'sys',
      contextBlock: null,
      history,
      newUserMessage: 'new',
    });

    // 1 system + 5 history + 1 user
    expect(messages).toHaveLength(7);
    expect(messages.slice(1, 6).map((m) => m.content)).toEqual([
      'msg 0',
      'msg 1',
      'msg 2',
      'msg 3',
      'msg 4',
    ]);
    // No truncation marker
    expect(messages.find((m) => m.content.includes('older messages omitted'))).toBeUndefined();
  });

  it('truncates history over the cap and inserts an omission marker', () => {
    const history = Array.from({ length: MAX_HISTORY_MESSAGES + 5 }, (_, i) => ({
      role: 'user',
      content: `msg ${i}`,
    }));

    const messages = buildMessages({
      systemInstructions: 'sys',
      contextBlock: null,
      history,
      newUserMessage: 'new',
    });

    const marker = messages.find((m) => m.content.includes('older messages omitted'));
    expect(marker).toBeDefined();
    expect(marker?.role).toBe('system');
    expect(marker?.content).toContain('5 older messages omitted');

    // Last history message must be the newest (msg 24).
    const lastHistory = messages[messages.length - 2];
    expect(lastHistory.content).toBe(`msg ${MAX_HISTORY_MESSAGES + 4}`);
    // First history message after the marker should be msg 5 (oldest kept).
    const markerIdx = messages.indexOf(marker!);
    expect(messages[markerIdx + 1].content).toBe('msg 5');
  });

  it('maps rows with toolCallId to tool-role messages', () => {
    const messages = buildMessages({
      systemInstructions: 'sys',
      contextBlock: null,
      history: [{ role: 'tool', content: '{"ok":true}', toolCallId: 'tc_1' }],
      newUserMessage: 'next',
    });

    expect(messages[1]).toEqual({
      role: 'tool',
      content: '{"ok":true}',
      toolCallId: 'tc_1',
    });
  });

  it('coerces unknown roles to user and warns', () => {
    const messages = buildMessages({
      systemInstructions: 'sys',
      contextBlock: null,
      history: [{ role: 'moderator', content: 'weird row' }],
      newUserMessage: 'next',
    });

    expect(messages[1]).toEqual({ role: 'user', content: 'weird row' });
    expect(loggerWarn).toHaveBeenCalledWith(
      'buildMessages: unknown role, coercing to user',
      expect.objectContaining({ role: 'moderator' })
    );
  });
});
