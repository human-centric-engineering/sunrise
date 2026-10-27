/**
 * OpenAiCompatibleProvider — code interpreter on the Responses API path (t-956)
 *
 * An agent on OpenAI itself with code execution on takes the Responses path,
 * as web search does. Covers:
 * - The routing rule: code interpreter on its own, beside web search, and the
 *   requests that drop it (model, minimal effort, structured output)
 * - The tool, its `include`, and the search limit beside it
 * - Replay of a `code_interpreter_call` item across a tool loop
 * - Mapping: the block, the cited file names, run timing (streamed and not)
 *   and the per-container billing against earlier runs
 *
 * Fixtures are shaped on live gpt-4o-mini / gpt-5-mini responses (2026-10-27).
 *
 * @see lib/orchestration/llm/openai-responses.ts
 * @see lib/orchestration/llm/code-execution.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  LlmMessage,
  LlmOptions,
  LlmReasoningBlock,
  StreamChunk,
} from '@/lib/orchestration/llm/types';

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeProvider(baseUrl = 'https://api.openai.com/v1') {
  return new OpenAiCompatibleProvider({ name: 'openai', baseUrl, apiKey: 'k', isLocal: false });
}

const CODE: LlmOptions['providerTools'] = { codeExecution: {} };
const ask: LlmMessage[] = [{ role: 'user', content: 'What is 37 * 19.99, with VAT?' }];

const codeItem = {
  type: 'code_interpreter_call',
  id: 'ci_1',
  status: 'completed',
  container_id: 'cntr_1',
  code: 'print(37 * 19.99 * 1.2)',
  outputs: [{ type: 'logs', logs: '887.556' }],
};
const messageItem = {
  type: 'message',
  id: 'msg_1',
  role: 'assistant',
  status: 'completed',
  content: [
    {
      type: 'output_text',
      text: 'The total is $887.56. [Download](sandbox:/mnt/data/order.csv)',
      annotations: [
        {
          type: 'container_file_citation',
          container_id: 'cntr_1',
          file_id: 'cfile_1',
          filename: 'order.csv',
          start_index: 21,
          end_index: 60,
        },
      ],
    },
  ],
};

function makeResponse(output: unknown[] = [codeItem, messageItem]) {
  return {
    id: 'resp_1',
    model: 'gpt-4o-mini-2024-07-18',
    status: 'completed',
    incomplete_details: null,
    error: null,
    max_output_tokens: 4096,
    service_tier: 'default',
    output,
    usage: {
      input_tokens: 615,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 357,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 972,
    },
  };
}

/** A code run the reply made on an earlier call, as its block carries it. */
function earlierRun(containerId: string, durationMs: number): LlmReasoningBlock {
  return {
    type: 'openai_code_interpreter_call',
    id: 'ci_0',
    status: 'completed',
    containerId,
    code: 'x = 1',
    outputs: [],
    durationMs,
  };
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function sentParams(call = 0): Record<string, unknown> {
  return responsesCreateMock.mock.calls[call][0] as Record<string, unknown>;
}

// A clock the mocked API moves on, so run times are exact.
let now = 0;

beforeEach(() => {
  chatCreateMock.mockReset();
  responsesCreateMock.mockReset();
  Object.values(loggerMock).forEach((fn) => fn.mockClear());
  now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  chatCreateMock.mockResolvedValue({
    model: 'gpt-4o-mini',
    choices: [{ message: { content: 'chat completions' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
  responsesCreateMock.mockImplementation(() => {
    now += 6_000;
    return Promise.resolve(makeResponse());
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

describe('which API a code execution request takes', () => {
  it('takes the Responses API for OpenAI itself with code execution on', async () => {
    await makeProvider().chat(ask, { model: 'gpt-4o-mini', providerTools: CODE });

    expect(responsesCreateMock).toHaveBeenCalledTimes(1);
    expect(chatCreateMock).not.toHaveBeenCalled();
  });

  it('stays on Chat Completions on another OpenAI-compatible host, sending no tool', async () => {
    await makeProvider('https://api.groq.com/openai/v1').chat(ask, {
      model: 'gpt-4o-mini',
      providerTools: CODE,
    });

    expect(responsesCreateMock).not.toHaveBeenCalled();
    expect(JSON.stringify(chatCreateMock.mock.calls[0][0])).not.toContain('code_interpreter');
  });

  it('stays on Chat Completions for structured output', async () => {
    await makeProvider().chat(ask, {
      model: 'gpt-4o-mini',
      providerTools: CODE,
      responseFormat: { type: 'json_object' },
    });

    expect(responsesCreateMock).not.toHaveBeenCalled();
  });

  it.each(['o3-mini', 'gpt-3.5-turbo', 'gpt-4o-mini-search-preview'])(
    'stays on Chat Completions on %s, which has no code interpreter, and logs the drop',
    async (model) => {
      await makeProvider().chat(ask, { model, providerTools: CODE });

      expect(responsesCreateMock).not.toHaveBeenCalled();
      expect(loggerMock.info).toHaveBeenCalledWith(
        'OpenAI: code interpreter dropped, the request cannot take it',
        expect.objectContaining({ model, reason: 'model' })
      );
    }
  );

  it('stays on Chat Completions at minimal effort on GPT-5, which refuses it there', async () => {
    await makeProvider().chat(ask, {
      model: 'gpt-5-mini',
      reasoningEffort: 'minimal',
      providerTools: CODE,
    });

    expect(responsesCreateMock).not.toHaveBeenCalled();
    expect(loggerMock.info).toHaveBeenCalledWith(
      'OpenAI: code interpreter dropped, the request cannot take it',
      expect.objectContaining({ reason: 'minimal_effort' })
    );
  });

  it('runs code alone when the site list keeps search off, and logs the search it dropped', async () => {
    await makeProvider().chat(ask, {
      model: 'gpt-4o-mini',
      providerTools: { codeExecution: {}, webSearch: { allowedDomains: ['example.com'] } },
    });

    const params = sentParams();
    expect(params.tools).toEqual([
      {
        type: 'code_interpreter',
        container: { type: 'auto', network_policy: { type: 'disabled' } },
      },
    ]);
    expect(params.include).toEqual(['code_interpreter_call.outputs']);
    expect(loggerMock.info).toHaveBeenCalledWith(
      'OpenAI: web search dropped, the request cannot take it',
      expect.objectContaining({ reason: 'site_filters' })
    );
    expect(loggerMock.info).not.toHaveBeenCalledWith(
      'OpenAI: code interpreter dropped, the request cannot take it',
      expect.anything()
    );
  });
});

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

describe('the code interpreter request', () => {
  it('sends a no-network auto container and asks for the run outputs', async () => {
    await makeProvider().chat(ask, { model: 'gpt-4o-mini', providerTools: CODE });

    const params = sentParams();
    expect(params.tools).toEqual([
      {
        type: 'code_interpreter',
        container: { type: 'auto', network_policy: { type: 'disabled' } },
      },
    ]);
    expect(params.include).toEqual(['code_interpreter_call.outputs']);
    expect(params).not.toHaveProperty('max_tool_calls');
  });

  it('sends both tools, without the search limit, which would cap the code runs too', async () => {
    await makeProvider().chat(ask, {
      model: 'gpt-5-mini',
      providerTools: { codeExecution: {}, webSearch: { maxUses: 2 } },
    });

    const params = sentParams();
    expect((params.tools as Array<{ type: string }>).map((tool) => tool.type)).toEqual([
      'web_search',
      'code_interpreter',
    ]);
    expect(params.include).toEqual([
      'web_search_call.action.sources',
      'code_interpreter_call.outputs',
      'reasoning.encrypted_content',
    ]);
    expect(params).not.toHaveProperty('max_tool_calls');
  });

  it('replays a code item on the call that continues the turn, so its container is reused', async () => {
    await makeProvider().chat(
      [
        ...ask,
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_1', name: 'get_discount', arguments: { customer: 'ACME' } }],
          reasoning: [
            {
              type: 'openai_code_interpreter_call',
              id: 'ci_1',
              status: 'completed',
              containerId: 'cntr_1',
              code: 'subtotal = 739.63',
              outputs: [{ type: 'logs', logs: '739.63' }],
              durationMs: 700,
              fileNames: ['sub.txt'],
            },
          ],
        },
        { role: 'tool', toolCallId: 'call_1', content: '0.15' },
      ],
      { model: 'gpt-4o-mini', providerTools: CODE }
    );

    expect(sentParams().input).toEqual([
      { role: 'user', content: 'What is 37 * 19.99, with VAT?' },
      {
        type: 'code_interpreter_call',
        id: 'ci_1',
        status: 'completed',
        container_id: 'cntr_1',
        code: 'subtotal = 739.63',
        outputs: [{ type: 'logs', logs: '739.63' }],
      },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'get_discount',
        arguments: '{"customer":"ACME"}',
      },
      { type: 'function_call_output', call_id: 'call_1', output: '0.15' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Mapping and billing
// ---------------------------------------------------------------------------

describe('a code interpreter result', () => {
  it('maps the run, with the file the reply cites, timed by the request', async () => {
    const res = await makeProvider().chat(ask, { model: 'gpt-4o-mini', providerTools: CODE });

    expect(res.reasoning).toEqual([
      {
        type: 'openai_code_interpreter_call',
        id: 'ci_1',
        status: 'completed',
        containerId: 'cntr_1',
        code: 'print(37 * 19.99 * 1.2)',
        outputs: [{ type: 'logs', logs: '887.556' }],
        durationMs: 6000,
        fileNames: ['order.csv'],
      },
    ]);
  });

  it('bills a new container its 5-minute minimum, at OpenAI’s rate', async () => {
    const res = await makeProvider().chat(ask, { model: 'gpt-4o-mini', providerTools: CODE });

    expect(res.usage.codeExecution).toEqual({ runs: 1, billedSeconds: 300, usdPerHour: 0.09 });
  });

  it('bills nothing more for a container the reply already ran code in, while under the minimum', async () => {
    const res = await makeProvider().chat(
      [...ask, { role: 'assistant', content: '', reasoning: [earlierRun('cntr_1', 60_000)] }],
      { model: 'gpt-4o-mini', providerTools: CODE }
    );

    expect(res.usage.codeExecution).toEqual({ runs: 1, billedSeconds: 0, usdPerHour: 0.09 });
  });

  it('bills the run time past the minimum for a container that has used it up', async () => {
    const res = await makeProvider().chat(
      [...ask, { role: 'assistant', content: '', reasoning: [earlierRun('cntr_1', 298_000)] }],
      { model: 'gpt-4o-mini', providerTools: CODE }
    );

    // 298 s before + 6 s now: 4 s past the 300 s already billed.
    expect(res.usage.codeExecution).toEqual({ runs: 1, billedSeconds: 4, usdPerHour: 0.09 });
  });

  it('shares the request time between the runs of a call that was not streamed', async () => {
    responsesCreateMock.mockImplementation(() => {
      now += 9_000;
      return Promise.resolve(
        makeResponse([codeItem, { ...codeItem, id: 'ci_2', container_id: 'cntr_1' }, messageItem])
      );
    });

    const res = await makeProvider().chat(ask, { model: 'gpt-4o-mini', providerTools: CODE });

    const runs = (res.reasoning ?? []).filter(
      (block) => block.type === 'openai_code_interpreter_call'
    );
    expect(runs.map((run) => run.durationMs)).toEqual([4500, 4500]);
    // Cited files go on the container's last run only.
    expect(runs.map((run) => run.fileNames)).toEqual([undefined, ['order.csv']]);
    expect(res.usage.codeExecution).toEqual({ runs: 2, billedSeconds: 300, usdPerHour: 0.09 });
  });

  it('runs no code and adds no code usage on a response without a run', async () => {
    responsesCreateMock.mockResolvedValue(makeResponse([messageItem]));

    const res = await makeProvider().chat(ask, { model: 'gpt-4o-mini', providerTools: CODE });

    expect(res.usage).not.toHaveProperty('codeExecution');
    expect(res.reasoning).toBeUndefined();
  });
});

describe('a code interpreter stream', () => {
  /** Stream `events`, moving the clock by each one's `advance` first. */
  function streamOf(events: Array<{ advance?: number; event: unknown }>) {
    responsesCreateMock.mockImplementation(() =>
      Promise.resolve(
        (async function* () {
          for (const { advance, event } of events) {
            now += advance ?? 0;
            yield event;
          }
        })()
      )
    );
  }

  it('times each run from when its code starts running to when it completes', async () => {
    streamOf([
      { event: { type: 'response.code_interpreter_call.in_progress', item_id: 'ci_1' } },
      // Writing the code isn't the container's time.
      {
        advance: 900,
        event: { type: 'response.code_interpreter_call.interpreting', item_id: 'ci_1' },
      },
      {
        advance: 3_500,
        event: { type: 'response.code_interpreter_call.completed', item_id: 'ci_1' },
      },
      {
        advance: 50,
        event: { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Done.' },
      },
      { event: { type: 'response.completed', response: makeResponse() } },
    ]);

    const chunks = await collect(
      makeProvider().chatStream(ask, { model: 'gpt-4o-mini', providerTools: CODE })
    );

    const done = chunks.at(-1);
    expect(done?.type).toBe('done');
    if (done?.type !== 'done') return;
    expect(done.reasoning).toEqual([
      expect.objectContaining({
        type: 'openai_code_interpreter_call',
        id: 'ci_1',
        durationMs: 3500,
      }),
    ]);
    expect(done.usage.codeExecution).toEqual({ runs: 1, billedSeconds: 300, usdPerHour: 0.09 });
  });

  it('falls back to the in-progress event when no interpreting event came', async () => {
    streamOf([
      { event: { type: 'response.code_interpreter_call.in_progress', item_id: 'ci_1' } },
      {
        advance: 1_200,
        event: { type: 'response.code_interpreter_call.completed', item_id: 'ci_1' },
      },
      { event: { type: 'response.completed', response: makeResponse() } },
    ]);

    const chunks = await collect(
      makeProvider().chatStream(ask, { model: 'gpt-4o-mini', providerTools: CODE })
    );

    const done = chunks.at(-1);
    if (done?.type !== 'done') throw new Error('no done chunk');
    expect(done.reasoning?.[0]).toEqual(expect.objectContaining({ durationMs: 1200 }));
  });

  it('bills a streamed run against the reply’s earlier runs in the same container', async () => {
    streamOf([
      { event: { type: 'response.code_interpreter_call.interpreting', item_id: 'ci_1' } },
      {
        advance: 10_000,
        event: { type: 'response.code_interpreter_call.completed', item_id: 'ci_1' },
      },
      { event: { type: 'response.completed', response: makeResponse() } },
    ]);

    const chunks = await collect(
      makeProvider().chatStream(
        [...ask, { role: 'assistant', content: '', reasoning: [earlierRun('cntr_1', 295_000)] }],
        { model: 'gpt-4o-mini', providerTools: CODE }
      )
    );

    const done = chunks.at(-1);
    if (done?.type !== 'done') throw new Error('no done chunk');
    // 295 s before + 10 s now: 5 s past the minimum already billed.
    expect(done.usage.codeExecution).toEqual({ runs: 1, billedSeconds: 5, usdPerHour: 0.09 });
  });
});
