import { describe, it, expect } from 'vitest';

import { listMcpPrompts, getMcpPrompt } from '@/lib/orchestration/mcp/prompt-registry';

describe('listMcpPrompts', () => {
  it('returns exactly 2 prompts', () => {
    expect(listMcpPrompts()).toHaveLength(2);
  });

  it('includes analyze-pattern prompt', () => {
    const prompts = listMcpPrompts();
    expect(prompts.some((p) => p.name === 'analyze-pattern')).toBe(true);
  });

  it('includes search-knowledge prompt', () => {
    const prompts = listMcpPrompts();
    expect(prompts.some((p) => p.name === 'search-knowledge')).toBe(true);
  });

  it('each prompt has name and description', () => {
    for (const prompt of listMcpPrompts()) {
      expect(typeof prompt.name).toBe('string');
      expect(typeof prompt.description).toBe('string');
    }
  });

  it('analyze-pattern has a required pattern_number argument', () => {
    const prompt = listMcpPrompts().find((p) => p.name === 'analyze-pattern');
    const arg = prompt?.arguments?.find((a) => a.name === 'pattern_number');
    // test-review:accept tobe_true — boolean schema field `required`; structural assertion on MCP prompt argument definition
    expect(arg?.required).toBe(true);
  });

  it('search-knowledge has a required query argument', () => {
    const prompt = listMcpPrompts().find((p) => p.name === 'search-knowledge');
    const arg = prompt?.arguments?.find((a) => a.name === 'query');
    // test-review:accept tobe_true — boolean schema field `required`; structural assertion on MCP prompt argument definition
    expect(arg?.required).toBe(true);
  });

  it('search-knowledge has an optional context argument', () => {
    const prompt = listMcpPrompts().find((p) => p.name === 'search-knowledge');
    const arg = prompt?.arguments?.find((a) => a.name === 'context');
    expect(arg?.required).toBeFalsy();
  });
});

describe('getMcpPrompt', () => {
  describe('unknown prompt', () => {
    it('returns null for an unknown prompt name', () => {
      expect(getMcpPrompt('nonexistent', {})).toBeNull();
    });

    it('returns null for an empty string name', () => {
      expect(getMcpPrompt('', {})).toBeNull();
    });
  });

  describe('analyze-pattern', () => {
    it('returns an array of messages', () => {
      const messages = getMcpPrompt('analyze-pattern', { pattern_number: 7 });
      expect(Array.isArray(messages)).toBe(true);
      expect(messages!.length).toBeGreaterThan(0);
    });

    it('message has user role', () => {
      const messages = getMcpPrompt('analyze-pattern', { pattern_number: 3 });
      expect(messages![0].role).toBe('user');
    });

    it('message content is of type text', () => {
      const messages = getMcpPrompt('analyze-pattern', { pattern_number: 3 });
      expect(messages![0].content.type).toBe('text');
    });

    it('message text includes the pattern number', () => {
      const messages = getMcpPrompt('analyze-pattern', { pattern_number: 5 });
      expect(messages![0].content.text).toContain('5');
    });

    it('converts pattern_number to a number', () => {
      const messages = getMcpPrompt('analyze-pattern', { pattern_number: '12' });
      expect(messages![0].content.text).toContain('12');
    });

    it('returns error for pattern_number above 21', () => {
      const messages = getMcpPrompt('analyze-pattern', { pattern_number: 22 });
      expect(messages![0].content.text).toContain('Invalid');
    });

    it('returns error for pattern_number of 0', () => {
      const messages = getMcpPrompt('analyze-pattern', { pattern_number: 0 });
      expect(messages![0].content.text).toContain('Invalid');
    });

    it('returns error for non-integer pattern_number', () => {
      const messages = getMcpPrompt('analyze-pattern', { pattern_number: 3.5 });
      expect(messages![0].content.text).toContain('Invalid');
    });

    it('returns error for undefined pattern_number', () => {
      const messages = getMcpPrompt('analyze-pattern', {});
      expect(messages![0].content.text).toContain('Invalid');
    });
  });

  describe('search-knowledge', () => {
    it('returns an array of messages', () => {
      const messages = getMcpPrompt('search-knowledge', { query: 'agent patterns' });
      expect(Array.isArray(messages)).toBe(true);
      expect(messages!.length).toBeGreaterThan(0);
    });

    it('message has user role', () => {
      const messages = getMcpPrompt('search-knowledge', { query: 'test' });
      expect(messages![0].role).toBe('user');
    });

    it('message text includes the query', () => {
      const messages = getMcpPrompt('search-knowledge', { query: 'orchestration patterns' });
      expect(messages![0].content.text).toContain('orchestration patterns');
    });

    it('includes context in message text when provided', () => {
      const messages = getMcpPrompt('search-knowledge', {
        query: 'retry strategies',
        context: 'resilience',
      });
      expect(messages![0].content.text).toContain('resilience');
    });

    it('does not include context clause when context is absent', () => {
      const messages = getMcpPrompt('search-knowledge', { query: 'retry strategies' });
      expect(messages![0].content.text).not.toContain('Context:');
    });

    it('does not include context clause when context is not a string', () => {
      const messages = getMcpPrompt('search-knowledge', { query: 'test', context: 42 });
      expect(messages![0].content.text).not.toContain('Context:');
    });

    it('treats non-string query as empty string', () => {
      const messages = getMcpPrompt('search-knowledge', { query: null });
      expect(messages![0].content.text).toContain('""');
    });
  });
});
