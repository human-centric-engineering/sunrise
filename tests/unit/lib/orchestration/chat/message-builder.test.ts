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
const { getTextContent } = await import('@/lib/orchestration/llm/types');

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
    expect(
      messages.find((m) => getTextContent(m.content).includes('older messages omitted'))
    ).toBeUndefined();
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

    const marker = messages.find((m) =>
      getTextContent(m.content).includes('older messages omitted')
    );
    expect(marker).toMatchObject({ role: 'system' });
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

  // ── conversationSummary integration ──────────────────────────────────────

  it('uses conversation summary instead of marker when history exceeds cap', () => {
    const history = Array.from({ length: MAX_HISTORY_MESSAGES + 3 }, (_, i) => ({
      role: 'user',
      content: `msg ${i}`,
    }));

    const messages = buildMessages({
      systemInstructions: 'sys',
      contextBlock: null,
      history,
      newUserMessage: 'new',
      conversationSummary: 'User asked about deployment; assistant explained Docker.',
    });

    const summaryMsg = messages.find((m) =>
      getTextContent(m.content).includes('Conversation summary')
    );
    expect(summaryMsg).toMatchObject({ role: 'system' });
    expect(summaryMsg?.content).toContain('3 earlier messages');
    expect(summaryMsg?.content).toContain('User asked about deployment');

    // Old marker should NOT appear
    expect(
      messages.find((m) => getTextContent(m.content).includes('older messages omitted'))
    ).toBeUndefined();
  });

  it('ignores conversationSummary when history is within the cap', () => {
    const history = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];

    const messages = buildMessages({
      systemInstructions: 'sys',
      contextBlock: null,
      history,
      newUserMessage: 'new',
      conversationSummary: 'Some summary that should not appear.',
    });

    expect(
      messages.find((m) => getTextContent(m.content).includes('Conversation summary'))
    ).toBeUndefined();
    expect(
      messages.find((m) => getTextContent(m.content).includes('Some summary'))
    ).toBeUndefined();
  });

  it('falls back to old marker when history exceeds cap but no summary provided', () => {
    const history = Array.from({ length: MAX_HISTORY_MESSAGES + 2 }, (_, i) => ({
      role: 'user',
      content: `msg ${i}`,
    }));

    const messages = buildMessages({
      systemInstructions: 'sys',
      contextBlock: null,
      history,
      newUserMessage: 'new',
    });

    const marker = messages.find((m) =>
      getTextContent(m.content).includes('older messages omitted')
    );
    expect(marker).toBeDefined();
    expect(marker?.content).toContain('2 older messages omitted');
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

  // ── userMemories injection ────────────────────────────────────────────────

  it('injects user memories as a system message after the context block', () => {
    const messages = buildMessages({
      systemInstructions: 'System.',
      contextBlock: '=== LOCKED CONTEXT ===\nfoo\n=== END LOCKED CONTEXT ===',
      history: [],
      newUserMessage: 'Hi',
      userMemories: [
        { key: 'language', value: 'TypeScript' },
        { key: 'topic', value: 'agents' },
      ],
    });

    // Expected order: system instructions → context block → memories → user
    expect(messages[0].role).toBe('system'); // instructions
    expect(messages[1].role).toBe('system'); // context block
    expect(messages[1].content).toContain('LOCKED CONTEXT');

    const memMsg = messages[2];
    expect(memMsg.role).toBe('system');
    expect(memMsg.content).toContain('[User memories]');
    expect(memMsg.content).toContain('- language: TypeScript');
    expect(memMsg.content).toContain('- topic: agents');

    expect(messages[3]).toEqual({ role: 'user', content: 'Hi' });
  });

  it('formats each memory as a "- key: value" bullet', () => {
    const messages = buildMessages({
      systemInstructions: 'sys',
      contextBlock: null,
      history: [],
      newUserMessage: 'go',
      userMemories: [
        { key: 'preferred_language', value: 'Python' },
        { key: 'project_name', value: 'sunrise' },
      ],
    });

    const memMsg = messages.find((m) => getTextContent(m.content).includes('[User memories]'));
    expect(memMsg).toBeDefined();
    expect(memMsg?.content).toContain('- preferred_language: Python');
    expect(memMsg?.content).toContain('- project_name: sunrise');
  });

  it('does not inject a memory message when userMemories is undefined', () => {
    const messages = buildMessages({
      systemInstructions: 'sys',
      contextBlock: null,
      history: [],
      newUserMessage: 'hi',
    });

    expect(
      messages.find((m) => getTextContent(m.content).includes('[User memories]'))
    ).toBeUndefined();
    // Only system instructions + user message
    expect(messages).toHaveLength(2);
  });

  it('does not inject a memory message when userMemories is an empty array', () => {
    const messages = buildMessages({
      systemInstructions: 'sys',
      contextBlock: null,
      history: [],
      newUserMessage: 'hi',
      userMemories: [],
    });

    expect(
      messages.find((m) => getTextContent(m.content).includes('[User memories]'))
    ).toBeUndefined();
    expect(messages).toHaveLength(2);
  });

  // ── brandVoiceInstructions injection ─────────────────────────────────────

  it('appends brand voice instructions to system prompt', () => {
    const messages = buildMessages({
      systemInstructions: 'You are a helpful agent.',
      contextBlock: null,
      history: [],
      newUserMessage: 'Hi',
      brandVoiceInstructions: 'Always respond in a friendly, casual tone. Use simple language.',
    });

    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('You are a helpful agent.');
    expect(messages[0].content).toContain('[Brand Voice]');
    expect(messages[0].content).toContain('Always respond in a friendly, casual tone.');
  });

  it('does not add brand voice section when null', () => {
    const messages = buildMessages({
      systemInstructions: 'You are a helpful agent.',
      contextBlock: null,
      history: [],
      newUserMessage: 'Hi',
      brandVoiceInstructions: null,
    });

    expect(messages[0].content).toBe('You are a helpful agent.');
    expect(messages[0].content).not.toContain('[Brand Voice]');
  });

  it('does not add brand voice section when omitted', () => {
    const messages = buildMessages({
      systemInstructions: 'System.',
      contextBlock: null,
      history: [],
      newUserMessage: 'Hi',
    });

    expect(messages[0].content).toBe('System.');
    expect(messages[0].content).not.toContain('[Brand Voice]');
  });

  // ── token-aware truncation ─────────────────────────────────────────────────

  it('applies token-aware truncation when contextWindowTokens is set', () => {
    // Arrange: build 6 history messages, each roughly 10 tokens
    const history = Array.from({ length: 6 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: 'short msg', // ~7 tokens
    }));

    // Use a tight context window that only fits ~2 history messages
    const messages = buildMessages({
      systemInstructions: 'sys',
      contextBlock: null,
      history,
      newUserMessage: 'new',
      contextWindowTokens: 50, // very tight
      reserveTokens: 10,
    });

    // With a tight window, some history must be dropped
    // Total messages = system (1) + some history + user (1)
    // We only care that the last user message is present and order is correct
    const lastMsg = messages[messages.length - 1];
    expect(lastMsg).toEqual({ role: 'user', content: 'new' });
    expect(messages[0].role).toBe('system');
  });

  it('drops all history when contextWindowTokens budget is zero or negative after overhead', () => {
    // Arrange: very tight context window that can't fit any history
    const history = [
      { role: 'user', content: 'message one' },
      { role: 'assistant', content: 'message two' },
    ];

    const messages = buildMessages({
      systemInstructions: 'A very long system instruction that takes up many tokens.',
      contextBlock: 'A very long context block that takes up many more tokens.',
      history,
      newUserMessage: 'hi',
      contextWindowTokens: 10, // tiny — no room for history
      reserveTokens: 9,
    });

    // No history should remain (all dropped), but an omission marker appears
    // or just the system + user messages
    const lastMsg = messages[messages.length - 1];
    expect(lastMsg).toEqual({ role: 'user', content: 'hi' });
    // No history messages in the output (they were all dropped)
    const historyMsgs = messages.filter(
      (m) => m.content === 'message one' || m.content === 'message two'
    );
    expect(historyMsgs).toHaveLength(0);
  });

  it('accounts for attachment token overhead in history budget', () => {
    // Arrange: a budget that can fit history without attachments but not with
    const history = [
      { role: 'user', content: 'old message' },
      { role: 'assistant', content: 'old reply' },
    ];

    // Without attachments — history fits
    const withoutAttachments = buildMessages({
      systemInstructions: 'sys',
      contextBlock: null,
      history,
      newUserMessage: 'hi',
      contextWindowTokens: 200,
      reserveTokens: 50,
    });
    const historyWithout = withoutAttachments.filter(
      (m) => m.content === 'old message' || m.content === 'old reply'
    );
    expect(historyWithout.length).toBeGreaterThan(0);

    // With 50 attachments — 50 × 1600 = 80 000 tokens of overhead blows the budget
    const withAttachments = buildMessages({
      systemInstructions: 'sys',
      contextBlock: null,
      history,
      newUserMessage: 'hi',
      attachments: Array.from({ length: 50 }, (_, i) => ({
        name: `img-${i}.png`,
        mediaType: 'image/png' as const,
        data: 'base64data',
      })),
      contextWindowTokens: 200,
      reserveTokens: 50,
    });
    const historyWith = withAttachments.filter(
      (m) =>
        (typeof m.content === 'string' && m.content === 'old message') ||
        (typeof m.content === 'string' && m.content === 'old reply')
    );
    expect(historyWith).toHaveLength(0);
  });

  // ── attachment handling ────────────────────────────────────────────────────

  it('builds a multimodal user message with an image attachment', () => {
    const messages = buildMessages({
      systemInstructions: 'sys',
      contextBlock: null,
      history: [],
      newUserMessage: 'Describe this image',
      attachments: [{ name: 'photo.png', mediaType: 'image/png', data: 'base64data' }],
    });

    // Last message should be multimodal (ContentPart[])
    const userMsg = messages[messages.length - 1];
    expect(userMsg.role).toBe('user');
    expect(Array.isArray(userMsg.content)).toBe(true);
    const parts = userMsg.content as Array<{ type: string }>;
    expect(parts[0]).toEqual({ type: 'text', text: 'Describe this image' });
    expect(parts[1]).toMatchObject({ type: 'image' });
  });

  it('builds a multimodal user message with a document attachment', () => {
    const messages = buildMessages({
      systemInstructions: 'sys',
      contextBlock: null,
      history: [],
      newUserMessage: 'Summarize this PDF',
      attachments: [{ name: 'report.pdf', mediaType: 'application/pdf', data: 'pdfdata' }],
    });

    const userMsg = messages[messages.length - 1];
    expect(Array.isArray(userMsg.content)).toBe(true);
    const parts = userMsg.content as Array<{ type: string; name?: string }>;
    expect(parts[0]).toEqual({ type: 'text', text: 'Summarize this PDF' });
    expect(parts[1]).toMatchObject({ type: 'document', name: 'report.pdf' });
  });

  it('builds a multimodal user message with mixed image and document attachments', () => {
    const messages = buildMessages({
      systemInstructions: 'sys',
      contextBlock: null,
      history: [],
      newUserMessage: 'Analyze both',
      attachments: [
        { name: 'photo.jpg', mediaType: 'image/jpeg', data: 'imgdata' },
        { name: 'doc.pdf', mediaType: 'application/pdf', data: 'pdfdata' },
      ],
    });

    const userMsg = messages[messages.length - 1];
    const parts = userMsg.content as Array<{ type: string }>;
    expect(parts).toHaveLength(3); // text + image + document
    expect(parts[0].type).toBe('text');
    expect(parts[1].type).toBe('image');
    expect(parts[2].type).toBe('document');
  });

  it('uses plain string content when attachments array is empty', () => {
    const messages = buildMessages({
      systemInstructions: 'sys',
      contextBlock: null,
      history: [],
      newUserMessage: 'Just text',
      attachments: [],
    });

    const userMsg = messages[messages.length - 1];
    expect(typeof userMsg.content).toBe('string');
    expect(userMsg.content).toBe('Just text');
  });

  it('injects memories before history messages', () => {
    const messages = buildMessages({
      systemInstructions: 'sys',
      contextBlock: null,
      history: [
        { role: 'user', content: 'earlier message' },
        { role: 'assistant', content: 'earlier reply' },
      ],
      newUserMessage: 'new',
      userMemories: [{ key: 'lang', value: 'Go' }],
    });

    const memIdx = messages.findIndex((m) => getTextContent(m.content).includes('[User memories]'));
    const histIdx = messages.findIndex((m) => m.content === 'earlier message');

    expect(memIdx).toBeGreaterThan(-1);
    expect(histIdx).toBeGreaterThan(memIdx);
  });
});
