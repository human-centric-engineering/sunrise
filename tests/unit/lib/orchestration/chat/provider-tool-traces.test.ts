/**
 * Tests for the trace entries of a provider's own web searches.
 */

import { describe, expect, it } from 'vitest';

import {
  PROVIDER_WEB_SEARCH_SLUG,
  providerToolTraces,
} from '@/lib/orchestration/chat/provider-tool-traces';
import { WEB_SEARCH_USD_PER_REQUEST, type LlmReasoningBlock } from '@/lib/orchestration/llm/types';

const use = (id: string, query: string): LlmReasoningBlock => ({
  type: 'server_tool_use',
  id,
  name: 'web_search',
  input: { query },
});

describe('providerToolTraces', () => {
  it('makes one entry per search, in order, priced and previewed', () => {
    const traces = providerToolTraces([
      { type: 'thinking', thinking: 'plan', signature: 'sig' },
      use('s1', 'sunrise'),
      {
        type: 'web_search_tool_result',
        toolUseId: 's1',
        results: [
          { url: 'https://a.example', title: 'A', encryptedContent: 'x' },
          { url: 'https://b.example', title: 'B', encryptedContent: 'y' },
        ],
      },
      use('s2', 'sunset'),
      { type: 'web_search_tool_result', toolUseId: 's2', results: [], errorCode: 'unavailable' },
    ]);

    expect(traces).toEqual([
      {
        slug: PROVIDER_WEB_SEARCH_SLUG,
        arguments: { query: 'sunrise' },
        latencyMs: 0,
        success: true,
        costUsd: 0.01,
        resultPreview: 'A — https://a.example\nB — https://b.example',
      },
      {
        slug: PROVIDER_WEB_SEARCH_SLUG,
        arguments: { query: 'sunset' },
        latencyMs: 0,
        success: false,
        errorCode: 'unavailable',
      },
    ]);
  });

  it('reads a search with no result as failed', () => {
    expect(providerToolTraces([use('s1', 'q')])).toEqual([
      expect.objectContaining({ success: false, errorCode: 'no_result' }),
    ]);
  });

  it('keeps the preview inside the trace schema’s limit', () => {
    const results = Array.from({ length: 100 }, (_, i) => ({
      url: `https://example.com/${'p'.repeat(40)}/${i}`,
      title: `Page ${i}`,
      encryptedContent: 'x',
    }));
    const [trace] = providerToolTraces([
      use('s1', 'q'),
      { type: 'web_search_tool_result', toolUseId: 's1', results },
    ]);
    expect(trace.resultPreview?.length).toBe(2000);
  });

  it('makes none without blocks, or with only thinking', () => {
    expect(providerToolTraces(undefined)).toEqual([]);
    expect(providerToolTraces([{ type: 'redacted_thinking', data: 'x' }])).toEqual([]);
    expect(
      providerToolTraces([
        { type: 'openai_reasoning', id: 'rs_1', encryptedContent: 'e', summary: [] },
      ])
    ).toEqual([]);
  });
});

describe('providerToolTraces — OpenAI web search (t-955)', () => {
  const call = (
    id: string,
    status: Extract<LlmReasoningBlock, { type: 'openai_web_search_call' }>['status'],
    action: Record<string, unknown>
  ): LlmReasoningBlock => ({ type: 'openai_web_search_call', id, status, action });

  it('makes one entry per web search item: what was asked, what came back, what it cost', () => {
    const traces = providerToolTraces([
      call('ws_1', 'completed', {
        type: 'search',
        queries: ['courier strikes'],
        sources: [
          { type: 'url', url: 'https://news.example/a' },
          { type: 'url', url: 'https://news.example/b' },
        ],
      }),
      call('ws_2', 'completed', { type: 'open_page', url: 'https://news.example/a' }),
    ]);

    expect(traces).toEqual([
      {
        slug: PROVIDER_WEB_SEARCH_SLUG,
        arguments: { type: 'search', queries: ['courier strikes'] },
        latencyMs: 0,
        success: true,
        costUsd: WEB_SEARCH_USD_PER_REQUEST,
        resultPreview: 'https://news.example/a\nhttps://news.example/b',
      },
      // Reading a page already found isn't billed.
      {
        slug: PROVIDER_WEB_SEARCH_SLUG,
        arguments: { type: 'open_page', url: 'https://news.example/a' },
        latencyMs: 0,
        success: true,
      },
    ]);
  });

  it('reads a failed search as failed and unbilled, and one cut short as failed but billed', () => {
    const [failed, cut] = providerToolTraces([
      call('ws_1', 'failed', { type: 'search', queries: ['q'] }),
      call('ws_2', 'searching', { type: 'search', queries: ['q'] }),
    ]);

    expect(failed).toMatchObject({ success: false, errorCode: 'failed' });
    expect(failed).not.toHaveProperty('costUsd');
    expect(cut).toMatchObject({
      success: false,
      errorCode: 'searching',
      costUsd: WEB_SEARCH_USD_PER_REQUEST,
    });
  });
});
