/**
 * Grader: json_schema.
 *
 * Passes if the subject's output, parsed as JSON, validates against
 * the configured Zod-like JSON Schema (subset). Useful for structured
 * extraction agents where the output should be valid JSON conforming
 * to a contract.
 *
 * We avoid pulling in a full JSON Schema library here — the config
 * carries a serialised Zod schema (object with field → type strings).
 * Supported types: `string`, `number`, `boolean`, `array`, `object`.
 * Fields are required unless suffixed with `?`. This keeps the grader
 * fully deterministic and dependency-free without sacrificing the
 * common case.
 */

import { z } from 'zod';
import { registerGrader } from '@/lib/orchestration/evaluations/graders/registry';
import type {
  Grader,
  GraderInput,
  GraderResult,
} from '@/lib/orchestration/evaluations/graders/types';

const FIELD_TYPE = z.enum(['string', 'number', 'boolean', 'array', 'object']);

const configSchema = z.object({
  /** Map of field name → expected type. Suffix the name with `?` for optional. */
  fields: z.record(z.string(), FIELD_TYPE),
  /** Reject extra keys not listed in `fields`. */
  strict: z.boolean().default(false),
});

type Config = z.infer<typeof configSchema>;

function checkType(value: unknown, expected: z.infer<typeof FIELD_TYPE>): boolean {
  switch (expected) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
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
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { score: 0, passed: false, reasoning: 'Output JSON is not an object.' };
  }

  const failures: string[] = [];
  const obj = parsed as Record<string, unknown>;
  for (const [rawName, type] of Object.entries(input.config.fields)) {
    const optional = rawName.endsWith('?');
    const name = optional ? rawName.slice(0, -1) : rawName;
    if (!(name in obj)) {
      if (!optional) failures.push(`missing required field "${name}"`);
      continue;
    }
    if (!checkType(obj[name], type)) {
      failures.push(`field "${name}" should be ${type}, got ${typeof obj[name]}`);
    }
  }
  if (input.config.strict) {
    const declared = new Set(
      Object.keys(input.config.fields).map((k) => (k.endsWith('?') ? k.slice(0, -1) : k))
    );
    for (const key of Object.keys(obj)) {
      if (!declared.has(key)) failures.push(`unexpected field "${key}" (strict mode)`);
    }
  }

  const pass = failures.length === 0;
  return {
    score: pass ? 1 : 0,
    passed: pass,
    reasoning: pass ? 'Output JSON matches schema.' : failures.join('; '),
  };
}

export const jsonSchemaGrader: Grader<Config> = {
  slug: 'json_schema',
  family: 'heuristic',
  referenceRequired: false,
  configSchema,
  defaultConfig: { fields: {}, strict: false },
  grade,
  description:
    'Passes if the output is JSON whose fields match the configured types (string, number, boolean, array, object). Suffix a field name with `?` to make it optional. Enable strict to reject extra keys.',
};

registerGrader(jsonSchemaGrader);
