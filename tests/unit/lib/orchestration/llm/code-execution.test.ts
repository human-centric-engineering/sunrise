/**
 * Tests for costing a reply's code execution (t-956).
 *
 * Each container is billed the larger of its measured run time and the
 * 300 s floor; a call is billed only what its runs add to each container.
 */

import { describe, expect, it } from 'vitest';

import {
  billCodeExecution,
  codeExecutionCostUsd,
  codeRunOf,
  earlierCodeRuns,
  latestContainerId,
  type CodeRun,
} from '@/lib/orchestration/llm/code-execution';
import {
  CODE_EXECUTION_MIN_BILLED_SECONDS,
  type LlmMessage,
  type LlmReasoningBlock,
} from '@/lib/orchestration/llm/types';

const run = (containerId: string, seconds: number): CodeRun => ({
  containerId,
  durationMs: seconds * 1000,
});

const anthropicRun = (containerId: string, durationMs: number): LlmReasoningBlock => ({
  type: 'code_execution_tool_result',
  tool: 'bash',
  toolUseId: 'tu',
  content: { type: 'bash_code_execution_tool_result_error', error_code: 'x' },
  containerId,
  durationMs,
});

const openAiRun = (containerId: string, durationMs: number): LlmReasoningBlock => ({
  type: 'openai_code_interpreter_call',
  id: 'ci',
  status: 'completed',
  containerId,
  code: 'print(1)',
  outputs: [],
  durationMs,
});

const assistant = (reasoning?: LlmReasoningBlock[]): LlmMessage => ({
  role: 'assistant',
  content: '',
  reasoning,
});

describe('billCodeExecution', () => {
  it('uses a 300 second floor', () => {
    expect(CODE_EXECUTION_MIN_BILLED_SECONDS).toBe(300);
  });

  it('bills a new container below the floor at 300 s', () => {
    expect(billCodeExecution([], [run('c1', 12)], 0.05)).toEqual({
      runs: 1,
      billedSeconds: 300,
      usdPerHour: 0.05,
    });
  });

  it('bills a new container above the floor at its run time', () => {
    expect(billCodeExecution([], [run('c1', 450)], 0.05)?.billedSeconds).toBe(450);
  });

  it('sums two runs in one new container before applying the floor', () => {
    // 100 + 250 = 350 s: above the floor, so not 2 x 300.
    const usage = billCodeExecution([], [run('c1', 100), run('c1', 250)], 0.05);
    expect(usage?.billedSeconds).toBe(350);
    expect(usage?.runs).toBe(2);
    // 100 + 50 = 150 s: below the floor, billed once at 300.
    expect(billCodeExecution([], [run('c1', 100), run('c1', 50)], 0.05)?.billedSeconds).toBe(300);
  });

  it('bills nothing more when an earlier run is below the floor and this one stays under it', () => {
    expect(billCodeExecution([run('c1', 100)], [run('c1', 100)], 0.05)?.billedSeconds).toBe(0);
  });

  it('bills only the excess when this call pushes the container past the floor', () => {
    // earlier 100 s, now 300 s: total 400 s; 300 s was billed, so 100 s more.
    expect(billCodeExecution([run('c1', 100)], [run('c1', 300)], 0.05)?.billedSeconds).toBe(100);
  });

  it('bills the full current time when the earlier total is already above the floor', () => {
    expect(billCodeExecution([run('c1', 400)], [run('c1', 45)], 0.05)?.billedSeconds).toBe(45);
  });

  it('counts earlier runs summed across several blocks', () => {
    // earlier 200 + 150 = 350 (billed 350); +50 = 400, so 50 more.
    expect(
      billCodeExecution([run('c1', 200), run('c1', 150)], [run('c1', 50)], 0.05)?.billedSeconds
    ).toBe(50);
  });

  it('bills a new container the floor and an earlier one only its addition, in one call', () => {
    const usage = billCodeExecution([run('old', 100)], [run('old', 300), run('new', 10)], 0.05);
    // old: 400 - 300 = 100; new: 300
    expect(usage?.billedSeconds).toBe(400);
    expect(usage?.runs).toBe(2);
  });

  it('returns undefined when the call ran no code', () => {
    expect(billCodeExecution([run('c1', 400)], [], 0.05)).toBeUndefined();
  });

  it('passes usdPerHour through', () => {
    expect(billCodeExecution([], [run('c1', 1)], 0.09)?.usdPerHour).toBe(0.09);
  });
});

describe('codeExecutionCostUsd', () => {
  it('prices billed seconds at the hourly rate', () => {
    expect(codeExecutionCostUsd({ runs: 1, billedSeconds: 1800, usdPerHour: 0.09 })).toBeCloseTo(
      0.045,
      10
    );
    expect(codeExecutionCostUsd({ runs: 1, billedSeconds: 300, usdPerHour: 0.05 })).toBeCloseTo(
      0.05 / 12,
      10
    );
  });

  it('is 0 for 0 billed seconds', () => {
    expect(codeExecutionCostUsd({ runs: 1, billedSeconds: 0, usdPerHour: 0.09 })).toBe(0);
  });
});

describe('codeRunOf', () => {
  it('reads the container and duration from an Anthropic result block', () => {
    expect(codeRunOf(anthropicRun('cA', 1234))).toEqual({ containerId: 'cA', durationMs: 1234 });
  });

  it('reads them from an OpenAI interpreter call', () => {
    expect(codeRunOf(openAiRun('cB', 99))).toEqual({ containerId: 'cB', durationMs: 99 });
  });

  it('is undefined for blocks that are not code runs', () => {
    expect(codeRunOf({ type: 'thinking', thinking: 't', signature: 's' })).toBeUndefined();
    expect(
      codeRunOf({ type: 'server_tool_use', id: 'x', name: 'bash_code_execution', input: {} })
    ).toBeUndefined();
  });
});

describe('earlierCodeRuns / latestContainerId', () => {
  const messages: LlmMessage[] = [
    { role: 'user', content: 'hi' },
    assistant([{ type: 'thinking', thinking: 't', signature: 's' }, anthropicRun('c1', 100)]),
    assistant(undefined),
    assistant([openAiRun('c2', 200), anthropicRun('c2', 300)]),
  ];

  it('collects the runs across messages, in order, skipping other blocks', () => {
    expect(earlierCodeRuns(messages)).toEqual([
      { containerId: 'c1', durationMs: 100 },
      { containerId: 'c2', durationMs: 200 },
      { containerId: 'c2', durationMs: 300 },
    ]);
  });

  it('returns the container of the latest run', () => {
    expect(latestContainerId(messages)).toBe('c2');
  });

  it('names only an Anthropic run’s container, never an OpenAI one after a fallback', () => {
    expect(
      latestContainerId([
        assistant([anthropicRun('container_1', 10)]),
        assistant([openAiRun('cntr_x', 10)]),
      ])
    ).toBe('container_1');
    expect(latestContainerId([assistant([openAiRun('cntr_x', 10)])])).toBeUndefined();
  });

  it('has none without code runs', () => {
    expect(earlierCodeRuns([{ role: 'user', content: 'x' }])).toEqual([]);
    expect(latestContainerId([{ role: 'user', content: 'x' }])).toBeUndefined();
  });
});
