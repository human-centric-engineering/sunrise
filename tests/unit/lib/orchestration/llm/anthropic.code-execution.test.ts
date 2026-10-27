/**
 * AnthropicProvider — code execution (t-956)
 *
 * An agent with `providerTools.codeExecution` on a Claude model that offers
 * it is sent Anthropic's `code_execution` tool. Covers:
 * - The request: the tool, the container a tool loop's later call reuses, and
 *   the requests that drop it (model, structured output)
 * - Mapping the `bash_code_execution` / `text_editor_code_execution` blocks,
 *   with each run's container and duration, streamed and not
 * - Replay of those blocks, a paused turn's container, and the billing of a
 *   call's runs against the reply's earlier ones
 * - The files a run made: named for the trace, and deleted from Anthropic's
 *   Files storage once a call ends the reply, never mid-reply
 *
 * Block shapes follow Anthropic's code execution doc and the SDK's types
 * (`@anthropic-ai/sdk` 0.137); no Anthropic key was available to measure.
 *
 * @see lib/orchestration/llm/anthropic.ts
 * @see lib/orchestration/llm/code-execution.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LlmMessage, LlmReasoningBlock, StreamChunk } from '@/lib/orchestration/llm/types';

const createMock = vi.fn();
const filesDeleteMock = vi.fn();
const filesMetadataMock = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    public messages = { create: createMock };
    public files = { delete: filesDeleteMock, retrieveMetadata: filesMetadataMock };
  }
  return { default: MockAnthropic };
});

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({ logger: loggerMock }));

const { AnthropicProvider } = await import('@/lib/orchestration/llm/anthropic');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeProvider() {
  return new AnthropicProvider({
    name: 'anthropic',
    type: 'anthropic',
    apiKey: 'test-key',
    isLocal: false,
  });
}

const MODEL = 'claude-sonnet-4-6';
const CODE = { codeExecution: {} };
const ask: LlmMessage[] = [{ role: 'user', content: 'Chart the order totals.' }];

const bashUse = {
  type: 'server_tool_use',
  id: 'srvtoolu_1',
  name: 'bash_code_execution',
  input: { command: 'python chart.py && cp chart.png "$OUTPUT_DIR/"' },
  caller: { type: 'direct' },
};
const bashResult = {
  type: 'bash_code_execution_tool_result',
  tool_use_id: 'srvtoolu_1',
  content: {
    type: 'bash_code_execution_result',
    stdout: 'saved',
    stderr: '',
    return_code: 0,
    content: [{ type: 'bash_code_execution_output', file_id: 'file_1' }],
  },
};
const editorUse = {
  type: 'server_tool_use',
  id: 'srvtoolu_2',
  name: 'text_editor_code_execution',
  input: { command: 'create', path: 'chart.py', file_text: 'print(1)' },
  caller: { type: 'direct' },
};
const editorResult = {
  type: 'text_editor_code_execution_tool_result',
  tool_use_id: 'srvtoolu_2',
  content: { type: 'text_editor_code_execution_create_result', is_file_update: false },
};
const container = { id: 'container_1', expires_at: '2026-10-27T20:00:00Z', skills: null };

function message(
  content: object[],
  stopReason = 'end_turn',
  usage: object = { input_tokens: 10, output_tokens: 5 }
) {
  return { content, usage, model: MODEL, stop_reason: stopReason, container };
}

/** The bash run as its replayable block, once named. */
const bashBlock: LlmReasoningBlock = {
  type: 'code_execution_tool_result',
  tool: 'bash',
  toolUseId: 'srvtoolu_1',
  content: {
    type: 'bash_code_execution_result',
    stdout: 'saved',
    stderr: '',
    return_code: 0,
    content: [{ type: 'bash_code_execution_output', file_id: 'file_1' }],
  },
  containerId: 'container_1',
  durationMs: 3000,
  fileNames: ['chart.png'],
};

/** Each request's params, cloned when sent, with a response per request. */
function respondInTurn(...responses: (() => unknown)[]): Record<string, any>[] {
  const sent: Record<string, any>[] = [];
  createMock.mockImplementation((params: unknown) => {
    sent.push(structuredClone(params) as Record<string, any>);
    now += 3_000;
    return Promise.resolve(responses[Math.min(sent.length, responses.length) - 1]());
  });
  return sent;
}

/** Let the fire-and-forget deletes settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let now = 0;

beforeEach(() => {
  createMock.mockReset();
  filesDeleteMock.mockReset().mockResolvedValue({ id: 'file_1', type: 'file_deleted' });
  filesMetadataMock.mockReset().mockResolvedValue({ id: 'file_1', filename: 'chart.png' });
  Object.values(loggerMock).forEach((fn) => fn.mockClear());
  now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

describe('the code execution request', () => {
  it('sends the code execution tool beside the agent’s tools', async () => {
    const sent = respondInTurn(() => message([{ type: 'text', text: 'Hi' }]));

    await makeProvider().chat(ask, {
      model: MODEL,
      providerTools: CODE,
      tools: [{ name: 'lookup', description: 'Look up', parameters: { type: 'object' } }],
    });

    expect(sent[0].tools.map((tool: { name: string }) => tool.name)).toEqual([
      'lookup',
      'code_execution',
    ]);
    expect(sent[0].tools[1]).toEqual({ type: 'code_execution_20250825', name: 'code_execution' });
    expect(sent[0]).not.toHaveProperty('container');
  });

  it('runs a later call of the reply in the container its earlier runs used', async () => {
    const sent = respondInTurn(() => message([{ type: 'text', text: 'Done' }]));

    await makeProvider().chat(
      [...ask, { role: 'assistant', content: '', reasoning: [bashBlock] }],
      { model: MODEL, providerTools: CODE }
    );

    expect(sent[0].container).toBe('container_1');
  });

  it.each(['claude-3-5-sonnet-20241022', 'claude-opus-4-1', 'claude-sonnet-4-0'])(
    'drops the tool on %s, which does not offer it, and logs why',
    async (model) => {
      const sent = respondInTurn(() => message([{ type: 'text', text: 'Hi' }]));

      await makeProvider().chat(ask, { model, providerTools: CODE });

      expect(sent[0]).not.toHaveProperty('tools');
      expect(loggerMock.info).toHaveBeenCalledWith(
        'Anthropic: code execution dropped, model does not offer it',
        expect.objectContaining({ model })
      );
    }
  );

  it('drops the tool on a structured-output request', async () => {
    const sent = respondInTurn(() => message([{ type: 'text', text: '{"a":1}' }]));

    await makeProvider().chat(ask, {
      model: MODEL,
      providerTools: CODE,
      responseFormat: { type: 'json_object' },
    });

    expect(JSON.stringify(sent[0].tools ?? [])).not.toContain('code_execution');
    expect(loggerMock.info).toHaveBeenCalledWith(
      'Anthropic: code execution dropped, request wants structured output',
      expect.anything()
    );
  });
});

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

describe('a code execution response', () => {
  it('maps each run with its container and a share of the request time', async () => {
    respondInTurn(() =>
      message([editorUse, editorResult, bashUse, bashResult, { type: 'text', text: 'Charted.' }])
    );

    const res = await makeProvider().chat(ask, { model: MODEL, providerTools: CODE });

    expect(res.content).toBe('Charted.');
    expect(res.reasoning).toEqual([
      {
        type: 'server_tool_use',
        id: 'srvtoolu_2',
        name: 'text_editor_code_execution',
        input: { command: 'create', path: 'chart.py', file_text: 'print(1)' },
      },
      {
        type: 'code_execution_tool_result',
        tool: 'text_editor',
        toolUseId: 'srvtoolu_2',
        content: { type: 'text_editor_code_execution_create_result', is_file_update: false },
        containerId: 'container_1',
        durationMs: 1500,
      },
      {
        type: 'server_tool_use',
        id: 'srvtoolu_1',
        name: 'bash_code_execution',
        input: { command: 'python chart.py && cp chart.png "$OUTPUT_DIR/"' },
      },
      { ...bashBlock, durationMs: 1500 },
    ]);
  });

  it('bills a new container its 5-minute minimum at Anthropic’s rate', async () => {
    respondInTurn(() => message([bashUse, bashResult]));

    const res = await makeProvider().chat(ask, { model: MODEL, providerTools: CODE });

    expect(res.usage.codeExecution).toEqual({ runs: 1, billedSeconds: 300, usdPerHour: 0.05 });
  });

  it('bills only what a later call adds to the reply’s container', async () => {
    respondInTurn(() => message([bashUse, bashResult]));

    const res = await makeProvider().chat(
      [
        ...ask,
        { role: 'assistant', content: '', reasoning: [{ ...bashBlock, durationMs: 299_000 }] },
      ],
      { model: MODEL, providerTools: CODE }
    );

    // 299 s before + 3 s now: 2 s past the minimum already billed.
    expect(res.usage.codeExecution).toEqual({ runs: 1, billedSeconds: 2, usdPerHour: 0.05 });
  });

  it('maps a run’s error and keeps its code', async () => {
    respondInTurn(() =>
      message([
        bashUse,
        {
          type: 'bash_code_execution_tool_result',
          tool_use_id: 'srvtoolu_1',
          content: { type: 'bash_code_execution_tool_result_error', error_code: 'unavailable' },
        },
      ])
    );

    const res = await makeProvider().chat(ask, { model: MODEL, providerTools: CODE });

    expect(res.reasoning?.[1]).toEqual(
      expect.objectContaining({
        type: 'code_execution_tool_result',
        content: { type: 'bash_code_execution_tool_result_error', error_code: 'unavailable' },
      })
    );
    expect(filesMetadataMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

describe('the files a run makes', () => {
  it('names them for the trace, then deletes them when the call ends the reply', async () => {
    respondInTurn(() => message([bashUse, bashResult, { type: 'text', text: 'Charted.' }]));

    const res = await makeProvider().chat(ask, { model: MODEL, providerTools: CODE });
    await settle();

    expect(filesMetadataMock).toHaveBeenCalledWith('file_1');
    expect(res.reasoning?.[1]).toEqual(expect.objectContaining({ fileNames: ['chart.png'] }));
    expect(filesDeleteMock).toHaveBeenCalledWith('file_1');
    expect(loggerMock.info).toHaveBeenCalledWith(
      'Anthropic: generated files deleted',
      expect.objectContaining({ count: 1 })
    );
  });

  it('keeps them while the reply goes on to a tool call, for the next call to replay', async () => {
    respondInTurn(() =>
      message(
        [bashUse, bashResult, { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} }],
        'tool_use'
      )
    );

    const res = await makeProvider().chat(ask, { model: MODEL, providerTools: CODE });
    await settle();

    expect(res.finishReason).toBe('tool_use');
    expect(filesDeleteMock).not.toHaveBeenCalled();
  });

  it('deletes the files of the reply’s earlier calls with its own, once the reply ends', async () => {
    respondInTurn(() => message([{ type: 'text', text: 'All done.' }]));

    await makeProvider().chat(
      [...ask, { role: 'assistant', content: '', reasoning: [bashBlock] }],
      {
        model: MODEL,
        providerTools: CODE,
      }
    );
    await settle();

    expect(filesDeleteMock).toHaveBeenCalledWith('file_1');
    // Named on the call that made it, not again.
    expect(filesMetadataMock).not.toHaveBeenCalled();
  });

  it('keeps the id when a name can’t be read, and logs a delete that fails', async () => {
    filesMetadataMock.mockRejectedValue(new Error('not found'));
    filesDeleteMock.mockRejectedValue(new Error('forbidden'));
    respondInTurn(() => message([bashUse, bashResult]));

    const res = await makeProvider().chat(ask, { model: MODEL, providerTools: CODE });
    await settle();

    expect(res.reasoning?.[1]).toEqual(expect.objectContaining({ fileNames: ['file_1'] }));
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'Anthropic: generated file name not read',
      expect.objectContaining({ fileId: 'file_1', error: 'not found' })
    );
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'Anthropic: generated files not deleted',
      expect.objectContaining({ failed: 1, total: 1 })
    );
  });
});

// ---------------------------------------------------------------------------
// Replay and paused turns
// ---------------------------------------------------------------------------

describe('replaying code runs', () => {
  it('sends each run back in Anthropic’s shape, without what Sunrise added', async () => {
    const sent = respondInTurn(() => message([{ type: 'text', text: 'Done' }]));
    const editorError: LlmReasoningBlock = {
      type: 'code_execution_tool_result',
      tool: 'text_editor',
      toolUseId: 'srvtoolu_3',
      content: {
        type: 'text_editor_code_execution_tool_result_error',
        error_code: 'file_not_found',
        error_message: 'no such file',
      },
      containerId: 'container_1',
      durationMs: 10,
    };

    await makeProvider().chat(
      [
        ...ask,
        {
          role: 'assistant',
          content: '',
          reasoning: [
            {
              type: 'server_tool_use',
              id: 'srvtoolu_1',
              name: 'bash_code_execution',
              input: { command: 'ls' },
            },
            bashBlock,
            editorError,
          ],
        },
        // Not the last turn, so the prompt-cache mark lands elsewhere.
        { role: 'user', content: 'And the table?' },
      ],
      { model: MODEL, providerTools: CODE }
    );

    expect(sent[0].messages[1].content).toEqual([
      {
        type: 'server_tool_use',
        id: 'srvtoolu_1',
        name: 'bash_code_execution',
        input: { command: 'ls' },
      },
      bashResult,
      {
        type: 'text_editor_code_execution_tool_result',
        tool_use_id: 'srvtoolu_3',
        content: {
          type: 'text_editor_code_execution_tool_result_error',
          error_code: 'file_not_found',
          error_message: 'no such file',
        },
      },
    ]);
  });

  it('sends a stored error code Anthropic no longer has as unavailable', async () => {
    const sent = respondInTurn(() => message([{ type: 'text', text: 'Done' }]));

    await makeProvider().chat(
      [
        ...ask,
        {
          role: 'assistant',
          content: '',
          reasoning: [
            {
              type: 'code_execution_tool_result',
              tool: 'bash',
              toolUseId: 'srvtoolu_1',
              content: {
                type: 'bash_code_execution_tool_result_error',
                error_code: 'retired_code',
              },
              containerId: 'container_1',
              durationMs: 0,
            },
          ],
        },
      ],
      { model: MODEL, providerTools: CODE }
    );

    expect(sent[0].messages[1].content[0].content).toEqual({
      type: 'bash_code_execution_tool_result_error',
      error_code: 'unavailable',
    });
  });

  it('carries a paused turn on in the container it started in', async () => {
    const sent = respondInTurn(
      () => message([bashUse, bashResult], 'pause_turn'),
      () => message([{ type: 'text', text: 'Charted.' }])
    );

    const res = await makeProvider().chat(ask, { model: MODEL, providerTools: CODE });

    expect(sent).toHaveLength(2);
    expect(sent[0]).not.toHaveProperty('container');
    expect(sent[1].container).toBe('container_1');
    expect(sent[1].messages[1].content).toEqual([
      {
        type: 'server_tool_use',
        id: 'srvtoolu_1',
        name: 'bash_code_execution',
        input: bashUse.input,
      },
      bashResult,
    ]);
    // The run took the first segment's whole request time.
    expect(res.reasoning?.[1]).toEqual(expect.objectContaining({ durationMs: 3000 }));
    expect(res.usage.codeExecution).toEqual({ runs: 1, billedSeconds: 300, usdPerHour: 0.05 });
  });
});

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

describe('a streamed code execution response', () => {
  /** Stream `events`, moving the clock by each one's `advance` first. */
  function streamOf(events: Array<{ advance?: number; event: object }>) {
    return async function* () {
      for (const { advance, event } of events) {
        now += advance ?? 0;
        yield event;
      }
    };
  }

  const streamedRun = [
    {
      event: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
    },
    {
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'server_tool_use',
          id: 'srvtoolu_1',
          name: 'bash_code_execution',
          input: {},
        },
      },
    },
    {
      advance: 400,
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"command":"python chart.py"}' },
      },
    },
    { event: { type: 'content_block_stop', index: 0 } },
    // The run: from the call's input ending to its result arriving.
    { advance: 4_200, event: { type: 'content_block_start', index: 1, content_block: bashResult } },
    { event: { type: 'content_block_stop', index: 1 } },
  ];

  async function run(
    events: Array<{ advance?: number; event: object }>,
    messages: LlmMessage[] = ask
  ): Promise<StreamChunk[]> {
    createMock.mockImplementation(() => Promise.resolve(streamOf(events)()));
    const chunks: StreamChunk[] = [];
    for await (const chunk of makeProvider().chatStream(messages, {
      model: MODEL,
      providerTools: CODE,
    })) {
      chunks.push(chunk);
    }
    return chunks;
  }

  it('times the run, takes the container from the message, and bills it', async () => {
    const chunks = await run([
      ...streamedRun,
      {
        event: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', container },
          usage: { output_tokens: 7 },
        },
      },
    ]);
    await settle();

    // The run's input never surfaces as a tool call the dispatcher would run.
    expect(chunks.filter((chunk) => chunk.type === 'tool_call')).toEqual([]);
    const done = chunks.at(-1);
    if (done?.type !== 'done') throw new Error('no done chunk');
    expect(done.reasoning).toEqual([
      {
        type: 'server_tool_use',
        id: 'srvtoolu_1',
        name: 'bash_code_execution',
        input: { command: 'python chart.py' },
      },
      { ...bashBlock, durationMs: 4200 },
    ]);
    expect(done.usage.codeExecution).toEqual({ runs: 1, billedSeconds: 300, usdPerHour: 0.05 });
    expect(filesDeleteMock).toHaveBeenCalledWith('file_1');
  });

  it('takes the container the request named when the message reports none', async () => {
    const chunks = await run(
      [
        ...streamedRun,
        {
          event: {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { output_tokens: 7 },
          },
        },
      ],
      [
        ...ask,
        { role: 'assistant', content: '', reasoning: [{ ...bashBlock, toolUseId: 'srvtoolu_0' }] },
      ]
    );
    await settle();

    const done = chunks.at(-1);
    if (done?.type !== 'done') throw new Error('no done chunk');
    expect(done.reasoning?.[1]).toEqual(expect.objectContaining({ containerId: 'container_1' }));
    // Same container as the earlier 3 s run: 3 s + 4.2 s is still under the minimum.
    expect(done.usage.codeExecution).toEqual({ runs: 1, billedSeconds: 0, usdPerHour: 0.05 });
    // The reply goes on to a tool call: nothing deleted yet.
    expect(filesDeleteMock).not.toHaveBeenCalled();
  });

  it('carries a paused stream on in the container it started in', async () => {
    const sent: Record<string, any>[] = [];
    const segments = [
      streamOf([
        ...streamedRun,
        {
          event: {
            type: 'message_delta',
            delta: { stop_reason: 'pause_turn', container },
            usage: { output_tokens: 7 },
          },
        },
      ]),
      streamOf([
        {
          event: {
            type: 'message_start',
            message: { usage: { input_tokens: 20, output_tokens: 0 } },
          },
        },
        {
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          },
        },
        {
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Done.' },
          },
        },
        { event: { type: 'content_block_stop', index: 0 } },
        {
          event: {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 2 },
          },
        },
      ]),
    ];
    createMock.mockImplementation((params: unknown) => {
      sent.push(structuredClone(params) as Record<string, any>);
      return Promise.resolve(segments[sent.length - 1]());
    });

    for await (const _chunk of makeProvider().chatStream(ask, {
      model: MODEL,
      providerTools: CODE,
    })) {
      // drain
    }

    expect(sent).toHaveLength(2);
    expect(sent[1].container).toBe('container_1');
  });
});
