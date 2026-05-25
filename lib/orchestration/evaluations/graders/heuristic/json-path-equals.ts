/**
 * Grader: json_path_equals.
 *
 * Passes if the value at a dotted JSON path inside the parsed output
 * equals the configured expected value. Useful for structured-extraction
 * tests where only a single field matters.
 *
 *   path:  "user.email"
 *   value: "alice@example.com"
 *
 * Array index syntax is supported via `[N]`, e.g. `items[0].sku`. No
 * wildcards, no filters — keep it simple and deterministic.
 */

import { z } from 'zod';
import { registerGrader } from '@/lib/orchestration/evaluations/graders/registry';
import type {
  Grader,
  GraderInput,
  GraderResult,
} from '@/lib/orchestration/evaluations/graders/types';

const configSchema = z.object({
  path: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
});

type Config = z.infer<typeof configSchema>;

function readPath(root: unknown, path: string): unknown {
  // Normalise "a.b[0].c" → ["a", "b", "0", "c"]
  const parts: string[] = [];
  for (const segment of path.split('.')) {
    const match = segment.match(/^([^[\]]+)((?:\[\d+\])*)$/);
    if (!match) return undefined;
    parts.push(match[1]);
    const indices = match[2].match(/\[(\d+)\]/g);
    if (indices) for (const idx of indices) parts.push(idx.slice(1, -1));
  }
  let cur: unknown = root;
  for (const key of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const n = Number(key);
      if (!Number.isInteger(n)) return undefined;
      cur = cur[n];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return cur;
}

// Async signature required by the Grader interface; this body is sync.
// eslint-disable-next-line @typescript-eslint/require-await
async function grade(input: GraderInput & { config: Config }): Promise<GraderResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.modelOutput);
  } catch {
    return { score: 0, passed: false, reasoning: 'Output is not valid JSON.' };
  }
  const actual = readPath(parsed, input.config.path);
  const match = actual === input.config.value;
  return {
    score: match ? 1 : 0,
    passed: match,
    reasoning: match
      ? `Path "${input.config.path}" equals expected value.`
      : `Path "${input.config.path}" = ${JSON.stringify(actual)}, expected ${JSON.stringify(input.config.value)}.`,
  };
}

export const jsonPathEqualsGrader: Grader<Config> = {
  slug: 'json_path_equals',
  family: 'heuristic',
  referenceRequired: false,
  configSchema,
  defaultConfig: { path: '', value: '' },
  grade,
  description:
    'Passes if the value at a dotted JSON path equals the expected value. Array indices are written as `[N]`. Example path: `items[0].sku`.',
};

registerGrader(jsonPathEqualsGrader);
