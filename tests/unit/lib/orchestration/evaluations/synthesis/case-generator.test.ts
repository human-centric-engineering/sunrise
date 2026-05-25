/**
 * Unit tests for the synthetic case generator.
 *
 * Coverage:
 * - count below 1 or above 25 is rejected
 * - KB mode throws when no chunks are available for the agent
 * - failure_mining mode throws when no failures exist
 * - drainStreamChat error propagates as ValidationError
 * - Malformed JSON envelope propagates as ValidationError
 * - Happy path tags every case with source=synthetic + metadata
 * - costLogMetadata role=generator is threaded through to drainStreamChat
 *
 * @see lib/orchestration/evaluations/synthesis/case-generator.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/orchestration/evaluations/drain-stream-chat', () => ({
  drainStreamChat: vi.fn(),
}));

vi.mock('@/lib/orchestration/evaluations/synthesis/seed-loader', () => ({
  loadKbSeed: vi.fn(),
  loadFailureSeed: vi.fn(),
}));

import { drainStreamChat } from '@/lib/orchestration/evaluations/drain-stream-chat';
import { loadKbSeed, loadFailureSeed } from '@/lib/orchestration/evaluations/synthesis/seed-loader';
import { generateCases } from '@/lib/orchestration/evaluations/synthesis/case-generator';

const mockedDrain = vi.mocked(drainStreamChat);
const mockedKbSeed = vi.mocked(loadKbSeed);
const mockedFailureSeed = vi.mocked(loadFailureSeed);

function drainOk(assistantText: string, overrides: Record<string, unknown> = {}) {
  return {
    assistantText,
    citations: [],
    toolCalls: [],
    tokenUsage: { input: 100, output: 50 },
    costUsd: 0.003,
    latencyMs: 120,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateCases — validation', () => {
  it('rejects count below 1', async () => {
    await expect(
      generateCases({ agentId: 'a', userId: 'u', mode: 'kb', count: 0 })
    ).rejects.toThrow(/between 1 and 25/);
  });

  it('rejects count above 25', async () => {
    await expect(
      generateCases({ agentId: 'a', userId: 'u', mode: 'kb', count: 26 })
    ).rejects.toThrow(/between 1 and 25/);
  });
});

describe('generateCases — KB mode', () => {
  it('throws when no chunks are accessible for the agent', async () => {
    mockedKbSeed.mockResolvedValue([]);

    await expect(
      generateCases({ agentId: 'a', userId: 'u', mode: 'kb', count: 5 })
    ).rejects.toThrow(/grant the agent access/i);
    expect(mockedDrain).not.toHaveBeenCalled();
  });

  it('happy path: tags every case with source=synthetic + generator metadata', async () => {
    mockedKbSeed.mockResolvedValue([
      {
        documentId: 'd1',
        documentName: 'Policy',
        chunkType: 'overview',
        content: 'Refunds within 30 days.',
      },
    ]);
    mockedDrain.mockResolvedValue(
      drainOk(
        JSON.stringify({
          cases: [
            {
              input: 'What is the refund window?',
              expectedOutput: '30 days [1].',
              metadata: { rationale: 'covers the chunk', seedSource: 'kb' },
            },
          ],
        })
      )
    );

    const result = await generateCases({
      agentId: 'a',
      userId: 'u',
      mode: 'kb',
      count: 1,
      topic: 'refunds',
    });

    expect(result.cases).toHaveLength(1);
    expect(result.cases[0].metadata).toMatchObject({
      source: 'synthetic',
      mode: 'kb',
      generatorAgentSlug: 'eval-case-generator',
      rationale: 'covers the chunk',
    });
    expect(result.cases[0].metadata.generatedAt).toMatch(/T/); // ISO string
    expect(result.costUsd).toBe(0.003);
  });

  it('threads costLogMetadata.role=generator to drainStreamChat', async () => {
    mockedKbSeed.mockResolvedValue([
      { documentId: 'd1', documentName: 'X', chunkType: 't', content: 'C' },
    ]);
    mockedDrain.mockResolvedValue(
      drainOk(JSON.stringify({ cases: [{ input: 'q', expectedOutput: 'a' }] }))
    );

    await generateCases({ agentId: 'a', userId: 'u', mode: 'kb', count: 1 });

    const call = mockedDrain.mock.calls[0][0] as { costLogMetadata: Record<string, unknown> };
    expect(call.costLogMetadata).toEqual({
      role: 'generator',
      agentSlug: 'eval-case-generator',
      mode: 'kb',
    });
  });
});

describe('generateCases — failure_mining mode', () => {
  it('throws when no low-scoring prior cases exist', async () => {
    mockedFailureSeed.mockResolvedValue([]);

    await expect(
      generateCases({ agentId: 'a', userId: 'u', mode: 'failure_mining', count: 5 })
    ).rejects.toThrow(/run an evaluation that produces failures/i);
  });

  it('happy path passes failure seeds to the generator and tags mode=failure_mining', async () => {
    mockedFailureSeed.mockResolvedValue([
      {
        caseId: 'c1',
        input: 'easy q',
        expectedOutput: 'easy a',
        score: 0.3,
        reasoning: 'missed citation',
      },
    ]);
    mockedDrain.mockResolvedValue(
      drainOk(JSON.stringify({ cases: [{ input: 'harder q', expectedOutput: 'precise a' }] }))
    );

    const result = await generateCases({
      agentId: 'a',
      userId: 'u',
      mode: 'failure_mining',
      count: 1,
    });

    expect(result.cases[0].metadata).toMatchObject({
      source: 'synthetic',
      mode: 'failure_mining',
    });
    const promptArg = (mockedDrain.mock.calls[0][0] as { message: string }).message;
    expect(promptArg).toContain('SEED_SOURCE: failure_mining');
    expect(promptArg).toContain('easy q');
    expect(promptArg).toContain('missed citation');
  });
});

describe('generateCases — error paths', () => {
  beforeEach(() => {
    mockedKbSeed.mockResolvedValue([
      { documentId: 'd1', documentName: 'X', chunkType: 't', content: 'C' },
    ]);
  });

  it('surfaces drainStreamChat errors as ValidationError', async () => {
    mockedDrain.mockResolvedValue(
      drainOk('', { errorCode: 'PROVIDER_DOWN', errorMessage: 'down' })
    );

    await expect(
      generateCases({ agentId: 'a', userId: 'u', mode: 'kb', count: 1 })
    ).rejects.toThrow(/case_generator stream error: PROVIDER_DOWN/);
  });

  it('rejects a malformed JSON envelope', async () => {
    mockedDrain.mockResolvedValue(drainOk('not json {{{'));

    await expect(
      generateCases({ agentId: 'a', userId: 'u', mode: 'kb', count: 1 })
    ).rejects.toThrow(/malformed response/i);
  });

  it('rejects responses with the wrong schema (no cases array)', async () => {
    mockedDrain.mockResolvedValue(drainOk(JSON.stringify({ proposals: [] })));

    await expect(
      generateCases({ agentId: 'a', userId: 'u', mode: 'kb', count: 1 })
    ).rejects.toThrow(/malformed response/i);
  });
});
