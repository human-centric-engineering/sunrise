/**
 * Tests for the conversation summarizer.
 *
 * Covers:
 * - Happy path: calls provider.chat with correct prompt, returns content
 * - Extension: `previousSummary` folds instead of re-deriving the prefix
 * - Empty messages array returns fallback
 * - Provider error returns fallback string (never throws)
 * - Empty response content returns fallback
 * - Logs cost via logCost, against ids that are real foreign keys (#654)
 *
 * @see lib/orchestration/chat/summarizer.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/orchestration/llm/settings-resolver', () => ({
  getDefaultModelForTask: vi.fn(),
}));

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  getProviderWithFallbacks: vi.fn(),
}));

vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  logCost: vi.fn(),
  calculateCost: vi.fn(() => ({
    inputCostUsd: 0,
    outputCostUsd: 0,
    totalCostUsd: 0,
    isLocal: false,
  })),
}));

import { logger } from '@/lib/logging';
import { getDefaultModelForTask } from '@/lib/orchestration/llm/settings-resolver';
import { getProviderWithFallbacks } from '@/lib/orchestration/llm/provider-manager';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { summarizeMessages, isPlaceholderSummary } from '@/lib/orchestration/chat/summarizer';
import type { HistoryRow } from '@/lib/orchestration/chat/message-builder';

const mockGetModel = vi.mocked(getDefaultModelForTask);
const mockGetProvider = vi.mocked(getProviderWithFallbacks);
const mockLogCost = vi.mocked(logCost);

const MESSAGES: HistoryRow[] = [
  { role: 'user', content: 'How do I deploy?' },
  { role: 'assistant', content: 'Use docker-compose up.' },
  { role: 'user', content: 'What about env vars?' },
];

function makeMockProvider(content = 'Summary of the conversation.') {
  return {
    name: 'mock-provider',
    isLocal: false,
    chat: vi.fn().mockResolvedValue({
      content,
      usage: { inputTokens: 100, outputTokens: 50 },
    }),
    chatStream: vi.fn(),
    embed: vi.fn(),
    listModels: vi.fn(),
    testConnection: vi.fn(),
  };
}

describe('summarizeMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetModel.mockResolvedValue('claude-haiku-4-5');
  });

  it('calls provider.chat with the correct system prompt and formatted messages', async () => {
    const mockProvider = makeMockProvider();
    mockGetProvider.mockResolvedValue({ provider: mockProvider, usedSlug: 'anthropic' });

    await summarizeMessages(MESSAGES, 'anthropic', ['openai']);

    expect(mockGetModel).toHaveBeenCalledWith('routing');
    expect(mockGetProvider).toHaveBeenCalledWith('anthropic', ['openai']);

    const chatCall = mockProvider.chat.mock.calls[0];
    const chatMessages = chatCall[0];
    expect(chatMessages[0].role).toBe('system');
    expect(chatMessages[0].content).toContain('conversation summarizer');
    expect(chatMessages[1].role).toBe('user');
    expect(chatMessages[1].content).toContain('[user]: How do I deploy?');
    expect(chatMessages[1].content).toContain('[assistant]: Use docker-compose up.');

    expect(chatCall[1]).toEqual({ model: 'claude-haiku-4-5', maxTokens: 500 });
  });

  it('returns the content from the LLM response', async () => {
    const mockProvider = makeMockProvider('The user asked about deployment.');
    mockGetProvider.mockResolvedValue({ provider: mockProvider, usedSlug: 'anthropic' });

    const result = await summarizeMessages(MESSAGES, 'anthropic', []);
    expect(result.summary).toBe('The user asked about deployment.');
    expect(result.fellBack).toBe(false);
    expect(result.model).toBe('claude-haiku-4-5');
    expect(result.provider).toBe('anthropic');
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
  });

  it('logs cost against the caller-supplied agent and conversation', async () => {
    // #654: these two used to be the literals `'system'` and `'summary'`.
    // `AiCostLog.agentId` and `.conversationId` are foreign keys to `AiAgent.id`
    // and `AiConversation.id`, so both were rejected with P2003 — which
    // `logCost` catches and turns into `null`, on a call that is `void`-ed.
    // Every summary ever generated cost money and left no row.
    const mockProvider = makeMockProvider();
    mockGetProvider.mockResolvedValue({ provider: mockProvider, usedSlug: 'anthropic' });

    await summarizeMessages(MESSAGES, 'anthropic', [], {
      agentId: 'agent-real-cuid',
      conversationId: 'conv-real-cuid',
    });

    expect(mockLogCost).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-real-cuid',
        conversationId: 'conv-real-cuid',
        model: 'claude-haiku-4-5',
        provider: 'anthropic',
        inputTokens: 100,
        outputTokens: 50,
      })
    );
  });

  it('tags the cost row so summarisation is separable from turns the user asked for', async () => {
    // `operation` stays `chat` — it is a chat completion billed to the agent and
    // the Costs page should total it as one. The kind lives in metadata so
    // analytics can still split it out.
    const mockProvider = makeMockProvider();
    mockGetProvider.mockResolvedValue({ provider: mockProvider, usedSlug: 'anthropic' });

    await summarizeMessages(MESSAGES, 'anthropic', [], { agentId: 'a', conversationId: 'c' });

    expect(mockLogCost).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'chat',
        metadata: expect.objectContaining({
          kind: 'conversation_summary',
          messageCount: MESSAGES.length,
          extended: false,
        }),
      })
    );
  });

  it('omits the FK columns entirely when the caller has no ids, rather than inventing them', async () => {
    // The failure mode being ruled out is a *placeholder* — any non-null value
    // that is not a real row id is rejected exactly as `'system'` was. Absent is
    // the only safe alternative to real: `logCost` skips a column it is not
    // given, and a null FK is legal on both.
    const mockProvider = makeMockProvider();
    mockGetProvider.mockResolvedValue({ provider: mockProvider, usedSlug: 'anthropic' });

    await summarizeMessages(MESSAGES, 'anthropic', []);

    const params = mockLogCost.mock.calls[0][0];
    expect(params).not.toHaveProperty('agentId');
    expect(params).not.toHaveProperty('conversationId');
  });

  it('returns fallback string when messages array is empty', async () => {
    const result = await summarizeMessages([], 'anthropic', []);
    expect(result.summary).toContain('Summary unavailable');
    expect(result.fellBack).toBe(true);
    expect(mockGetProvider).not.toHaveBeenCalled();
  });

  // ── Extension ────────────────────────────────────────────────────────────

  it('folds new messages into the previous summary instead of re-deriving it', async () => {
    // The point of the whole change: a long conversation must never re-summarise
    // its own prefix. The delta goes to the model; the prefix goes as text.
    const mockProvider = makeMockProvider('Updated summary.');
    mockGetProvider.mockResolvedValue({ provider: mockProvider, usedSlug: 'anthropic' });

    const result = await summarizeMessages(MESSAGES, 'anthropic', [], {
      previousSummary: 'The user was setting up deployment.',
    });

    const [chatMessages] = mockProvider.chat.mock.calls[0];
    // The system prompt must ask for a fold, not a summary — a plain summariser
    // handed a summary plus some messages will happily drop the summary.
    expect(chatMessages[0].content).toContain('carried forward, not replaced');
    // The prior summary is in the payload...
    expect(chatMessages[1].content).toContain('The user was setting up deployment.');
    // ...and so are the delta messages, which is what it is being folded with.
    expect(chatMessages[1].content).toContain('[user]: How do I deploy?');
    expect(result.summary).toBe('Updated summary.');
    expect(result.fellBack).toBe(false);
  });

  it('marks the cost row as an extension so the two call shapes stay distinguishable', async () => {
    const mockProvider = makeMockProvider();
    mockGetProvider.mockResolvedValue({ provider: mockProvider, usedSlug: 'anthropic' });

    await summarizeMessages(MESSAGES, 'anthropic', [], { previousSummary: 'Earlier.' });

    expect(mockLogCost).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ extended: true }) })
    );
  });

  it('treats an empty-string previousSummary as no summary at all', async () => {
    // `AiConversation.summary` is nullable text; an empty string is a shape the
    // column permits. Folding onto nothing would send the model an empty
    // "[Summary of the conversation so far]" header and ask it to carry that
    // forward.
    const mockProvider = makeMockProvider();
    mockGetProvider.mockResolvedValue({ provider: mockProvider, usedSlug: 'anthropic' });

    await summarizeMessages(MESSAGES, 'anthropic', [], { previousSummary: '' });

    const [chatMessages] = mockProvider.chat.mock.calls[0];
    expect(chatMessages[0].content).not.toContain('carried forward, not replaced');
    expect(chatMessages[1].content).not.toContain('Summary of the conversation so far');
  });

  // ── Never destroy a good summary ─────────────────────────────────────────

  it('hands back the previous summary — not the placeholder — when there is nothing to fold', async () => {
    // A caller that persists what it gets back would otherwise replace a good
    // summary with "[Summary unavailable]" on a no-op call.
    const result = await summarizeMessages([], 'anthropic', [], {
      previousSummary: 'Everything that came before.',
    });

    expect(result.summary).toBe('Everything that came before.');
    expect(result.fellBack).toBe(true);
    expect(mockGetProvider).not.toHaveBeenCalled();
  });

  it('hands back the previous summary when the model returns empty content', async () => {
    // /code-review round 3. This was the ONE failure path that discarded a good
    // summary: `response.content.trim() || FALLBACK_MESSAGE`. Reachable without
    // any error at all — a content filter, or a reasoning model spending its
    // 500-token budget before emitting text.
    const mockProvider = makeMockProvider('   ');
    mockGetProvider.mockResolvedValue({ provider: mockProvider, usedSlug: 'anthropic' });

    const result = await summarizeMessages(MESSAGES, 'anthropic', [], {
      previousSummary: 'Everything that came before.',
    });

    expect(result.summary).toBe('Everything that came before.');
    // Still a failure, so the caller does not persist and does not bill a
    // side-effect model. Deriving this from the RAW content matters: comparing
    // the RESULT to the placeholder would report success here and the caller
    // would advance the pin over messages nothing describes.
    expect(result.fellBack).toBe(true);
  });

  it('reports fellBack from the raw completion, not by comparing to the placeholder', async () => {
    // A model that literally emits the placeholder string is a successful call.
    const mockProvider = makeMockProvider('[Summary unavailable — earlier messages omitted]');
    mockGetProvider.mockResolvedValue({ provider: mockProvider, usedSlug: 'anthropic' });

    const result = await summarizeMessages(MESSAGES, 'anthropic', []);

    expect(result.fellBack).toBe(false);
  });

  it('carries the caller cost metadata onto the row, without letting it relabel the call', async () => {
    // /code-review round 3: the roster table named this boundary as carrying
    // the carrier while the code did not, so the doc asserted something false
    // about the line it was written for. An evaluation run reads its subject
    // spend back by `metadata.evaluationRunId`.
    const mockProvider = makeMockProvider();
    mockGetProvider.mockResolvedValue({ provider: mockProvider, usedSlug: 'anthropic' });

    await summarizeMessages(MESSAGES, 'anthropic', [], {
      costLogMetadata: { evaluationRunId: 'run-9', kind: 'something-else' },
    });

    expect(mockLogCost).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          evaluationRunId: 'run-9',
          // Caller keys first, own facts last — the caller cannot relabel a
          // summarisation as something else.
          kind: 'conversation_summary',
        }),
      })
    );
  });

  describe('isPlaceholderSummary', () => {
    it('recognises the pre-#654 placeholder rows that were persisted as summaries', () => {
      // The old code's `aiConversation.update` sat outside any `fellBack`
      // check, so live rows hold this text with a valid pin beside it.
      expect(isPlaceholderSummary('[Summary unavailable — earlier messages omitted]')).toBe(true);
      expect(isPlaceholderSummary('  [Summary unavailable — earlier messages omitted]  ')).toBe(
        true
      );
      expect(isPlaceholderSummary(null)).toBe(true);
      expect(isPlaceholderSummary('')).toBe(true);
      expect(isPlaceholderSummary('   ')).toBe(true);
    });

    it('does not mistake a real summary for the placeholder', () => {
      expect(isPlaceholderSummary('The user asked about deployment.')).toBe(false);
      // Nearby but not equal — a real summary that happens to discuss it.
      expect(isPlaceholderSummary('The summary was unavailable at the time.')).toBe(false);
    });
  });

  it('hands back the previous summary when the provider fails', async () => {
    // Same property on the error path, which is the one that actually fires in
    // production: one transient provider blip must not be able to erase the
    // conversation's memory. `fellBack` stays true so the caller knows not to
    // persist and not to bill a side-effect model.
    mockGetProvider.mockRejectedValue(new Error('Provider unreachable'));

    const result = await summarizeMessages(MESSAGES, 'anthropic', [], {
      previousSummary: 'Everything that came before.',
    });

    expect(result.summary).toBe('Everything that came before.');
    expect(result.fellBack).toBe(true);
  });

  it('returns fallback string on provider error (never throws)', async () => {
    mockGetProvider.mockRejectedValue(new Error('Provider unreachable'));

    const result = await summarizeMessages(MESSAGES, 'anthropic', []);
    expect(result.summary).toContain('Summary unavailable');
    expect(result.fellBack).toBe(true);
  });

  it('logs a warning on provider error', async () => {
    mockGetProvider.mockRejectedValue(new Error('Provider unreachable'));

    await summarizeMessages(MESSAGES, 'anthropic', []);

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'Conversation summarization failed, using fallback',
      expect.objectContaining({ error: 'Provider unreachable' })
    );
  });

  it('returns fallback string when LLM response content is empty', async () => {
    const mockProvider = makeMockProvider('   ');
    mockGetProvider.mockResolvedValue({ provider: mockProvider, usedSlug: 'anthropic' });

    const result = await summarizeMessages(MESSAGES, 'anthropic', []);
    expect(result.summary).toContain('Summary unavailable');
    expect(result.fellBack).toBe(true);
  });

  it('logs stringified non-Error rejection value and returns fallback', async () => {
    // Arrange: provider whose chat() rejects with a plain string, not an Error object
    const mockProvider = {
      ...makeMockProvider(),
      chat: vi.fn().mockRejectedValue('network failure'),
    };
    mockGetProvider.mockResolvedValue({ provider: mockProvider, usedSlug: 'anthropic' });

    // Act
    const result = await summarizeMessages(MESSAGES, 'anthropic', []);

    // Assert: logger.warn is called with String(err) rather than err.message
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'Conversation summarization failed, using fallback',
      expect.objectContaining({ error: 'network failure' })
    );

    // Assert: fallback message is returned (never throws)
    expect(result.summary).toContain('Summary unavailable');
    expect(result.fellBack).toBe(true);
  });
});
