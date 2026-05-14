import { describe, it, expect } from 'vitest';

import {
  countOpenAiToolDefinitionTokens,
  formatToolsForOpenAi,
  isOpenAiModel,
} from '@/lib/orchestration/chat/openai-token-counter';
import type { LlmToolDefinition } from '@/lib/orchestration/llm/types';

describe('formatToolsForOpenAi', () => {
  it('renders a tool with no parameters as a zero-arg function', () => {
    const tools: LlmToolDefinition[] = [
      { name: 'ping', description: 'Health check', parameters: {} },
    ];
    const out = formatToolsForOpenAi(tools);
    expect(out).toContain('namespace functions {');
    expect(out).toContain('// Health check');
    expect(out).toContain('type ping = () => any;');
    expect(out).toContain('} // namespace functions');
  });

  it('renders an object schema as a typed parameter destructure', () => {
    const tools: LlmToolDefinition[] = [
      {
        name: 'search_kb',
        description: 'Search the knowledge base',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What to look for' },
            limit: { type: 'integer', description: 'Max results' },
          },
          required: ['query'],
        },
      },
    ];
    const out = formatToolsForOpenAi(tools);
    expect(out).toContain('// What to look for');
    expect(out).toContain('query: string,');
    // `limit` is optional → trailing `?`
    expect(out).toContain('limit?: number,');
    expect(out).toContain('type search_kb = (_: {');
  });

  it('renders enum values as a TS union of string literals', () => {
    const tools: LlmToolDefinition[] = [
      {
        name: 'set_status',
        description: 'Update status',
        parameters: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['open', 'closed', 'pending'] },
          },
          required: ['status'],
        },
      },
    ];
    const out = formatToolsForOpenAi(tools);
    expect(out).toContain('status: "open" | "closed" | "pending",');
  });

  it('renders array<object> recursively', () => {
    const tools: LlmToolDefinition[] = [
      {
        name: 'bulk_tag',
        description: 'Tag many things',
        parameters: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  tag: { type: 'string' },
                },
                required: ['id'],
              },
            },
          },
          required: ['items'],
        },
      },
    ];
    const out = formatToolsForOpenAi(tools);
    expect(out).toContain('items: {');
    expect(out).toContain('id: string,');
    expect(out).toContain('tag?: string,');
    expect(out).toContain('}[],');
  });

  it('returns an empty string when no tools are supplied', () => {
    expect(formatToolsForOpenAi([])).toBe('');
  });

  it('renders boolean and null primitives correctly', () => {
    const tools: LlmToolDefinition[] = [
      {
        name: 'toggle',
        description: 'Toggle something',
        parameters: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            nothing: { type: 'null' },
          },
          required: ['enabled'],
        },
      },
    ];
    const out = formatToolsForOpenAi(tools);
    expect(out).toContain('enabled: boolean,');
    expect(out).toContain('nothing?: null,');
  });

  it('renders anyOf and oneOf as a TS union', () => {
    const tools: LlmToolDefinition[] = [
      {
        name: 'pick',
        description: 'Pick a value',
        parameters: {
          type: 'object',
          properties: {
            value: { anyOf: [{ type: 'string' }, { type: 'number' }] },
            choice: { oneOf: [{ type: 'boolean' }, { type: 'null' }] },
          },
          required: ['value'],
        },
      },
    ];
    const out = formatToolsForOpenAi(tools);
    expect(out).toContain('value: string | number,');
    expect(out).toContain('choice?: boolean | null,');
  });

  it('emits the zero-arg form when the tool has a parameters object with no properties', () => {
    const tools: LlmToolDefinition[] = [
      { name: 'now', description: 'Current time', parameters: { type: 'object', properties: {} } },
    ];
    const out = formatToolsForOpenAi(tools);
    expect(out).toContain('type now = () => any;');
  });

  it('omits the description comment when the tool has none', () => {
    const tools: LlmToolDefinition[] = [{ name: 'noop', description: '', parameters: {} }];
    const out = formatToolsForOpenAi(tools);
    expect(out).not.toMatch(/^\s*\/\/\s*$/m);
    expect(out).toContain('type noop = () => any;');
  });

  it('falls back to `any` for null/non-object schemas and unknown types', () => {
    // Indirectly exercised through formatToolsForOpenAi — a property whose
    // schema is a non-object (e.g. accidentally a string) renders as `any`.
    const tools: LlmToolDefinition[] = [
      {
        name: 'odd',
        description: '',
        parameters: {
          type: 'object',
          properties: {
            a: null as unknown as Record<string, unknown>,
            b: { type: 'mystery-type' as unknown as 'string' },
          },
          required: [],
        },
      },
    ];
    const out = formatToolsForOpenAi(tools);
    expect(out).toContain('a?: any,');
    expect(out).toContain('b?: any,');
  });
});

describe('countOpenAiToolDefinitionTokens', () => {
  it('returns 0 tokens and empty body for no tools', () => {
    const { tokens, formatted } = countOpenAiToolDefinitionTokens([], 'gpt-4o');
    expect(tokens).toBe(0);
    expect(formatted).toBe('');
  });

  it('produces a positive token count proportional to schema size', () => {
    const small: LlmToolDefinition[] = [{ name: 'a', description: 'tiny', parameters: {} }];
    const big: LlmToolDefinition[] = [
      {
        name: 'a',
        description: 'a fairly verbose description that mentions many things in detail',
        parameters: {
          type: 'object',
          properties: {
            one: { type: 'string', description: 'first parameter' },
            two: { type: 'string', description: 'second parameter' },
            three: { type: 'string', description: 'third parameter' },
            four: { type: 'string', description: 'fourth parameter' },
          },
          required: ['one', 'two'],
        },
      },
    ];
    const a = countOpenAiToolDefinitionTokens(small, 'gpt-4o').tokens;
    const b = countOpenAiToolDefinitionTokens(big, 'gpt-4o').tokens;
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a * 2);
  });

  it('counts more for o200k models than cl100k on identical inputs is within a small delta', () => {
    // Different encoders, same inputs — both should be in the same
    // order of magnitude; the choice of encoder shouldn't 10× the count.
    const tools: LlmToolDefinition[] = [
      {
        name: 'search',
        description: 'Search docs',
        parameters: {
          type: 'object',
          properties: { q: { type: 'string' } },
          required: ['q'],
        },
      },
    ];
    const modern = countOpenAiToolDefinitionTokens(tools, 'gpt-4o').tokens;
    const legacy = countOpenAiToolDefinitionTokens(tools, 'gpt-4').tokens;
    expect(Math.abs(modern - legacy)).toBeLessThan(modern); // never more than 100% drift
  });
});

describe('isOpenAiModel', () => {
  it.each([
    ['gpt-4o', true],
    ['gpt-4o-mini', true],
    ['gpt-4', true],
    ['gpt-4-turbo', true],
    ['gpt-3.5-turbo', true],
    ['o1', true],
    ['o1-preview', true],
    ['o3-mini', true],
    ['claude-sonnet-4-5', false],
    ['gemini-2.0-pro', false],
    ['llama-3.1-70b', false],
    ['', false],
    [null, false],
    [undefined, false],
  ])('isOpenAiModel(%p) === %p', (id, expected) => {
    expect(isOpenAiModel(id)).toBe(expected);
  });
});
