/**
 * Tests for the trace entries of a provider's own web searches.
 */

import { describe, expect, it } from 'vitest';

import {
  PROVIDER_CODE_EXECUTION_SLUG,
  PROVIDER_WEB_SEARCH_SLUG,
  fitToolCallTraces,
  providerToolTraces,
} from '@/lib/orchestration/chat/provider-tool-traces';
import type { ToolCallTrace } from '@/types/orchestration';
import {
  WEB_SEARCH_USD_PER_REQUEST,
  type AnthropicCodeExecutionContent,
  type LlmReasoningBlock,
} from '@/lib/orchestration/llm/types';

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

describe('providerToolTraces — Anthropic code execution (t-956)', () => {
  const codeUse = (
    id: string,
    name: 'bash_code_execution' | 'text_editor_code_execution',
    input: Record<string, unknown> = { command: 'ls' }
  ): LlmReasoningBlock => ({ type: 'server_tool_use', id, name, input });

  const codeResult = (
    toolUseId: string,
    content: AnthropicCodeExecutionContent,
    extra: { durationMs?: number; fileNames?: string[]; tool?: 'bash' | 'text_editor' } = {}
  ): LlmReasoningBlock => ({
    type: 'code_execution_tool_result',
    tool: extra.tool ?? 'bash',
    toolUseId,
    content,
    containerId: 'c1',
    durationMs: extra.durationMs ?? 0,
    ...(extra.fileNames ? { fileNames: extra.fileNames } : {}),
  });

  const bash = (
    over: Partial<Extract<AnthropicCodeExecutionContent, { type: 'bash_code_execution_result' }>>
  ): AnthropicCodeExecutionContent => ({
    type: 'bash_code_execution_result',
    stdout: '',
    stderr: '',
    return_code: 0,
    content: [],
    ...over,
  });

  it('reads a clean exit as success, with stdout then stderr as the preview', () => {
    const traces = providerToolTraces([
      codeUse('t1', 'bash_code_execution', { command: 'echo hi' }),
      codeResult('t1', bash({ stdout: 'hi', stderr: 'warn' }), { durationMs: 1500 }),
    ]);
    expect(traces).toEqual([
      {
        slug: PROVIDER_CODE_EXECUTION_SLUG,
        arguments: { command: 'echo hi' },
        latencyMs: 1500,
        success: true,
        resultPreview: 'hi\nwarn',
      },
    ]);
    expect(PROVIDER_CODE_EXECUTION_SLUG).toBe('provider:code_execution');
  });

  it('has no preview and no error code for a silent clean exit', () => {
    const [trace] = providerToolTraces([
      codeUse('t1', 'bash_code_execution'),
      codeResult('t1', bash({})),
    ]);
    expect(trace.success).toBe(true);
    expect(trace).not.toHaveProperty('resultPreview');
    expect(trace).not.toHaveProperty('errorCode');
  });

  it('reads a non-zero exit as failed with exit_N, keeping the output', () => {
    const [trace] = providerToolTraces([
      codeUse('t1', 'bash_code_execution'),
      codeResult('t1', bash({ return_code: 127, stderr: 'not found' })),
    ]);
    expect(trace).toMatchObject({
      success: false,
      errorCode: 'exit_127',
      resultPreview: 'not found',
    });
  });

  it('uses the tool error code on an error result', () => {
    const [bashErr, editorErr] = providerToolTraces([
      codeUse('t1', 'bash_code_execution'),
      codeResult('t1', {
        type: 'bash_code_execution_tool_result_error',
        error_code: 'unavailable',
      }),
      codeUse('t2', 'text_editor_code_execution'),
      codeResult(
        't2',
        {
          type: 'text_editor_code_execution_tool_result_error',
          error_code: 'file_not_found',
          error_message: null,
        },
        { tool: 'text_editor' }
      ),
    ]);
    expect(bashErr).toMatchObject({ success: false, errorCode: 'unavailable' });
    expect(editorErr).toMatchObject({ success: false, errorCode: 'file_not_found' });
    expect(bashErr).not.toHaveProperty('resultPreview');
  });

  it('reads a run with no result as failed', () => {
    expect(providerToolTraces([codeUse('t1', 'bash_code_execution')])).toEqual([
      {
        slug: PROVIDER_CODE_EXECUTION_SLUG,
        arguments: { command: 'ls' },
        latencyMs: 0,
        success: false,
        errorCode: 'no_result',
      },
    ]);
  });

  it('does not pair a result with another call’s id', () => {
    const [trace] = providerToolTraces([
      codeUse('t1', 'bash_code_execution'),
      codeResult('other', bash({ stdout: 'x' })),
    ]);
    expect(trace.errorCode).toBe('no_result');
  });

  it('previews a text file view as its text, and a non-text one as its type', () => {
    const view = (
      file_type: 'text' | 'image' | 'pdf',
      content: string
    ): AnthropicCodeExecutionContent => ({
      type: 'text_editor_code_execution_view_result',
      content,
      file_type,
      num_lines: null,
      start_line: null,
      total_lines: null,
    });
    const traces = providerToolTraces([
      codeUse('t1', 'text_editor_code_execution', { command: 'view', path: 'a.txt' }),
      codeResult('t1', view('text', 'line one'), { tool: 'text_editor' }),
      codeUse('t2', 'text_editor_code_execution'),
      codeResult('t2', view('image', 'BINARYDATA'), { tool: 'text_editor' }),
      codeUse('t3', 'text_editor_code_execution'),
      codeResult('t3', view('pdf', 'BINARYDATA'), { tool: 'text_editor' }),
    ]);
    expect(traces.map((t) => [t.success, t.resultPreview])).toEqual([
      [true, 'line one'],
      [true, '[image]'],
      [true, '[pdf]'],
    ]);
  });

  it('reads create and str_replace results as success with no preview', () => {
    const traces = providerToolTraces([
      codeUse('t1', 'text_editor_code_execution'),
      codeResult(
        't1',
        { type: 'text_editor_code_execution_create_result', is_file_update: false },
        {
          tool: 'text_editor',
        }
      ),
      codeUse('t2', 'text_editor_code_execution'),
      codeResult(
        't2',
        {
          type: 'text_editor_code_execution_str_replace_result',
          lines: null,
          new_lines: null,
          new_start: null,
          old_lines: null,
          old_start: null,
        },
        { tool: 'text_editor' }
      ),
    ]);
    expect(traces).toHaveLength(2);
    for (const trace of traces) {
      expect(trace.success).toBe(true);
      expect(trace).not.toHaveProperty('resultPreview');
      expect(trace).not.toHaveProperty('errorCode');
    }
  });

  it('names the files a run made, marked not delivered, after its output', () => {
    const [trace] = providerToolTraces([
      codeUse('t1', 'bash_code_execution'),
      codeResult('t1', bash({ stdout: 'done' }), { fileNames: ['a.csv', 'b.png'] }),
    ]);
    expect(trace.resultPreview).toBe('done\nFiles made (not delivered): a.csv, b.png');
  });

  it('shows just the files line when the run printed nothing', () => {
    const [trace] = providerToolTraces([
      codeUse('t1', 'bash_code_execution'),
      codeResult('t1', bash({}), { fileNames: ['a.csv'] }),
    ]);
    expect(trace.resultPreview).toBe('Files made (not delivered): a.csv');
  });

  it('keeps the preview inside the trace schema’s limit', () => {
    const [trace] = providerToolTraces([
      codeUse('t1', 'bash_code_execution'),
      codeResult('t1', bash({ stdout: 'x'.repeat(5000) })),
    ]);
    expect(trace.resultPreview?.length).toBe(2000);
  });

  it('keeps a web search trace beside a code one, in the order the model ran them', () => {
    const traces = providerToolTraces([
      use('s1', 'sunrise'),
      { type: 'web_search_tool_result', toolUseId: 's1', results: [] },
      codeUse('t1', 'bash_code_execution'),
      codeResult('t1', bash({ stdout: 'ok' })),
      use('s2', 'sunset'),
    ]);
    expect(traces.map((t) => [t.slug, t.success])).toEqual([
      [PROVIDER_WEB_SEARCH_SLUG, true],
      [PROVIDER_CODE_EXECUTION_SLUG, true],
      [PROVIDER_WEB_SEARCH_SLUG, false],
    ]);
    expect(traces[0].costUsd).toBe(WEB_SEARCH_USD_PER_REQUEST);
    expect(traces[1]).not.toHaveProperty('costUsd');
  });
});

describe('providerToolTraces — OpenAI code interpreter (t-956)', () => {
  const interp = (
    over: Partial<Extract<LlmReasoningBlock, { type: 'openai_code_interpreter_call' }>> = {}
  ): LlmReasoningBlock => ({
    type: 'openai_code_interpreter_call',
    id: 'ci_1',
    status: 'completed',
    containerId: 'cntr_1',
    code: 'print(1)',
    outputs: [],
    durationMs: 800,
    ...over,
  });

  it('reads a run whose code raised as failed, from the traceback Python printed', () => {
    const [trace] = providerToolTraces([
      interp({
        outputs: [
          {
            type: 'logs',
            logs: 'Traceback (most recent call last):\n  File "<stdin>", line 1\nZeroDivisionError: division by zero',
          },
        ],
      }),
    ]);

    expect(trace).toEqual(expect.objectContaining({ success: false, errorCode: 'exception' }));
    expect(trace.resultPreview).toContain('ZeroDivisionError');
  });

  it('keeps the item’s own status as the error over a traceback', () => {
    const [trace] = providerToolTraces([
      interp({
        status: 'failed',
        outputs: [{ type: 'logs', logs: 'Traceback (most recent call last):\nError' }],
      }),
    ]);

    expect(trace).toEqual(expect.objectContaining({ success: false, errorCode: 'failed' }));
  });

  it('makes an entry with the code as arguments, the run time as latency, and logs as preview', () => {
    expect(providerToolTraces([interp({ outputs: [{ type: 'logs', logs: '1' }] })])).toEqual([
      {
        slug: PROVIDER_CODE_EXECUTION_SLUG,
        arguments: { code: 'print(1)' },
        latencyMs: 800,
        success: true,
        resultPreview: '1',
      },
    ]);
  });

  it('has empty arguments when the code is null', () => {
    const [trace] = providerToolTraces([interp({ code: null })]);
    expect(trace.arguments).toEqual({});
  });

  it('shows images as [image] among the logs, in order', () => {
    const [trace] = providerToolTraces([
      interp({
        outputs: [
          { type: 'logs', logs: 'before' },
          { type: 'image', url: 'https://x.example/i.png' },
          { type: 'logs', logs: 'after' },
        ],
      }),
    ]);
    expect(trace.resultPreview).toBe('before\n[image]\nafter');
  });

  it('reads any status but completed as failed, with the status as the error code', () => {
    const traces = providerToolTraces(
      (['in_progress', 'interpreting', 'incomplete', 'failed'] as const).map((status) =>
        interp({ status })
      )
    );
    expect(traces.map((t) => [t.success, t.errorCode])).toEqual([
      [false, 'in_progress'],
      [false, 'interpreting'],
      [false, 'incomplete'],
      [false, 'failed'],
    ]);
  });

  it('names the files made, marked not delivered', () => {
    const [trace] = providerToolTraces([
      interp({ outputs: [{ type: 'logs', logs: 'saved' }], fileNames: ['out.csv', 'chart.png'] }),
    ]);
    expect(trace.resultPreview).toBe('saved\nFiles made (not delivered): out.csv, chart.png');
  });

  it('has no preview without output or files, and never a cost', () => {
    const [trace] = providerToolTraces([interp()]);
    expect(trace).not.toHaveProperty('resultPreview');
    expect(trace).not.toHaveProperty('costUsd');
  });
});

describe('fitToolCallTraces (t-956)', () => {
  const trace = (slug: string, n: number): ToolCallTrace => ({
    slug,
    arguments: { n },
    latencyMs: 0,
    success: true,
  });

  it('leaves a list within the limit as it is', () => {
    const list = [trace('lookup', 1), trace(PROVIDER_CODE_EXECUTION_SLUG, 2)];

    expect(fitToolCallTraces(list, 2)).toBe(list);
  });

  it('drops provider runs from the end first, keeping every dispatched capability in order', () => {
    const list = [
      trace(PROVIDER_CODE_EXECUTION_SLUG, 1),
      trace('lookup', 2),
      trace(PROVIDER_CODE_EXECUTION_SLUG, 3),
      trace(PROVIDER_WEB_SEARCH_SLUG, 4),
      trace('refund', 5),
      trace(PROVIDER_CODE_EXECUTION_SLUG, 6),
    ];

    expect(fitToolCallTraces(list, 3).map((t) => t.arguments)).toEqual([
      { n: 1 },
      { n: 2 },
      { n: 5 },
    ]);
  });

  it('cuts to the first entries when the dispatched capabilities alone are too many', () => {
    const list = [1, 2, 3, 4].map((n) => trace('lookup', n));

    expect(fitToolCallTraces(list, 2).map((t) => t.arguments)).toEqual([{ n: 1 }, { n: 2 }]);
  });
});
