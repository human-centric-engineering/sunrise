/**
 * OpenAiCompatibleProvider — the Responses API path (t-955)
 *
 * OpenAI's own web search runs on the Responses API, so an agent on OpenAI
 * with web search on takes that path and every other request stays on Chat
 * Completions. Covers:
 * - The routing rule (host, setting, model, site filters, effort, JSON output)
 * - Request mapping (stateless, tools, site hosts, the per-call search limit)
 * - Input mapping and replay of the reasoning / web search items across a
 *   tool loop, with another provider's blocks left out
 * - Response and stream mapping (text, tool calls, blocks, usage, searches)
 * - The reasoning-summary fallback for an unverified organisation
 * - The retry without reasoning items OpenAI can't decrypt (t-959)
 *
 * Response fixtures are shaped on live gpt-5-mini responses (2026-10-27).
 *
 * @see lib/orchestration/llm/openai-responses.ts
 * @see lib/orchestration/llm/openai-compatible.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LlmMessage, LlmOptions, StreamChunk } from '@/lib/orchestration/llm/types';

const chatCreateMock = vi.fn();
const responsesCreateMock = vi.fn();

vi.mock('openai', () => {
  class MockOpenAI {
    public chat = { completions: { create: chatCreateMock } };
    public responses = { create: responsesCreateMock };
    public embeddings = { create: vi.fn() };
    public models = { list: vi.fn() };
  }
  return { default: MockOpenAI };
});

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({ logger: loggerMock }));

const { OpenAiCompatibleProvider } = await import('@/lib/orchestration/llm/openai-compatible');
const { ProviderError } = await import('@/lib/orchestration/llm/provider');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeProvider(baseUrl = 'https://api.openai.com/v1') {
  return new OpenAiCompatibleProvider({ name: 'openai', baseUrl, apiKey: 'k', isLocal: false });
}

const SEARCH: LlmOptions['providerTools'] = { webSearch: {} };

const lookupTool = {
  name: 'lookup_order',
  description: 'Look up an order',
  parameters: { type: 'object', properties: { id: { type: 'string' } } },
};

const reasoningItem = {
  type: 'reasoning',
  id: 'rs_1',
  encrypted_content: 'enc-1',
  summary: [{ type: 'summary_text', text: '**Planning** I need to search.' }],
};
const searchItem = {
  type: 'web_search_call',
  id: 'ws_1',
  status: 'completed',
  action: {
    type: 'search',
    queries: ['courier strike dates'],
    query: 'courier strike dates',
    sources: [
      { type: 'url', url: 'https://news.example/strike' },
      { type: 'url', url: 'https://courier.example/notice' },
    ],
  },
};
const functionCallItem = {
  type: 'function_call',
  id: 'fc_1',
  call_id: 'call_1',
  name: 'lookup_order',
  arguments: '{"id":"4471"}',
  status: 'completed',
};
const messageItem = {
  type: 'message',
  id: 'msg_1',
  role: 'assistant',
  status: 'completed',
  content: [
    {
      type: 'output_text',
      text: 'Strikes are on Thursday.',
      annotations: [{ type: 'url_citation', url: 'https://news.example/strike' }],
    },
  ],
};

function makeResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 'resp_1',
    model: 'gpt-5-mini-2025-08-07',
    status: 'completed',
    incomplete_details: null,
    error: null,
    max_output_tokens: 4096,
    service_tier: 'default',
    output: [reasoningItem, searchItem, messageItem],
    usage: {
      input_tokens: 8867,
      input_tokens_details: { cached_tokens: 4352, cache_write_tokens: 0 },
      output_tokens: 297,
      output_tokens_details: { reasoning_tokens: 192 },
      total_tokens: 9164,
    },
    ...overrides,
  };
}

async function* toAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

/** The params the provider sent on its nth Responses call. */
function sentParams(call = 0): Record<string, unknown> {
  return responsesCreateMock.mock.calls[call][0] as Record<string, unknown>;
}

beforeEach(() => {
  chatCreateMock.mockReset();
  responsesCreateMock.mockReset();
  Object.values(loggerMock).forEach((fn) => fn.mockClear());
  chatCreateMock.mockResolvedValue({
    model: 'gpt-5-mini',
    choices: [{ message: { content: 'chat completions' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
  responsesCreateMock.mockResolvedValue(makeResponse());
});

const ask: LlmMessage[] = [{ role: 'user', content: 'Any courier strikes this week?' }];

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

describe('which API a request takes', () => {
  it('takes the Responses API for OpenAI itself with web search on', async () => {
    const res = await makeProvider().chat(ask, { model: 'gpt-5-mini', providerTools: SEARCH });

    expect(responsesCreateMock).toHaveBeenCalledTimes(1);
    expect(chatCreateMock).not.toHaveBeenCalled();
    expect(res.content).toBe('Strikes are on Thursday.');
  });

  it('stays on Chat Completions without web search', async () => {
    await makeProvider().chat(ask, { model: 'gpt-5-mini' });

    expect(chatCreateMock).toHaveBeenCalledTimes(1);
    expect(responsesCreateMock).not.toHaveBeenCalled();
  });

  it('stays on Chat Completions on another OpenAI-compatible host, sending no search', async () => {
    await makeProvider('https://api.groq.com/openai/v1').chat(ask, {
      model: 'gpt-5-mini',
      providerTools: SEARCH,
    });

    expect(responsesCreateMock).not.toHaveBeenCalled();
    const params = chatCreateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(JSON.stringify(params)).not.toContain('web_search');
  });

  it('stays on Chat Completions for structured output', async () => {
    await makeProvider().chat(ask, {
      model: 'gpt-5-mini',
      providerTools: SEARCH,
      responseFormat: { type: 'json_object' },
    });

    expect(responsesCreateMock).not.toHaveBeenCalled();
  });

  it.each(['gpt-4.1-nano', 'gpt-3.5-turbo', 'o3-mini', 'my-gpt-5', 'gpt-4o-mini-search-preview'])(
    'stays on Chat Completions on %s, which has no web search, and logs the drop',
    async (model) => {
      await makeProvider().chat(ask, { model, providerTools: SEARCH });

      expect(responsesCreateMock).not.toHaveBeenCalled();
      expect(loggerMock.info).toHaveBeenCalledWith(
        'OpenAI: web search dropped, the request cannot take it',
        expect.objectContaining({ model, reason: 'model' })
      );
    }
  );

  it('stays on Chat Completions at minimal effort on GPT-5, which refuses search there', async () => {
    await makeProvider().chat(ask, {
      model: 'gpt-5-mini',
      reasoningEffort: 'minimal',
      providerTools: SEARCH,
    });

    expect(responsesCreateMock).not.toHaveBeenCalled();
    expect(loggerMock.info).toHaveBeenCalledWith(
      'OpenAI: web search dropped, the request cannot take it',
      expect.objectContaining({ model: 'gpt-5-mini', reason: 'minimal_effort' })
    );
  });

  it('takes the Responses API at minimal on an o-series model, which is sent no effort', async () => {
    await makeProvider().chat(ask, {
      model: 'o3',
      reasoningEffort: 'minimal',
      providerTools: SEARCH,
    });

    expect(responsesCreateMock).toHaveBeenCalledTimes(1);
    expect(sentParams().reasoning).not.toHaveProperty('effort');
  });

  it('takes gpt-4o-mini to the Responses API with no site list', async () => {
    await makeProvider().chat(ask, { model: 'gpt-4o-mini', providerTools: SEARCH });

    expect(responsesCreateMock).toHaveBeenCalledTimes(1);
  });

  it.each(['gpt-4o-mini', 'gpt-4.1-mini'])(
    'keeps %s off search when a site list is set, rather than searching every site',
    async (model) => {
      await makeProvider().chat(ask, {
        model,
        providerTools: { webSearch: { allowedDomains: ['example.com'] } },
      });

      expect(responsesCreateMock).not.toHaveBeenCalled();
      expect(JSON.stringify(chatCreateMock.mock.calls[0][0])).not.toContain('web_search');
      expect(loggerMock.info).toHaveBeenCalledWith(
        'OpenAI: web search dropped, the request cannot take it',
        expect.objectContaining({ model, reason: 'site_filters' })
      );
    }
  );

  it('routes the stream the same way', async () => {
    responsesCreateMock.mockResolvedValue(
      toAsyncIterable([{ type: 'response.completed', response: makeResponse() }])
    );

    await collect(makeProvider().chatStream(ask, { model: 'gpt-5-mini', providerTools: SEARCH }));

    expect(responsesCreateMock).toHaveBeenCalledTimes(1);
    expect(sentParams().stream).toBe(true);
    expect(chatCreateMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Request mapping
// ---------------------------------------------------------------------------

describe('the Responses request', () => {
  it('is stateless and asks for what a later call needs to replay', async () => {
    await makeProvider().chat(ask, { model: 'gpt-5-mini', maxTokens: 2000, providerTools: SEARCH });

    expect(sentParams()).toMatchObject({
      model: 'gpt-5-mini',
      store: false,
      max_output_tokens: 2000,
      include: ['web_search_call.action.sources', 'reasoning.encrypted_content'],
      tools: [{ type: 'web_search' }],
    });
  });

  it('asks a non-reasoning model for no encrypted reasoning and no reasoning settings', async () => {
    await makeProvider().chat(ask, {
      model: 'gpt-4o',
      temperature: 0.3,
      topP: 0.9,
      providerTools: SEARCH,
    });

    const params = sentParams();
    expect(params.include).toEqual(['web_search_call.action.sources']);
    expect(params).not.toHaveProperty('reasoning');
    expect(params).toMatchObject({ temperature: 0.3, top_p: 0.9 });
  });

  it('sends a reasoning model its effort and asks for a summary, but no sampling', async () => {
    await makeProvider().chat(ask, {
      model: 'gpt-5-mini',
      reasoningEffort: 'max',
      temperature: 0.3,
      topP: 0.9,
      providerTools: SEARCH,
    });

    const params = sentParams();
    expect(params.reasoning).toEqual({ effort: 'high', summary: 'auto' });
    expect(params).not.toHaveProperty('temperature');
    expect(params).not.toHaveProperty('top_p');
  });

  it('sends function tools as non-strict, beside the search tool', async () => {
    await makeProvider().chat(ask, {
      model: 'gpt-5-mini',
      tools: [lookupTool],
      toolChoice: { name: 'lookup_order' },
      parallelToolCalls: false,
      providerTools: SEARCH,
    });

    expect(sentParams()).toMatchObject({
      tools: [
        {
          type: 'function',
          name: 'lookup_order',
          description: 'Look up an order',
          parameters: lookupTool.parameters,
          strict: false,
        },
        { type: 'web_search' },
      ],
      tool_choice: { type: 'function', name: 'lookup_order' },
      parallel_tool_calls: false,
    });
  });

  it('sends verbosity and service tier, and drops stop sequences the API does not take', async () => {
    await makeProvider().chat(ask, {
      model: 'gpt-5-mini',
      verbosity: 'low',
      serviceTier: 'flex',
      stopSequences: ['END'],
      providerTools: SEARCH,
    });

    const params = sentParams();
    expect(params).toMatchObject({ text: { verbosity: 'low' }, service_tier: 'flex' });
    expect(params).not.toHaveProperty('stop');
  });

  it('sends a site list as hosts, each once', async () => {
    await makeProvider().chat(ask, {
      model: 'gpt-5-mini',
      providerTools: {
        webSearch: { allowedDomains: ['docs.example.com/guides', 'docs.example.com', 'Other.org'] },
      },
    });

    expect(sentParams().tools).toEqual([
      { type: 'web_search', filters: { allowed_domains: ['docs.example.com', 'other.org'] } },
    ]);
    expect(loggerMock.info).toHaveBeenCalledWith(
      'OpenAI: web search site paths sent as hosts',
      expect.objectContaining({ list: 'allowed_domains' })
    );
  });

  it('sends a block list as blocked_domains', async () => {
    await makeProvider().chat(ask, {
      model: 'gpt-5-mini',
      providerTools: { webSearch: { blockedDomains: ['reddit.com/r/soccer'] } },
    });

    expect(sentParams().tools).toEqual([
      { type: 'web_search', filters: { blocked_domains: ['reddit.com'] } },
    ]);
  });

  it('caps a call at the search limit with max_tool_calls', async () => {
    await makeProvider().chat(ask, {
      model: 'gpt-5-mini',
      providerTools: { webSearch: { maxUses: 3 } },
    });

    expect(sentParams().max_tool_calls).toBe(3);
  });

  it('gives a later call the whole limit and keeps the tool, once the reply has spent it', async () => {
    // What `spendWebSearches` hands the next call of a tool loop: none left of
    // the reply's 3, the whole limit kept. Taking the tool away loses what the
    // earlier searches found, so OpenAI caps each call instead (t-955 ruling).
    await makeProvider().chat(ask, {
      model: 'gpt-5-mini',
      providerTools: { webSearch: { maxUses: 0, replyLimit: 3 } },
    });

    expect(sentParams().tools).toEqual([{ type: 'web_search' }]);
    expect(sentParams().max_tool_calls).toBe(3);
  });

  it('sends no max_tool_calls without a limit', async () => {
    await makeProvider().chat(ask, { model: 'gpt-5-mini', providerTools: SEARCH });

    expect(sentParams()).not.toHaveProperty('max_tool_calls');
  });
});

// ---------------------------------------------------------------------------
// Input mapping and replay
// ---------------------------------------------------------------------------

describe('the conversation as Responses input', () => {
  it('maps roles, multimodal parts, tool calls and results', async () => {
    const messages: LlmMessage[] = [
      { role: 'system', content: 'Be brief.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Read these' },
          { type: 'image', source: { type: 'url', url: 'https://img.example/a.png' } },
          {
            type: 'image',
            source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' },
          },
          {
            type: 'document',
            name: 'a.pdf',
            source: { type: 'base64', mediaType: 'application/pdf', data: 'JVBE' },
          },
          {
            type: 'document',
            name: 'n.txt',
            source: {
              type: 'base64',
              mediaType: 'text/plain',
              data: Buffer.from('hi').toString('base64'),
            },
          },
        ],
      },
      {
        role: 'assistant',
        content: 'Checking.',
        toolCalls: [{ id: 'call_1', name: 'lookup_order', arguments: { id: '4471' } }],
      },
      { role: 'tool', toolCallId: 'call_1', content: 'dispatched Monday' },
    ];

    await makeProvider().chat(messages, { model: 'gpt-5-mini', providerTools: SEARCH });

    expect(sentParams().input).toEqual([
      { role: 'system', content: 'Be brief.' },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Read these' },
          { type: 'input_image', image_url: 'https://img.example/a.png', detail: 'auto' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' },
          { type: 'input_file', filename: 'a.pdf', file_data: 'data:application/pdf;base64,JVBE' },
          { type: 'input_text', text: '[Document: n.txt]\nhi' },
        ],
      },
      { role: 'assistant', content: 'Checking.' },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'lookup_order',
        arguments: '{"id":"4471"}',
      },
      { type: 'function_call_output', call_id: 'call_1', output: 'dispatched Monday' },
    ]);
  });

  it('replays a turn’s reasoning and search items, in order, on the call that continues it', async () => {
    // Call 1 searches, then asks for a capability; the tool loop appends the
    // assistant turn with the blocks the response carried, then the result.
    responsesCreateMock.mockResolvedValueOnce(
      makeResponse({ output: [reasoningItem, searchItem, functionCallItem] })
    );
    const provider = makeProvider();
    const first = await provider.chat(ask, {
      model: 'gpt-5-mini',
      tools: [lookupTool],
      providerTools: SEARCH,
    });
    expect(first.finishReason).toBe('tool_use');

    await provider.chat(
      [
        ...ask,
        {
          role: 'assistant',
          content: first.content,
          toolCalls: first.toolCalls,
          reasoning: first.reasoning,
        },
        { role: 'tool', toolCallId: 'call_1', content: 'dispatched Monday' },
      ],
      { model: 'gpt-5-mini', tools: [lookupTool], providerTools: SEARCH }
    );

    expect(sentParams(1).input).toEqual([
      { role: 'user', content: 'Any courier strikes this week?' },
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: '**Planning** I need to search.' }],
        encrypted_content: 'enc-1',
      },
      { type: 'web_search_call', id: 'ws_1', status: 'completed', action: searchItem.action },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'lookup_order',
        arguments: '{"id":"4471"}',
      },
      { type: 'function_call_output', call_id: 'call_1', output: 'dispatched Monday' },
    ]);
  });

  it('leaves out a search item whose action OpenAI would not take back, such as a damaged checkpoint’s', async () => {
    await makeProvider().chat(
      [
        { role: 'user', content: 'x' },
        {
          role: 'assistant',
          content: 'Found it.',
          reasoning: [
            {
              type: 'openai_web_search_call',
              id: 'ws_bad',
              status: 'completed',
              action: { type: 'teleport' },
            },
            {
              type: 'openai_web_search_call',
              id: 'ws_ok',
              status: 'completed',
              action: { type: 'find_in_page', pattern: 'strike', url: 'https://news.example/a' },
            },
          ],
        },
      ],
      { model: 'gpt-5-mini', providerTools: SEARCH }
    );

    expect(sentParams().input).toEqual([
      { role: 'user', content: 'x' },
      {
        type: 'web_search_call',
        id: 'ws_ok',
        status: 'completed',
        action: { type: 'find_in_page', pattern: 'strike', url: 'https://news.example/a' },
      },
      { role: 'assistant', content: 'Found it.' },
    ]);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'OpenAI: web search item left out of replay, action not recognised',
      { id: 'ws_bad' }
    );
  });

  it('replays a search with only its url sources, keeping one OpenAI sent from a feed', async () => {
    await makeProvider().chat(
      [
        { role: 'user', content: 'Weather in London?' },
        {
          role: 'assistant',
          content: 'Mild and dry.',
          reasoning: [
            {
              type: 'openai_web_search_call',
              id: 'ws_weather',
              status: 'completed',
              action: {
                type: 'search',
                queries: ['weather: London, UK'],
                sources: [
                  { type: 'api', name: 'oai-weather' },
                  { type: 'url', url: 'https://weather.example/london' },
                ],
              },
            },
          ],
        },
      ],
      { model: 'gpt-5-mini', providerTools: SEARCH }
    );

    expect(sentParams().input).toEqual([
      { role: 'user', content: 'Weather in London?' },
      {
        type: 'web_search_call',
        id: 'ws_weather',
        status: 'completed',
        action: {
          type: 'search',
          queries: ['weather: London, UK'],
          sources: [{ type: 'url', url: 'https://weather.example/london' }],
        },
      },
      { role: 'assistant', content: 'Mild and dry.' },
    ]);
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it('leaves out another provider’s blocks, such as Claude thinking after a fallback', async () => {
    await makeProvider().chat(
      [
        { role: 'user', content: 'What is 2+2?' },
        {
          role: 'assistant',
          content: '4',
          reasoning: [
            { type: 'thinking', thinking: 'adding', signature: 'sig' },
            { type: 'redacted_thinking', data: 'x' },
            { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'q' } },
          ],
        },
        { role: 'user', content: 'And 3+3?' },
      ],
      { model: 'gpt-5-mini', providerTools: SEARCH }
    );

    expect(sentParams().input).toEqual([
      { role: 'user', content: 'What is 2+2?' },
      { role: 'assistant', content: '4' },
      { role: 'user', content: 'And 3+3?' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Response mapping
// ---------------------------------------------------------------------------

describe('a Responses result', () => {
  it('maps text, blocks, usage and the searches it ran', async () => {
    const res = await makeProvider().chat(ask, { model: 'gpt-5-mini', providerTools: SEARCH });

    expect(res).toEqual({
      content: 'Strikes are on Thursday.',
      model: 'gpt-5-mini-2025-08-07',
      finishReason: 'stop',
      usage: {
        inputTokens: 8867,
        outputTokens: 297,
        reasoningTokens: 192,
        cacheReadTokens: 4352,
        webSearchRequests: 1,
      },
      reasoning: [
        {
          type: 'openai_reasoning',
          id: 'rs_1',
          encryptedContent: 'enc-1',
          summary: ['**Planning** I need to search.'],
        },
        {
          type: 'openai_web_search_call',
          id: 'ws_1',
          status: 'completed',
          action: searchItem.action,
        },
      ],
    });
  });

  it('keeps each message of a response as its own paragraph', async () => {
    responsesCreateMock.mockResolvedValue(
      makeResponse({
        output: [
          {
            type: 'message',
            id: 'msg_a',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Let me look that up.', annotations: [] }],
          },
          searchItem,
          messageItem,
        ],
      })
    );

    const res = await makeProvider().chat(ask, { model: 'gpt-5-mini', providerTools: SEARCH });

    expect(res.content).toBe('Let me look that up.\n\nStrikes are on Thursday.');
  });

  it('maps function calls, and reads the turn as tool use', async () => {
    responsesCreateMock.mockResolvedValue(makeResponse({ output: [functionCallItem] }));

    const res = await makeProvider().chat(ask, {
      model: 'gpt-5-mini',
      tools: [lookupTool],
      providerTools: SEARCH,
    });

    expect(res.toolCalls).toEqual([
      { id: 'call_1', name: 'lookup_order', arguments: { id: '4471' } },
    ]);
    expect(res.finishReason).toBe('tool_use');
  });

  it('counts billed searches only: not page reads, not failed searches, but a search cut short', async () => {
    const search = (id: string, status: string, type = 'search') => ({
      type: 'web_search_call',
      id,
      status,
      action: { type, ...(type === 'search' ? { queries: ['q'] } : { url: 'https://a.example' }) },
    });
    responsesCreateMock.mockResolvedValue(
      makeResponse({
        output: [
          search('ws_1', 'completed'),
          search('ws_2', 'completed', 'open_page'),
          search('ws_3', 'completed', 'find_in_page'),
          search('ws_4', 'failed'),
          search('ws_5', 'searching'),
          messageItem,
        ],
      })
    );

    const res = await makeProvider().chat(ask, { model: 'gpt-5-mini', providerTools: SEARCH });

    expect(res.usage.webSearchRequests).toBe(2);
    expect(res.reasoning).toHaveLength(5);
  });

  it('leaves out a reasoning item with no encrypted content, which nothing could replay', async () => {
    responsesCreateMock.mockResolvedValue(
      makeResponse({ output: [{ ...reasoningItem, encrypted_content: null }, messageItem] })
    );

    const res = await makeProvider().chat(ask, { model: 'gpt-5-mini', providerTools: SEARCH });

    expect(res.reasoning).toBeUndefined();
  });

  it('reports a flex or priority tier, and no search count when none ran', async () => {
    responsesCreateMock.mockResolvedValue(
      makeResponse({ service_tier: 'flex', output: [messageItem] })
    );

    const res = await makeProvider().chat(ask, { model: 'gpt-5-mini', providerTools: SEARCH });

    expect(res.usage.serviceTier).toBe('flex');
    expect(res.usage).not.toHaveProperty('webSearchRequests');
  });

  it('reads an answer cut at max_output_tokens as length', async () => {
    responsesCreateMock.mockResolvedValue(
      makeResponse({
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [messageItem],
      })
    );

    const res = await makeProvider().chat(ask, { model: 'gpt-5-mini', providerTools: SEARCH });

    expect(res.finishReason).toBe('length');
  });

  it('raises a cap that reasoning spent entirely, with the usage billed', async () => {
    responsesCreateMock.mockResolvedValue(
      makeResponse({
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [reasoningItem],
      })
    );

    const err = await makeProvider()
      .chat(ask, { model: 'gpt-5-mini', providerTools: SEARCH })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({
      code: 'truncated_no_output',
      retriable: false,
      usage: { inputTokens: 8867, outputTokens: 297 },
    });
    expect((err as Error).message).toContain('Reasoning consumed 192 tokens of the 4096 budget');
  });

  it('raises a response OpenAI reports as failed', async () => {
    responsesCreateMock.mockResolvedValue(
      makeResponse({
        status: 'failed',
        error: { code: 'server_error', message: 'boom' },
        output: [],
      })
    );

    await expect(
      makeProvider().chat(ask, { model: 'gpt-5-mini', providerTools: SEARCH })
    ).rejects.toMatchObject({ message: 'boom', code: 'openai_server_error' });
  });

  it('wraps an SDK failure as a provider error with its status', async () => {
    responsesCreateMock.mockRejectedValue(
      Object.assign(new Error('400 Invalid domain'), { status: 400 })
    );

    await expect(
      makeProvider().chat(ask, { model: 'gpt-5-mini', providerTools: SEARCH })
    ).rejects.toMatchObject({ code: 'http_400', status: 400, retriable: false });
  });
});

// ---------------------------------------------------------------------------
// Stream mapping
// ---------------------------------------------------------------------------

describe('a Responses stream', () => {
  const streamOf = (events: unknown[]) =>
    responsesCreateMock.mockResolvedValue(toAsyncIterable(events));

  it('yields text and summary deltas as they come, then calls and done from the final response', async () => {
    streamOf([
      { type: 'response.created' },
      { type: 'response.reasoning_summary_part.added' },
      { type: 'response.reasoning_summary_text.delta', delta: 'Planning' },
      { type: 'response.reasoning_summary_text.delta', delta: ' a search' },
      { type: 'response.reasoning_summary_part.added' },
      { type: 'response.reasoning_summary_text.delta', delta: 'Found it' },
      { type: 'response.web_search_call.completed' },
      { type: 'response.output_text.delta', delta: 'Strikes are ' },
      { type: 'response.output_text.delta', delta: 'on Thursday.' },
      {
        type: 'response.completed',
        response: makeResponse({
          output: [reasoningItem, searchItem, messageItem, functionCallItem],
        }),
      },
    ]);

    const chunks = await collect(
      makeProvider().chatStream(ask, {
        model: 'gpt-5-mini',
        tools: [lookupTool],
        providerTools: SEARCH,
      })
    );

    expect(chunks).toEqual([
      { type: 'reasoning', text: 'Planning' },
      { type: 'reasoning', text: ' a search' },
      { type: 'reasoning', text: '\n\nFound it' },
      { type: 'text', content: 'Strikes are ' },
      { type: 'text', content: 'on Thursday.' },
      {
        type: 'tool_call',
        toolCall: { id: 'call_1', name: 'lookup_order', arguments: { id: '4471' } },
      },
      {
        type: 'done',
        finishReason: 'tool_use',
        usage: {
          inputTokens: 8867,
          outputTokens: 297,
          reasoningTokens: 192,
          cacheReadTokens: 4352,
          webSearchRequests: 1,
        },
        reasoning: [
          {
            type: 'openai_reasoning',
            id: 'rs_1',
            encryptedContent: 'enc-1',
            summary: ['**Planning** I need to search.'],
          },
          {
            type: 'openai_web_search_call',
            id: 'ws_1',
            status: 'completed',
            action: searchItem.action,
          },
        ],
      },
    ]);
  });

  it('starts a later message’s text as a new paragraph, as the result joins them', async () => {
    streamOf([
      { type: 'response.output_text.delta', item_id: 'msg_a', delta: 'Let me ' },
      { type: 'response.output_text.delta', item_id: 'msg_a', delta: 'look that up.' },
      { type: 'response.output_text.delta', item_id: 'msg_b', delta: 'Strikes are on Thursday.' },
      { type: 'response.completed', response: makeResponse() },
    ]);

    const chunks = await collect(
      makeProvider().chatStream(ask, { model: 'gpt-5-mini', providerTools: SEARCH })
    );

    expect(chunks.filter((c) => c.type === 'text')).toEqual([
      { type: 'text', content: 'Let me ' },
      { type: 'text', content: 'look that up.' },
      { type: 'text', content: '\n\nStrikes are on Thursday.' },
    ]);
  });

  it('ends an incomplete response as length', async () => {
    streamOf([
      {
        type: 'response.incomplete',
        response: makeResponse({
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          output: [messageItem],
        }),
      },
    ]);

    const chunks = await collect(
      makeProvider().chatStream(ask, { model: 'gpt-5-mini', providerTools: SEARCH })
    );

    expect(chunks.at(-1)).toMatchObject({ type: 'done', finishReason: 'length' });
  });

  it('raises a failed response with what it was billed', async () => {
    streamOf([
      { type: 'response.output_text.delta', delta: 'Part' },
      {
        type: 'response.failed',
        response: makeResponse({
          status: 'failed',
          error: { code: 'server_error', message: 'boom' },
        }),
      },
    ]);

    await expect(
      collect(makeProvider().chatStream(ask, { model: 'gpt-5-mini', providerTools: SEARCH }))
    ).rejects.toMatchObject({ message: 'boom', usage: { inputTokens: 8867, outputTokens: 297 } });
  });

  it('raises an error event', async () => {
    streamOf([{ type: 'error', code: 'rate_limit_exceeded', message: 'slow down' }]);

    await expect(
      collect(makeProvider().chatStream(ask, { model: 'gpt-5-mini', providerTools: SEARCH }))
    ).rejects.toMatchObject({ message: 'slow down', code: 'openai_rate_limit_exceeded' });
  });

  it('raises a stream that ends without a final response', async () => {
    streamOf([{ type: 'response.output_text.delta', delta: 'Part' }]);

    await expect(
      collect(makeProvider().chatStream(ask, { model: 'gpt-5-mini', providerTools: SEARCH }))
    ).rejects.toMatchObject({ code: 'empty_response' });
  });

  it('stops when the caller aborts', async () => {
    const controller = new AbortController();
    streamOf([
      { type: 'response.output_text.delta', delta: 'Part' },
      { type: 'response.output_text.delta', delta: ' two' },
    ]);
    const stream = makeProvider().chatStream(ask, {
      model: 'gpt-5-mini',
      providerTools: SEARCH,
      signal: controller.signal,
    });

    const seen: StreamChunk[] = [];
    const run = (async () => {
      for await (const chunk of stream) {
        seen.push(chunk);
        controller.abort();
      }
    })();

    await expect(run).rejects.toMatchObject({ code: 'aborted' });
    expect(seen).toEqual([{ type: 'text', content: 'Part' }]);
  });
});

// ---------------------------------------------------------------------------
// Reasoning summaries for an unverified organisation
// ---------------------------------------------------------------------------

describe('reasoning summaries refused to an unverified organisation', () => {
  const refusal = () =>
    Object.assign(
      new Error(
        '400 Your organization must be verified to generate reasoning summaries. Please go to: https://platform.openai.com/settings/organization/general'
      ),
      { status: 400 }
    );

  it('retries without summaries, then stops asking on that instance', async () => {
    responsesCreateMock.mockRejectedValueOnce(refusal()).mockResolvedValue(makeResponse());
    const provider = makeProvider();

    const res = await provider.chat(ask, { model: 'gpt-5-mini', providerTools: SEARCH });
    await provider.chat(ask, { model: 'gpt-5-mini', providerTools: SEARCH });

    expect(res.content).toBe('Strikes are on Thursday.');
    expect(responsesCreateMock).toHaveBeenCalledTimes(3);
    expect(sentParams(0).reasoning).toEqual({ summary: 'auto' });
    expect(sentParams(1)).not.toHaveProperty('reasoning');
    expect(sentParams(2)).not.toHaveProperty('reasoning');
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
  });

  it('does the same for a stream', async () => {
    responsesCreateMock
      .mockRejectedValueOnce(refusal())
      .mockResolvedValue(
        toAsyncIterable([{ type: 'response.completed', response: makeResponse() }])
      );

    const chunks = await collect(
      makeProvider().chatStream(ask, { model: 'gpt-5-mini', providerTools: SEARCH })
    );

    expect(chunks.at(-1)).toMatchObject({ type: 'done' });
    expect(sentParams(0).reasoning).toEqual({ summary: 'auto' });
    expect(sentParams(1)).not.toHaveProperty('reasoning');
  });

  it('keeps the effort when it drops the summary', async () => {
    responsesCreateMock.mockRejectedValueOnce(refusal()).mockResolvedValue(makeResponse());

    await makeProvider().chat(ask, {
      model: 'gpt-5-mini',
      reasoningEffort: 'low',
      providerTools: SEARCH,
    });

    expect(sentParams(1).reasoning).toEqual({ effort: 'low' });
  });

  it('does not retry any other 400', async () => {
    responsesCreateMock.mockRejectedValue(
      Object.assign(new Error('400 Invalid domain'), { status: 400 })
    );

    await expect(
      makeProvider().chat(ask, { model: 'gpt-5-mini', providerTools: SEARCH })
    ).rejects.toBeInstanceOf(ProviderError);
    expect(responsesCreateMock).toHaveBeenCalledTimes(1);
  });
});

describe('replayed reasoning OpenAI cannot decrypt (t-959)', () => {
  // As the SDK raises it (measured 2026-10-27): a 400 with this code.
  const undecryptable = () =>
    Object.assign(
      new Error(
        '400 The encrypted content for item rs_1 could not be verified. Reason: Encrypted content could not be decrypted or parsed.'
      ),
      { status: 400, code: 'invalid_encrypted_content' }
    );

  /** A turn that continues a reply which reasoned and searched. */
  const continuing: LlmMessage[] = [
    ...ask,
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_1', name: 'lookup_order', arguments: { id: '4471' } }],
      reasoning: [
        {
          type: 'openai_reasoning',
          id: 'rs_1',
          encryptedContent: 'enc-from-another-org',
          summary: [],
        },
        {
          type: 'openai_web_search_call',
          id: 'ws_1',
          status: 'completed',
          action: { type: 'search', queries: ['courier strike dates'] },
        },
      ],
    },
    { role: 'tool', toolCallId: 'call_1', content: 'dispatched Monday' },
  ];

  const inputTypes = (call: number) =>
    (sentParams(call).input as Array<{ type?: string; role?: string }>).map(
      (item) => item.type ?? item.role
    );

  it('retries once without the reasoning items, keeping the search items, and warns', async () => {
    responsesCreateMock.mockRejectedValueOnce(undecryptable()).mockResolvedValue(makeResponse());

    const res = await makeProvider().chat(continuing, {
      model: 'gpt-5-mini',
      providerTools: SEARCH,
    });

    expect(res.content).toBe('Strikes are on Thursday.');
    expect(responsesCreateMock).toHaveBeenCalledTimes(2);
    expect(inputTypes(0)).toEqual([
      'user',
      'reasoning',
      'web_search_call',
      'function_call',
      'function_call_output',
    ]);
    expect(inputTypes(1)).toEqual([
      'user',
      'web_search_call',
      'function_call',
      'function_call_output',
    ]);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'OpenAI could not decrypt replayed reasoning; retrying without it',
      {
        provider: 'openai',
        model: 'gpt-5-mini',
        items: 1,
        // OpenAI's own words, which name the item it couldn't verify.
        error: expect.stringContaining('could not be verified'),
      }
    );
  });

  it('leaves the items it was refused out of the next call up front, keeping the reply’s new reasoning', async () => {
    responsesCreateMock.mockRejectedValueOnce(undecryptable()).mockResolvedValue(makeResponse());
    const provider = makeProvider();
    await provider.chat(continuing, { model: 'gpt-5-mini', providerTools: SEARCH });

    // The tool loop's next call replays the refused item beside the
    // reasoning this credential has just returned.
    await provider.chat(
      [
        ...continuing,
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_2', name: 'lookup_order', arguments: { id: '4472' } }],
          reasoning: [
            { type: 'openai_reasoning', id: 'rs_2', encryptedContent: 'enc-own', summary: [] },
          ],
        },
        { role: 'tool', toolCallId: 'call_2', content: 'dispatched Tuesday' },
      ],
      { model: 'gpt-5-mini', providerTools: SEARCH }
    );

    // Two requests for the first call, one for the second: no refusal first.
    expect(responsesCreateMock).toHaveBeenCalledTimes(3);
    const ids = (sentParams(2).input as Array<{ type?: string; id?: string }>)
      .filter((item) => item.type === 'reasoning')
      .map((item) => item.id);
    expect(ids).toEqual(['rs_2']);
  });

  it('remembers refused items per provider instance, not across credentials', async () => {
    responsesCreateMock.mockRejectedValueOnce(undecryptable()).mockResolvedValue(makeResponse());
    await makeProvider().chat(continuing, { model: 'gpt-5-mini', providerTools: SEARCH });

    // Another instance (another credential) is sent the item as it is.
    await makeProvider().chat(continuing, { model: 'gpt-5-mini', providerTools: SEARCH });

    expect(inputTypes(2)).toContain('reasoning');
  });

  it('does the same for a stream, which is refused before its first event', async () => {
    responsesCreateMock
      .mockRejectedValueOnce(undecryptable())
      .mockResolvedValue(
        toAsyncIterable([{ type: 'response.completed', response: makeResponse() }])
      );

    const chunks = await collect(
      makeProvider().chatStream(continuing, { model: 'gpt-5-mini', providerTools: SEARCH })
    );

    expect(chunks.at(-1)).toMatchObject({ type: 'done' });
    expect(inputTypes(1)).not.toContain('reasoning');
    expect(inputTypes(1)).toContain('web_search_call');
  });

  it('raises a second refusal, without trying a third time', async () => {
    responsesCreateMock.mockRejectedValue(undecryptable());

    await expect(
      makeProvider().chat(continuing, { model: 'gpt-5-mini', providerTools: SEARCH })
    ).rejects.toBeInstanceOf(ProviderError);
    expect(responsesCreateMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry any other 400', async () => {
    responsesCreateMock.mockRejectedValue(
      Object.assign(new Error('400 Invalid domain'), { status: 400, code: 'invalid_value' })
    );

    await expect(
      makeProvider().chat(continuing, { model: 'gpt-5-mini', providerTools: SEARCH })
    ).rejects.toBeInstanceOf(ProviderError);
    expect(responsesCreateMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry when the request carried no reasoning to leave out', async () => {
    responsesCreateMock.mockRejectedValue(undecryptable());

    await expect(
      makeProvider().chat(ask, { model: 'gpt-5-mini', providerTools: SEARCH })
    ).rejects.toBeInstanceOf(ProviderError);
    expect(responsesCreateMock).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });
});
