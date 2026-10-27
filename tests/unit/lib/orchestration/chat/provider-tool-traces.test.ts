/**
 * Tests for the trace entries of a provider's own web searches.
 */

import { describe, expect, it } from 'vitest';

import {
  PROVIDER_WEB_SEARCH_SLUG,
  providerToolTraces,
} from '@/lib/orchestration/chat/provider-tool-traces';
import type { LlmReasoningBlock } from '@/lib/orchestration/llm/types';

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
  });
});
