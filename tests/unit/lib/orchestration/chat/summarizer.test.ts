/**
 * Tests for the conversation summarizer.
 *
 * Covers:
 * - Happy path: calls provider.chat with correct prompt, returns content
 * - Empty messages array returns fallback
 * - Provider error returns fallback string (never throws)
 * - Empty response content returns fallback
 * - Logs cost via logCost
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
}));

import { logger } from '@/lib/logging';
import { getDefaultModelForTask } from '@/lib/orchestration/llm/settings-resolver';
import { getProviderWithFallbacks } from '@/lib/orchestration/llm/provider-manager';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { summarizeMessages } from '@/lib/orchestration/chat/summarizer';
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
    expect(result).toBe('The user asked about deployment.');
  });

  it('logs cost via logCost after success', async () => {
    const mockProvider = makeMockProvider();
    mockGetProvider.mockResolvedValue({ provider: mockProvider, usedSlug: 'anthropic' });

    await summarizeMessages(MESSAGES, 'anthropic', []);

    expect(mockLogCost).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'system',
        conversationId: 'summary',
        model: 'claude-haiku-4-5',
        provider: 'anthropic',
        inputTokens: 100,
        outputTokens: 50,
      })
    );
  });

  it('returns fallback string when messages array is empty', async () => {
    const result = await summarizeMessages([], 'anthropic', []);
    expect(result).toContain('Summary unavailable');
    expect(mockGetProvider).not.toHaveBeenCalled();
  });

  it('returns fallback string on provider error (never throws)', async () => {
    mockGetProvider.mockRejectedValue(new Error('Provider unreachable'));

    const result = await summarizeMessages(MESSAGES, 'anthropic', []);
    expect(result).toContain('Summary unavailable');
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
    expect(result).toContain('Summary unavailable');
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
    expect(result).toContain('Summary unavailable');
  });
});
