/**
 * MCP Prompt Registry
 *
 * Built-in prompt templates exposed via MCP. Hardcoded for now —
 * no database model needed until the prompt set grows.
 *
 * Platform-agnostic: no Next.js imports.
 */

import type { McpPromptDefinition, McpPromptMessage } from '@/types/mcp';

interface PromptHandler {
  definition: McpPromptDefinition;
  generate: (args: Record<string, unknown>) => McpPromptMessage[];
}

const PROMPTS: Record<string, PromptHandler> = {
  'analyze-pattern': {
    definition: {
      name: 'analyze-pattern',
      description:
        'Generate a system prompt for analyzing a specific agentic design pattern from the knowledge base.',
      arguments: [
        {
          name: 'pattern_number',
          description: 'The pattern number to analyze (1-21)',
          required: true,
        },
      ],
    },
    generate(args) {
      const num = Number(args.pattern_number);
      return [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Analyze agentic design pattern #${num} from the knowledge base. Explain its purpose, when to use it, implementation considerations, and how it compares to related patterns. Use the search_knowledge_base tool to retrieve the pattern details first.`,
          },
        },
      ];
    },
  },
  'search-knowledge': {
    definition: {
      name: 'search-knowledge',
      description:
        'Generate a structured search prompt for querying the knowledge base with context.',
      arguments: [
        {
          name: 'query',
          description: 'The search query',
          required: true,
        },
        {
          name: 'context',
          description: 'Additional context for the search',
          required: false,
        },
      ],
    },
    generate(args) {
      const query = typeof args.query === 'string' ? args.query : '';
      const context = typeof args.context === 'string' ? args.context : '';
      const contextClause = context ? ` Context: ${context}.` : '';

      return [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Search the knowledge base for: "${query}".${contextClause} Use the search_knowledge_base tool to find relevant information, then summarize the most relevant results.`,
          },
        },
      ];
    },
  },
};

export function listMcpPrompts(): McpPromptDefinition[] {
  return Object.values(PROMPTS).map((p) => p.definition);
}

export function getMcpPrompt(
  name: string,
  args: Record<string, unknown>
): McpPromptMessage[] | null {
  const handler = PROMPTS[name];
  if (!handler) return null;
  return handler.generate(args);
}
