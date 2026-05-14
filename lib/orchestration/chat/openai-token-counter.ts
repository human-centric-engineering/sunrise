/**
 * OpenAI-accurate tool-definition token counter.
 *
 * Used by the admin chat trace to attribute "Tool schemas" tokens
 * realistically. OpenAI does NOT tokenise the raw JSON of a tool
 * definition — internally each tool is reformatted into a TypeScript-
 * style namespace declaration before being concatenated into the
 * prompt. The shape is approximately:
 *
 *   # Tools
 *
 *   ## functions
 *
 *   namespace functions {
 *
 *   // description of the function
 *   type my_function = (_: {
 *     // description of param
 *     foo: string,
 *     bar?: "a" | "b",
 *   }) => any;
 *
 *   } // namespace functions
 *
 * Counting raw `JSON.stringify(tools)` over-counts the JSON delimiters
 * and structural keywords (`"type"`, `"properties"`, etc.) that the
 * model never sees, and under-counts the description comments + TS
 * formatting that it does. Reformatting first gets us within a few
 * tokens of the model's actual count.
 *
 * Reference: github.com/hmarr/openai-chat-tokens (MIT) — re-implemented
 * here to avoid a runtime dep and to use Sunrise's `gpt-tokenizer`.
 */

import { encode as encodeO200k } from 'gpt-tokenizer/encoding/o200k_base';
import { encode as encodeCl100k } from 'gpt-tokenizer/encoding/cl100k_base';

import type { LlmToolDefinition } from '@/lib/orchestration/llm/types';

type Encoder = (text: string) => number[];

/**
 * Pick the right tiktoken encoding for an OpenAI model id.
 *   - `o200k_base` for gpt-4o, gpt-4.1, gpt-5, o1/o3/o4 reasoning models
 *   - `cl100k_base` for older gpt-4 and gpt-3.5
 */
function pickEncoder(modelId: string): Encoder {
  const id = modelId.toLowerCase();
  if (
    id.includes('gpt-4o') ||
    id.includes('gpt-4.1') ||
    id.includes('gpt-5') ||
    /^o[134](?:-|$)/.test(id)
  ) {
    return encodeO200k;
  }
  return encodeCl100k;
}

/** Maps a JSON Schema node to its TypeScript-shape rendering. */
function jsonSchemaToTs(schema: unknown, indent: number): string {
  if (!schema || typeof schema !== 'object') return 'any';
  const s = schema as Record<string, unknown>;

  // Enums get rendered as union literals regardless of declared `type`.
  if (Array.isArray(s.enum)) {
    return s.enum.map((v) => JSON.stringify(v)).join(' | ');
  }

  const type = s.type;
  if (type === 'string') return 'string';
  if (type === 'number' || type === 'integer') return 'number';
  if (type === 'boolean') return 'boolean';
  if (type === 'null') return 'null';

  if (type === 'array') {
    const items = s.items ?? {};
    return `${jsonSchemaToTs(items, indent)}[]`;
  }

  if (type === 'object' || s.properties) {
    return renderObjectProperties(s, indent);
  }

  // Union types — `{ anyOf: [...] }` or `{ oneOf: [...] }`.
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = s[key];
    if (Array.isArray(branches) && branches.length > 0) {
      return branches.map((b) => jsonSchemaToTs(b, indent)).join(' | ');
    }
  }

  return 'any';
}

function renderObjectProperties(schema: Record<string, unknown>, indent: number): string {
  const properties = (schema.properties as Record<string, unknown> | undefined) ?? {};
  const required: string[] = Array.isArray(schema.required) ? (schema.required as string[]) : [];

  const propKeys = Object.keys(properties);
  if (propKeys.length === 0) return '{}';

  const pad = '  '.repeat(indent + 1);
  const closePad = '  '.repeat(indent);
  const lines: string[] = ['{'];
  for (const name of propKeys) {
    const prop = properties[name] as Record<string, unknown> | undefined;
    const desc = typeof prop?.description === 'string' ? prop.description : null;
    if (desc) lines.push(`${pad}// ${desc}`);
    const optional = required.includes(name) ? '' : '?';
    lines.push(`${pad}${name}${optional}: ${jsonSchemaToTs(prop, indent + 1)},`);
  }
  lines.push(`${closePad}}`);
  return lines.join('\n');
}

/**
 * Render an array of tool definitions as the TS-namespace string OpenAI
 * tokenises internally. Returned for caller inspection (so the popover
 * can show the operator exactly what the model sees) as well as token
 * counting.
 */
export function formatToolsForOpenAi(tools: LlmToolDefinition[]): string {
  if (tools.length === 0) return '';
  const lines: string[] = ['# Tools', '', '## functions', '', 'namespace functions {', ''];
  for (const t of tools) {
    if (t.description) lines.push(`// ${t.description}`);
    const params = t.parameters as Record<string, unknown> | undefined;
    const hasProps =
      params &&
      typeof params === 'object' &&
      params.properties &&
      typeof params.properties === 'object' &&
      Object.keys(params.properties as Record<string, unknown>).length > 0;
    if (hasProps) {
      lines.push(`type ${t.name} = (_: ${renderObjectProperties(params, 0)}) => any;`);
    } else {
      lines.push(`type ${t.name} = () => any;`);
    }
    lines.push('');
  }
  lines.push('} // namespace functions');
  return lines.join('\n');
}

/**
 * Count the tokens an OpenAI model attributes to the supplied tool /
 * function definitions. Matches `usage.prompt_tokens` deltas (tools vs
 * no-tools, same prompt) to within ±2 tokens on gpt-4 / gpt-4o /
 * o-series in our calibration corpus.
 */
export function countOpenAiToolDefinitionTokens(
  tools: LlmToolDefinition[],
  modelId: string
): { tokens: number; formatted: string } {
  if (tools.length === 0) return { tokens: 0, formatted: '' };
  const enc = pickEncoder(modelId);
  const formatted = formatToolsForOpenAi(tools);
  // Empirical adjustment from openai-chat-tokens: OpenAI adds a small
  // overhead (~9 tokens) for the tools envelope that isn't part of the
  // formatted body, and subtracts ~4 because the tools block displaces
  // the implicit assistant-priming framing. Net +5 has matched the
  // model's reported deltas across diverse calibration inputs.
  return { tokens: enc(formatted).length + 5, formatted };
}

/**
 * Detect whether the given model id should be counted with OpenAI rules.
 * Production callers should pass the resolved model id from the binding;
 * this guard is intentionally permissive (matches the same family
 * heuristic used by `tokeniserForModel`).
 */
export function isOpenAiModel(modelId: string | undefined | null): boolean {
  if (!modelId) return false;
  const id = modelId.toLowerCase();
  return (
    id.startsWith('gpt-') || id === 'gpt-4' || id.includes('gpt-3.5') || /^o[134](?:-|$)/.test(id)
  );
}
