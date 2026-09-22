/**
 * MCP Prompt Registry
 *
 * Loads prompts from the `McpExposedPrompt` table on demand, caches the
 * enabled set for 5 minutes (matching the resource registry pattern), and
 * renders templates with a deliberately tiny substitution-only engine.
 *
 * Why a custom mini-engine and not Handlebars / Mustache:
 *  - **Safety**: only argument names declared in `argumentsSpec` are ever
 *    interpolated. `{{database_url}}` is rendered literally, not evaluated,
 *    so an admin cannot accidentally (or maliciously) leak server state.
 *  - **Predictability**: no helpers, no partials, no lambdas, no inverted
 *    sections — what you see in the template is exactly what the client
 *    gets, with substitution.
 *  - **No dependency** for ~30 lines of logic.
 *
 * The legacy hardcoded prompts (`analyze-pattern`, `search-knowledge`) are
 * kept as a fallback so a fresh database still works during the rollout —
 * once the Phase 2 seed has run everywhere, the LEGACY_BUILT_INS map can be
 * removed in a future cleanup.
 *
 * Platform-agnostic: no Next.js imports.
 *
 * Tenancy posture: global-config — McpExposedPrompt has no org
 * (lib/tenancy/process-state.ts).
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import type { McpPromptDefinition, McpPromptMessage } from '@/types/mcp';
import type { McpPromptArgumentSpec } from '@/lib/validations/mcp';

/** Max rendered output per `prompts/get` call. Anything bigger is rejected. */
const MAX_RENDERED_BYTES = 64 * 1024;

/** Max enabled prompts allowed in the system at once. Enforced at admin POST. */
export const MAX_ENABLED_PROMPTS = 200;

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedPromptRow {
  name: string;
  description: string;
  template: string;
  argumentsSpec: McpPromptArgumentSpec[];
}

let cachedPrompts: CachedPromptRow[] | null = null;
let cachedAt = 0;

async function loadPrompts(): Promise<CachedPromptRow[]> {
  const now = Date.now();
  if (cachedPrompts && now - cachedAt < CACHE_TTL_MS) {
    return cachedPrompts;
  }
  const rows = await prisma.mcpExposedPrompt.findMany({
    where: { isEnabled: true },
    orderBy: { name: 'asc' },
  });
  cachedPrompts = rows.map((r) => ({
    name: r.name,
    description: r.description,
    template: r.template,
    // argumentsSpec is stored as JSON; we trust admin write-side validation
    // and narrow defensively here.
    argumentsSpec: normaliseArgumentsSpec(r.argumentsSpec),
  }));
  cachedAt = now;
  return cachedPrompts;
}

function normaliseArgumentsSpec(value: unknown): McpPromptArgumentSpec[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (a): a is McpPromptArgumentSpec =>
      typeof a === 'object' &&
      a !== null &&
      typeof (a as { name?: unknown }).name === 'string' &&
      typeof (a as { description?: unknown }).description === 'string'
  );
}

/** Clear the in-process cache. Called after admin mutations. */
export function clearMcpPromptCache(): void {
  cachedPrompts = null;
  cachedAt = 0;
}

/** For tests: assert no DB row exists. */
export async function listMcpPrompts(): Promise<McpPromptDefinition[]> {
  const dbRows = await loadPrompts();
  const defs: McpPromptDefinition[] = dbRows.map((r) => ({
    name: r.name,
    description: r.description,
    arguments: r.argumentsSpec.map((a) => ({
      name: a.name,
      description: a.description,
      required: a.required,
    })),
  }));

  // Surface any legacy built-ins that the DB doesn't already define. This
  // keeps fresh installations functional before the seed runs.
  const dbNames = new Set(dbRows.map((r) => r.name));
  for (const [name, builtin] of Object.entries(LEGACY_BUILT_INS)) {
    if (!dbNames.has(name)) {
      defs.push(builtin.definition);
    }
  }

  return defs;
}

/**
 * Render a prompt by name with the given arguments.
 *
 * Returns `null` when the prompt does not exist. Throws `RangeError` when
 * the rendered output exceeds `MAX_RENDERED_BYTES` so the protocol handler
 * can map it to `INVALID_PARAMS`. Missing required arguments also throw a
 * `RangeError` for the same reason.
 */
export async function getMcpPrompt(
  name: string,
  args: Record<string, unknown>
): Promise<McpPromptMessage[] | null> {
  const dbRows = await loadPrompts();
  const dbRow = dbRows.find((r) => r.name === name);

  if (dbRow) {
    return renderDbPrompt(dbRow, args);
  }

  // Fallback to a legacy built-in if the DB doesn't have this name yet.
  const builtin = LEGACY_BUILT_INS[name];
  if (builtin) {
    return builtin.generate(args);
  }

  return null;
}

function renderDbPrompt(row: CachedPromptRow, args: Record<string, unknown>): McpPromptMessage[] {
  // Validate required args first so the client gets a precise error instead
  // of a half-rendered template.
  const missing = row.argumentsSpec
    .filter((a) => a.required && (args[a.name] === undefined || args[a.name] === null))
    .map((a) => a.name);
  if (missing.length > 0) {
    throw new RangeError(`Missing required argument(s): ${missing.join(', ')}`);
  }

  const allowed = new Set(row.argumentsSpec.map((a) => a.name));
  const text = renderTemplate(row.template, args, allowed);

  if (Buffer.byteLength(text, 'utf8') > MAX_RENDERED_BYTES) {
    throw new RangeError(
      `Rendered prompt exceeds the ${MAX_RENDERED_BYTES}-byte limit. Reduce template size or argument lengths.`
    );
  }

  return [
    {
      role: 'user',
      content: { type: 'text', text },
    },
  ];
}

/**
 * Substitute `{{var}}` occurrences with values from `args`, but ONLY for
 * variable names listed in `allowed`. Unknown placeholders render literally
 * — this is the security boundary that prevents `{{database_url}}` style
 * accidents.
 *
 * Whitespace around the variable name is tolerated so admins can write
 * `{{ name }}` if they prefer.
 */
function renderTemplate(
  template: string,
  args: Record<string, unknown>,
  allowed: Set<string>
): string {
  return template.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi, (full, rawName: string) => {
    const name = rawName.toLowerCase();
    if (!allowed.has(name)) {
      return full; // render literally — not in the allow-list
    }
    const value = args[name];
    if (value === undefined || value === null) {
      return '';
    }
    // Stringify primitives directly; serialise objects/arrays as JSON so
    // admins don't accidentally get '[object Object]' in client output.
    if (typeof value === 'object') {
      return JSON.stringify(value);
    }
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- value is a primitive
    return String(value);
  });
}

// ============================================================================
// Legacy hardcoded prompts (fallback for fresh installs pre-seed)
// ============================================================================

interface LegacyBuiltin {
  definition: McpPromptDefinition;
  generate: (args: Record<string, unknown>) => McpPromptMessage[];
}

const LEGACY_BUILT_INS: Record<string, LegacyBuiltin> = {
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
      if (!Number.isInteger(num) || num < 1 || num > 21) {
        logger.warn('MCP legacy prompt: invalid pattern_number', { value: args.pattern_number });
        return [
          {
            role: 'user',
            content: {
              type: 'text',
              text: 'Invalid pattern_number: must be an integer between 1 and 21.',
            },
          },
        ];
      }
      return [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Analyze agentic design pattern #${String(num)} from the knowledge base. Explain its purpose, when to use it, implementation considerations, and how it compares to related patterns. Use the search_knowledge_base tool to retrieve the pattern details first.`,
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
